import {
  Emitter,
  type Identity,
  type PeerId,
  type SyncTransport,
  type TransportEvents,
  type WireFrame,
} from "@streamline-pulse/creeba-core";

/**
 * WebSocket transport for Creeba — the internet-facing complement of the LAN
 * iroh+mDNS transport. A node with a stable address (typically a cloud peer)
 * accepts WebSocket connections (`WsServerTransport`, bridged into any HTTP
 * framework); other nodes dial it (`WsClientTransport`). Same `WireFrame`s,
 * same trust model, same convergence as any other transport: the well-known
 * node stays "just a peer" — only the wire differs.
 *
 * Identity: a peer's id is its ed25519 public key (same key as the iroh
 * node-id). It is PROVEN at connection time by a nonce-signature handshake:
 *
 *   → {k:"hi", id, nonce, room?}          (both sides, on open)
 *   → {k:"auth", sig}                     sig = sign("creeba-ws:v1|myId|theirNonce")
 *   both verified → peer-open, then       {k:"f", f: WireFrame} frames flow.
 *
 * Crypto is INJECTED (`sign`/`verify`) so this package carries no dependency —
 * apps already have ed25519 primitives (e.g. from creeba-iroh-mdns).
 */

const AUTH_CONTEXT = "creeba-ws:v1";
const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024;
const DEFAULT_RECONNECT_MS = 3000;

/** Signs a message with the LOCAL node's secret key (curried by the app). */
export type SignFn = (message: Uint8Array) => number[];
/** Verifies a peer's signature against its claimed node-id (public key). */
export type VerifyFn = (
  peerId: string,
  message: Uint8Array,
  signature: number[],
) => boolean;

type WsMsg =
  | { k: "hi"; id: string; nonce: string; room?: string }
  | { k: "auth"; sig: number[] }
  | { k: "f"; f: WireFrame<unknown> };

