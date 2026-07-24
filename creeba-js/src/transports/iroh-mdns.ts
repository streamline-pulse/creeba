import {
  Endpoint,
  EndpointId,
  EndpointTicket,
  SecretKey,
  Signature,
  type Connection,
  type RecvStream,
  type SendStream,
} from "@number0/iroh";
import Bonjour from "bonjour-service";
import { Emitter } from "../emitter.ts";
import type { SyncTransport, TransportEvents } from "../transport.ts";
import type { Identity, PeerId, WireFrame } from "../types.ts";

/**
 * iroh-based P2P transport (encrypted QUIC, holepunch + relay fallback) with
 * local discovery over mDNS (bonjour-service) — no sidecar, no server.
 *
 * Each instance binds an iroh endpoint, advertises its iroh ticket over mDNS for
 * the current topic, connects to discovered peers and exchanges length-prefixed
 * NDJSON frames over a persistent bi-stream. It does not interpret frame
 * contents: that is the job of the `CreebaSync` core.
 *
 * The protocol (ALPN) and mDNS service are configurable: each app picks its own
 * so it only interoperates with its own peers.
 */

const DEFAULT_PROTOCOL = "creeba/0";
const DEFAULT_SERVICE_TYPE = "creeba";
const DEFAULT_SERVICE_NAME_PREFIX = "creeba";
const SERVICE_PORT = 49737; // indicative only: the actual connection goes through iroh

const DEBUG = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.CREEBA_DEBUG;
function log(...args: unknown[]): void {
  if (DEBUG) console.log("[iroh-mdns]", ...args);
}

interface PeerConn {
  conn: Connection;
  send: SendStream;
  recv: RecvStream;
  writeChain: Promise<unknown>;
}

interface MdnsService {
  txt?: Record<string, string>;
}
interface MdnsBrowser {
  on(event: "up" | "down", cb: (svc: MdnsService) => void): void;
  stop(): void;
}

const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024;

export interface IrohMdnsOptions {
  /**
   * App protocol → iroh ALPN (isolates the protocol between apps).
   * Default: `"creeba/0"`. Two peers connect only if they share the ALPN.
   */
  protocol?: string;
  /** mDNS service type (no underscore, no `._udp`). Default: `"creeba"`. */
  serviceType?: string;
  /** Prefix of the advertised mDNS instance name. Default: `"creeba"`. */
  serviceNamePrefix?: string;
  /**
   * 32-byte iroh secret key (see `generateSecretKey`). Persist it to keep a
   * STABLE node-id across restarts. Omitted → a fresh (ephemeral) id each run.
   */
  secretKey?: number[];
  /**
   * Max accepted frame size in bytes (default 16 MiB). A peer announcing a
   * larger frame has its connection dropped — bounds the reassembly buffer.
   */
  maxFrameSize?: number;
  /**
   * Optional connection allowlist. Returns false → the peer (by node-id) is
   * rejected before any frame is exchanged. The app remains free to enforce
   * its own trust at a higher level (e.g. signed identity in `hello`).
   */
  allowPeer?: (peerId: PeerId) => boolean;
}

/** Generate a fresh 32-byte iroh secret key (raw bytes), to persist by the app. */
export function generateSecretKey(): number[] {
  return SecretKey.generate().toBytes();
}

/** Public node-id (as seen in peer events) for a given secret key. */
export function publicKeyOf(secretKey: number[]): string {
  return SecretKey.fromBytes(secretKey).public().toString();
}

/** ed25519 signature (raw bytes) of `message` under `secretKey`. */
export function sign(secretKey: number[], message: Uint8Array): number[] {
  return SecretKey.fromBytes(secretKey).sign(Array.from(message)).toBytes();
}

/** Verify an ed25519 `signature` of `message` against a peer's node-id. */
export function verify(
  peerId: string,
  message: Uint8Array,
  signature: number[],
): boolean {
  try {
    EndpointId.fromString(peerId).verify(
      Array.from(message),
      Signature.fromBytes(signature),
    );
    return true;
  } catch {
    return false;
  }
}

