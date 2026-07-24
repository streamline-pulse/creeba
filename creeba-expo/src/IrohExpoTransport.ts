import { Emitter } from "@streamline-pulse/creeba-core";
import type { Identity, PeerId, SyncTransport, TransportEvents, WireFrame } from "@streamline-pulse/creeba-core";
import { CreebaExpoModule } from "./CreebaExpoModule.ts";

/**
 * Mobile iroh-based P2P transport via the native `creeba-expo` module, generic
 * over the app payload `T`.
 *
 * It is a thin adapter: all the logic (iroh endpoint, framing, mDNS) lives on
 * the native side (Swift/Kotlin, iroh-ffi). This class only maps native events
 * onto creeba's `Emitter` and (de)serializes frames. The wire format and ALPN
 * are identical to desktop → interoperable.
 */
export class IrohExpoTransport<T = unknown> implements SyncTransport<T> {
  private readonly emitter = new Emitter<TransportEvents<T>>();
  private readonly subscriptions: Array<{ remove: () => void }> = [];
  private identity: Identity = { userId: "" };

  constructor() {
    // Subscribe at construction time so no early event is missed (the core
    // registers its handlers before calling start()).
    this.subscriptions.push(
      CreebaExpoModule.addListener("onPeerOpen", ({ peerId }) =>
        this.emitter.emit("peer-open", peerId),
      ),
      CreebaExpoModule.addListener("onPeerClose", ({ peerId }) =>
        this.emitter.emit("peer-close", peerId),
      ),
      CreebaExpoModule.addListener("onFrame", ({ peerId, frame }) => {
        try {
          this.emitter.emit("frame", peerId, JSON.parse(frame) as WireFrame<T>);
        } catch {
          /* corrupted frame */
        }
      }),
      CreebaExpoModule.addListener("onError", ({ message }) =>
        this.emitter.emit("error", new Error(message)),
      ),
    );
  }

  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  async start(): Promise<string> {
    // Native side binds the endpoint (persisted secret key → stable node-id).
    return CreebaExpoModule.start(this.nativeIdentity());
  }

  setIdentity(identity: Identity): void {
    this.identity = identity;
    CreebaExpoModule.setIdentity(this.nativeIdentity());
  }

  join(topic: string): void {
    CreebaExpoModule.join(topic);
  }

  send(peerId: PeerId, frame: WireFrame<T>): void {
    CreebaExpoModule.send(peerId, JSON.stringify(frame));
  }

  broadcast(frame: WireFrame<T>): void {
    CreebaExpoModule.broadcast(JSON.stringify(frame));
  }

  /**
   * The native bridge expects a `{ userId, name }` identity (legacy presence
   * schema used for the mDNS TXT record). We project creeba's generic identity
   * (free `metadata`) onto that contract: `metadata.name` → `name`.
   */
  private nativeIdentity(): string {
    const name = typeof this.identity.metadata?.name === "string" ? this.identity.metadata.name : "";
    return JSON.stringify({ userId: this.identity.userId, name });
  }

  destroy(): void {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions.length = 0;
    CreebaExpoModule.destroy();
    this.emitter.clear();
  }
}