function authPayload(id: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(`${AUTH_CONTEXT}|${id}|${nonce}`);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Minimal socket surface the bridges need — framework/runtime agnostic. */
export interface WsLike {
  send(data: string): void;
  close(): void;
}

/**
 * Per-connection handshake state machine, shared by client and server sides.
 * Emits `open(peerId)` once the remote proved its identity, `frame` for app
 * frames, and asks the host to `drop()` on any protocol violation.
 */
class Handshake {
  private peerId: string | null = null;
  private theirNonce: string | null = null;
  private authed = false;
  private readonly nonce = randomNonce();

  constructor(
    private readonly opts: {
      id: string;
      room: () => string | null;
      sign: SignFn;
      verify: VerifyFn;
      maxFrameSize: number;
      expectedPeerId?: string;
      socket: WsLike;
      onOpen: (peerId: string) => void;
      onFrame: (peerId: string, frame: WireFrame<unknown>) => void;
      drop: (reason: string) => void;
    },
  ) {}

  greet(): void {
    const room = this.opts.room();
    this.send({ k: "hi", id: this.opts.id, nonce: this.nonce, ...(room ? { room } : {}) });
  }

  peer(): string | null {
    return this.authed ? this.peerId : null;
  }

  sendFrame(frame: WireFrame<unknown>): void {
    if (this.authed) this.send({ k: "f", f: frame });
  }

  onMessage(raw: string): void {
    if (raw.length > this.opts.maxFrameSize)
      return this.opts.drop("frame-too-large");
    let msg: WsMsg;
    try {
      msg = JSON.parse(raw) as WsMsg;
    } catch {
      return this.opts.drop("bad-json");
    }

    if (msg.k === "hi") {
      if (this.peerId) return this.opts.drop("duplicate-hi");
      if (this.opts.expectedPeerId && msg.id !== this.opts.expectedPeerId)
        return this.opts.drop("unexpected-peer");
      if (msg.id === this.opts.id) return this.opts.drop("self-connect");
      const room = this.opts.room();
      if (room && msg.room && msg.room !== room)
        return this.opts.drop("room-mismatch");
      this.peerId = msg.id;
      this.theirNonce = msg.nonce;
      // Prove our identity against THEIR nonce.
      this.send({
        k: "auth",
        sig: this.opts.sign(authPayload(this.opts.id, msg.nonce)),
      });
      return;
    }

    if (msg.k === "auth") {
      if (!this.peerId || this.authed) return this.opts.drop("bad-auth-order");
      const ok = this.opts.verify(
        this.peerId,
        authPayload(this.peerId, this.nonce),
        msg.sig,
      );
      if (!ok) return this.opts.drop("bad-signature");
      this.authed = true;
      this.opts.onOpen(this.peerId);
      return;
    }

    if (msg.k === "f") {
      if (!this.authed || !this.peerId) return this.opts.drop("frame-before-auth");
      this.opts.onFrame(this.peerId, msg.f);
      return;
    }

    this.opts.drop("unknown-kind");
  }

  private send(msg: WsMsg): void {
    try {
      this.opts.socket.send(JSON.stringify(msg));
    } catch {
      /* socket closing — the close handler will clean up */
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface WsClientOptions {
  /** WebSocket URL of the well-known node (e.g. `wss://api.example.com/sync/ws`). */
  url: string;
  /** Local node-id (ed25519 public key, hex) — MUST match the signing key. */
  id: string;
  sign: SignFn;
  verify: VerifyFn;
  /** Pin the remote's node-id (e.g. the super-peer key). Mismatch → drop. */
  expectedPeerId?: string;
  /** Reconnection delay in ms (default 3000). Retries forever until destroy. */
  reconnectMs?: number;
  maxFrameSize?: number;
}

/**
 * Dials a well-known Creeba node over WebSocket and keeps the link alive
 * (reconnect with fixed backoff; offline is tolerated — local-first). One
 * client handles exactly one remote peer.
 */
export class WsClientTransport<T = unknown> implements SyncTransport<T> {
  private readonly emitter = new Emitter<TransportEvents<T>>();
  private socket: WebSocket | null = null;
  private handshake: Handshake | null = null;
  private room: string | null = null;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: WsClientOptions) {}

  async start(): Promise<string> {
    this.connect();
    return this.opts.id;
  }

  join(topic: string): void {
    this.room = topic;
  }

  setIdentity(_identity: Identity): void {
    /* presence rides in the core's `hello` frame — nothing transport-level */
  }

  send(peerId: PeerId, frame: WireFrame<T>): void {
    if (this.handshake?.peer() === peerId)
      this.handshake.sendFrame(frame as WireFrame<unknown>);
  }

  broadcast(frame: WireFrame<T>): void {
    this.handshake?.sendFrame(frame as WireFrame<unknown>);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown();
  }

  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  private connect(): void {
    if (this.destroyed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.opts.url);
    } catch (err) {
      this.emitter.emit("error", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const hs = new Handshake({
      id: this.opts.id,
      room: () => this.room,
      sign: this.opts.sign,
      verify: this.opts.verify,
      maxFrameSize: this.opts.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE,
      expectedPeerId: this.opts.expectedPeerId,
      socket: { send: (d) => socket.send(d), close: () => socket.close() },
      onOpen: (peerId) => this.emitter.emit("peer-open", peerId),
      onFrame: (peerId, frame) =>
        this.emitter.emit("frame", peerId, frame as WireFrame<T>),
      drop: () => socket.close(),
    });
    this.handshake = hs;

    socket.onopen = () => hs.greet();
    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") hs.onMessage(ev.data);
    };
    socket.onerror = () => {
      /* onclose follows — reconnection handles it */
    };
    socket.onclose = () => {
      const peer = hs.peer();
      this.handshake = null;
      this.socket = null;
      if (peer) this.emitter.emit("peer-close", peer);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, this.opts.reconnectMs ?? DEFAULT_RECONNECT_MS);
  }

  private teardown(): void {
    const peer = this.handshake?.peer() ?? null;
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.handshake = null;
    if (peer) this.emitter.emit("peer-close", peer);
  }
}

// ---------------------------------------------------------------------------
// Server bridge
// ---------------------------------------------------------------------------

export interface WsServerOptions {
  /** Local node-id (ed25519 public key, hex) — MUST match the signing key. */
  id: string;
  sign: SignFn;
  verify: VerifyFn;
  maxFrameSize?: number;
}

/** Handlers to wire into the host framework's WebSocket callbacks. */
export interface WsAttachment {
  onMessage(data: string): void;
  onClose(): void;
}

/**
 * Server side of the WebSocket transport: a passive `SyncTransport` fed by the
 * host HTTP framework. For each incoming socket, call `attach(socket)` and
 * forward the framework's `message`/`close` events to the returned handlers —
 * that's the whole integration.
 *
 *   // Elysia example
 *   app.ws("/sync/ws", {
 *     open:    (ws) => { atts.set(ws.id, transport.attach({ send: (d) => ws.send(d), close: () => ws.close() })) },
 *     message: (ws, msg) => atts.get(ws.id)?.onMessage(String(msg)),
 *     close:   (ws) => { atts.get(ws.id)?.onClose(); atts.delete(ws.id) },
 *   })
 */
export class WsServerTransport<T = unknown> implements SyncTransport<T> {
  private readonly emitter = new Emitter<TransportEvents<T>>();
  /** peerId -> live, authenticated handshake. */
  private readonly peers = new Map<PeerId, Handshake>();
  private room: string | null = null;
  private destroyed = false;

  constructor(private readonly opts: WsServerOptions) {}

  async start(): Promise<string> {
    return this.opts.id;
  }

  join(topic: string): void {
    this.room = topic;
  }

  setIdentity(_identity: Identity): void {
    /* nothing transport-level */
  }

  send(peerId: PeerId, frame: WireFrame<T>): void {
    this.peers.get(peerId)?.sendFrame(frame as WireFrame<unknown>);
  }

  broadcast(frame: WireFrame<T>): void {
    for (const hs of this.peers.values())
      hs.sendFrame(frame as WireFrame<unknown>);
  }

  destroy(): void {
    this.destroyed = true;
    this.peers.clear();
  }

  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  /** Bridge one incoming socket into the transport (see class docs). */
  attach(socket: WsLike): WsAttachment {
    if (this.destroyed) {
      socket.close();
      return { onMessage: () => {}, onClose: () => {} };
    }
    let dropped = false;
    const hs: Handshake = new Handshake({
      id: this.opts.id,
      room: () => this.room,
      sign: this.opts.sign,
      verify: this.opts.verify,
      maxFrameSize: this.opts.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE,
      socket,
      onOpen: (peerId) => {
        // One live connection per peer: a newcomer with the same proven id
        // replaces a stale one (e.g. after an unnoticed disconnect). No
        // peer-close is emitted for the replaced socket — same logical peer.
        this.peers.set(peerId, hs);
        this.emitter.emit("peer-open", peerId);
      },
      onFrame: (peerId, frame) =>
        this.emitter.emit("frame", peerId, frame as WireFrame<T>),
      drop: () => {
        dropped = true;
        socket.close();
      },
    });

    // Server greets first — the client answers with its own `hi`.
    hs.greet();

    return {
      onMessage: (data) => {
        if (!dropped) hs.onMessage(data);
      },
      onClose: () => {
        const peerId = hs.peer();
        if (peerId && this.peers.get(peerId) === hs) {
          this.peers.delete(peerId);
          this.emitter.emit("peer-close", peerId);
        }
      },
    };
  }
}