function frameBytes<T>(frame: WireFrame<T>): number[] {
  const body = new TextEncoder().encode(JSON.stringify(frame));
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, false);
  out.set(body, 4);
  return Array.from(out);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class IrohMdnsTransport<T = unknown> implements SyncTransport<T> {
  private readonly emitter = new Emitter<TransportEvents<T>>();
  private endpoint?: Endpoint;
  private bonjour?: InstanceType<typeof Bonjour>;
  private browser?: MdnsBrowser;
  private identity: Identity = { userId: "" };
  private room: string | null = null;
  private ticket = "";
  private destroyed = false;

  private readonly alpn: number[];
  private readonly serviceType: string;
  private readonly serviceNamePrefix: string;
  private readonly secretKey?: number[];
  private readonly maxFrameSize: number;
  private readonly allowPeer?: (peerId: PeerId) => boolean;

  /** peerId (iroh node-id) -> connection */
  private readonly connections = new Map<PeerId, PeerConn>();
  /** peers currently being dialed (avoids duplicates) */
  private readonly dialing = new Set<PeerId>();

  private publicKey = "";

  constructor(options: IrohMdnsOptions = {}) {
    this.alpn = Array.from(Buffer.from(options.protocol ?? DEFAULT_PROTOCOL));
    this.serviceType = options.serviceType ?? DEFAULT_SERVICE_TYPE;
    this.serviceNamePrefix = options.serviceNamePrefix ?? DEFAULT_SERVICE_NAME_PREFIX;
    this.secretKey = options.secretKey;
    this.maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME_SIZE;
    this.allowPeer = options.allowPeer;
  }

  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  async start(): Promise<string> {
    const endpoint = await Endpoint.bind({
      alpns: [this.alpn],
      secretKey: this.secretKey,
    });
    this.endpoint = endpoint;
    this.publicKey = endpoint.id().toString();
    this.refreshTicket();
    log(`start node-id=${this.publicKey.slice(0, 12)}… ticketLen=${this.ticket.length}`);
    void this.acceptLoop();
    return this.publicKey;
  }

  setIdentity(identity: Identity): void {
    this.identity = identity;
    if (this.room) this.publish();
  }

  join(topic: string): void {
    this.room = topic;
    log(`join topic=${topic}`);
    this.publish();
    this.discover();
  }

  send(peerId: PeerId, frame: WireFrame<T>): void {
    const pc = this.connections.get(peerId);
    if (pc) this.write(pc, frame);
  }

  broadcast(frame: WireFrame<T>): void {
    for (const [, pc] of this.connections) this.write(pc, frame);
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.browser?.stop();
    } catch {
      /* ignore */
    }
    try {
      this.bonjour?.unpublishAll(() => {});
      this.bonjour?.destroy();
    } catch {
      /* ignore */
    }
    for (const [, pc] of this.connections) {
      try {
        pc.conn.close(0n, Array.from(Buffer.from("bye")));
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    this.endpoint?.close().catch(() => {});
  }

  // ---- iroh ----

  private refreshTicket(): void {
    if (!this.endpoint) return;
    try {
      this.ticket = EndpointTicket.fromAddr(this.endpoint.addr()).toString();
    } catch (err) {
      log(`refreshTicket err: ${String((err as Error)?.message ?? err)}`);
    }
  }

  private async acceptLoop(): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    for (;;) {
      if (this.destroyed) return;
      let conn: Connection;
      try {
        const incoming = await endpoint.acceptNext();
        if (!incoming) return;
        const accepting = await incoming.accept();
        conn = await accepting.connect();
      } catch (err) {
        if (this.destroyed) return;
        log(`acceptLoop err: ${String((err as Error)?.message ?? err)}`);
        continue;
      }
      this.attachConnection(conn, false).catch((err) =>
        log(`attach(accept) err: ${String(err?.message ?? err)}`),
      );
    }
  }

  private async dial(ticket: string): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint) return;
    let conn: Connection;
    try {
      const addr = EndpointTicket.fromString(ticket).endpointAddr();
      conn = await endpoint.connect(addr, this.alpn);
    } catch (err) {
      log(`dial err: ${String((err as Error)?.message ?? err)}`);
      return;
    }
    await this.attachConnection(conn, true);
  }

  private async attachConnection(conn: Connection, isDialer: boolean): Promise<void> {
    const peerId = conn.remoteId().toString();
    this.dialing.delete(peerId);

    if (this.allowPeer && !this.allowPeer(peerId)) {
      try {
        conn.close(0n, Array.from(Buffer.from("denied")));
      } catch {
        /* ignore */
      }
      log(`peer denied by allowPeer ${peerId.slice(0, 12)}…`);
      return;
    }

    if (this.connections.has(peerId) || peerId === this.publicKey) {
      try {
        conn.close(0n, Array.from(Buffer.from("dup")));
      } catch {
        /* ignore */
      }
      return;
    }

    const bi = isDialer ? await conn.openBi() : await conn.acceptBi();
    const pc: PeerConn = { conn, send: bi.send, recv: bi.recv, writeChain: Promise.resolve() };
    this.connections.set(peerId, pc);
    log(`${isDialer ? "outgoing" : "incoming"} connection peer=${peerId.slice(0, 12)}…`);

    conn
      .closed()
      .catch(() => {})
      .finally(() => this.removePeer(peerId));

    void this.readLoop(peerId, pc).catch(() => this.removePeer(peerId));
    this.emitter.emit("peer-open", peerId);
  }

  private removePeer(peerId: PeerId): void {
    if (this.connections.delete(peerId)) {
      log(`peer left ${peerId.slice(0, 12)}…`);
      this.emitter.emit("peer-close", peerId);
    }
  }

  private write(pc: PeerConn, frame: WireFrame<T>): void {
    const data = frameBytes(frame);
    pc.writeChain = pc.writeChain
      .then(() => pc.send.writeAll(data))
      .catch((err) => log(`write err: ${String(err?.message ?? err)}`));
  }

  private async readLoop(peerId: PeerId, pc: PeerConn): Promise<void> {
    let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    const decoder = new TextDecoder();
    for (;;) {
      let chunk: number[];
      try {
        chunk = await pc.recv.read(65536);
      } catch {
        break; // stream closed
      }
      if (!chunk || chunk.length === 0) break;
      buf = concatBytes(buf, Uint8Array.from(chunk));
      while (buf.length >= 4) {
        const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
        if (len > this.maxFrameSize) {
          log(`frame too large (${len} > ${this.maxFrameSize}) — dropping peer`);
          this.connections.get(peerId)?.conn.close(0n, Array.from(Buffer.from("frame-too-large")));
          this.removePeer(peerId);
          return;
        }
        if (buf.length < 4 + len) break;
        const body = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        try {
          this.emitter.emit("frame", peerId, JSON.parse(decoder.decode(body)) as WireFrame<T>);
        } catch {
          /* corrupted frame */
        }
      }
    }
    this.removePeer(peerId);
  }

  // ---- mDNS ----

  private serviceName(): string {
    return `${this.serviceNamePrefix}-${this.publicKey.slice(0, 16)}`;
  }

  private publish(): void {
    if (!this.room || !this.ticket) return;
    try {
      if (!this.bonjour) this.bonjour = new Bonjour();
      this.bonjour.unpublishAll(() => {});
      this.bonjour.publish({
        name: this.serviceName(),
        type: this.serviceType,
        protocol: "udp",
        port: SERVICE_PORT,
        txt: {
          id: this.publicKey,
          userId: this.identity.userId,
          room: this.room,
          ticket: this.ticket,
        },
      });
      log(`mDNS published topic=${this.room}`);
    } catch (err) {
      log(`publish err: ${String((err as Error)?.message ?? err)}`);
      this.emitter.emit("error", err);
    }
  }

  private discover(): void {
    if (this.browser) return;
    try {
      if (!this.bonjour) this.bonjour = new Bonjour();
      this.browser = this.bonjour.find({
        type: this.serviceType,
        protocol: "udp",
      }) as unknown as MdnsBrowser;
      this.browser.on("up", (svc: MdnsService) => {
        const txt = svc.txt ?? {};
        if (!txt.id || !txt.ticket) return;
        if (txt.room !== this.room) return;
        if (txt.id === this.publicKey) return;
        if (this.connections.has(txt.id) || this.dialing.has(txt.id)) return;
        log(`discovered peer=${txt.id.slice(0, 12)}…`);
        // Tie-break: only the lower node-id dials; the other waits to accept.
        if (this.publicKey < txt.id) {
          const target = txt.id;
          this.dialing.add(target);
          this.dial(txt.ticket).catch(() => this.dialing.delete(target));
        }
      });
    } catch (err) {
      log(`discover err: ${String((err as Error)?.message ?? err)}`);
      this.emitter.emit("error", err);
    }
  }
}
