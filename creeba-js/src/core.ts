import { Emitter } from "./emitter.ts";
import type { SyncTransport } from "./transport.ts";
import type { Identity, Peer, PeerId, Status, WireFrame } from "./types.ts";

export interface CreebaSyncOptions<T = unknown> {
  transport: SyncTransport<T>;
  /** Local identity. The app owns its creation/persistence and provides it. */
  identity: Identity;
  /** Logical topic/channel joined on start (scopes peer discovery). */
  topic: string;
}

interface CoreEvents<T> extends Record<string, unknown[]> {
  /** App payload received from a peer (2nd arg: the sender peer, if known). */
  data: [T, Peer | undefined];
  peers: [Peer[]];
  status: [Status];
}

/**
 * Generic, fully portable P2P core (no platform dependency). It orchestrates a
 * `SyncTransport`: presence handshake (`hello`), peer list, and forwarding of an
 * opaque app payload `T` whose semantics it ignores.
 *
 * Persistence and message shape are left to the app: the core only
 * broadcasts/receives payloads and emits the `data` event.
 *
 *   const sync = new CreebaSync<MyMessage>({ transport, identity, topic });
 *   sync.on("data", (msg, from) => { ... });   // received from a peer
 *   await sync.start();
 *   sync.broadcast(myMessage);                  // to all peers
 */
export class CreebaSync<T = unknown> {
  private readonly emitter = new Emitter<CoreEvents<T>>();
  private readonly peersById = new Map<PeerId, Peer>();
  private identity: Identity;
  private publicKey = "";
  private isReady = false;

  constructor(private readonly options: CreebaSyncOptions<T>) {
    this.identity = options.identity;
  }

  on<K extends keyof CoreEvents<T>>(event: K, cb: (...args: CoreEvents<T>[K]) => void): () => void {
    return this.emitter.on(event, cb);
  }

  /** Start the transport, announce presence and join the topic. */
  async start(): Promise<{ publicKey: string }> {
    const { transport, topic } = this.options;
    transport.setIdentity(this.identity);

    transport.on("peer-open", (peerId) => {
      transport.send(peerId, this.helloFrame());
    });
    transport.on("peer-close", (peerId) => {
      if (this.peersById.delete(peerId)) this.emitter.emit("peers", this.peers());
    });
    transport.on("frame", (peerId, frame) => this.onFrame(peerId, frame));

    this.publicKey = await transport.start();
    this.isReady = true;
    transport.join(topic);
    this.emitter.emit("status", this.status());
    return { publicKey: this.publicKey };
  }

  private helloFrame(): WireFrame<T> {
    return { kind: "hello", userId: this.identity.userId, metadata: this.identity.metadata };
  }

  private onFrame(peerId: PeerId, frame: WireFrame<T>): void {
    if (frame.kind === "hello") {
      this.peersById.set(peerId, { peerId, userId: frame.userId, metadata: frame.metadata });
      this.emitter.emit("peers", this.peers());
      return;
    }
    if (frame.kind === "data") {
      this.emitter.emit("data", frame.payload, this.peersById.get(peerId));
    }
  }

  /** Broadcast an app payload to all connected peers. */
  broadcast(payload: T): void {
    this.options.transport.broadcast({ kind: "data", payload });
  }

  /** Send an app payload to a specific peer. */
  send(peerId: PeerId, payload: T): void {
    this.options.transport.send(peerId, { kind: "data", payload });
  }

  /** Update the local identity (metadata) and (re)announce it to peers. */
  setIdentity(identity: Identity): void {
    this.identity = identity;
    this.options.transport.setIdentity(identity);
    this.options.transport.broadcast(this.helloFrame());
  }

  peers(): Peer[] {
    return [...this.peersById.values()];
  }

  status(): Status {
    return { ready: this.isReady, publicKey: this.publicKey };
  }

  getIdentity(): Identity {
    return this.identity;
  }

  destroy(): void {
    this.options.transport.destroy();
    this.emitter.clear();
  }
}
