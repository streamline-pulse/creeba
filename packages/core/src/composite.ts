import { Emitter } from "./emitter.ts";
import type { SyncTransport, TransportEvents } from "./transport.ts";
import type { Identity, PeerId, WireFrame } from "./types.ts";

/**
 * Aggregates several transports behind the single `SyncTransport` contract, so
 * a node can be reachable through more than one medium at once — e.g. iroh+mDNS
 * on the LAN and a WebSocket link to a well-known node over the internet.
 *
 * A peer is identified by its `PeerId` regardless of the medium: if the same
 * peer is connected through several transports, the composite exposes ONE
 * logical peer (`peer-open` on first connection, `peer-close` on last) and
 * routes `send`/`broadcast` through a single transport per peer — the core
 * never sees duplicates.
 *
 * Transports can also be added AFTER `start()` via `addTransport` — e.g. a
 * node that boots offline and only later resolves the address/key of a
 * well-known peer can graft the corresponding transport without restarting.
 */
export class CompositeTransport<T = unknown> implements SyncTransport<T> {
  private readonly emitter = new Emitter<TransportEvents<T>>();
  /** peerId -> transports currently holding a live connection to that peer. */
  private readonly routes = new Map<PeerId, Set<SyncTransport<T>>>();
  private readonly transports: SyncTransport<T>[] = [];
  private started = false;
  private topic: string | null = null;
  private identity: Identity | null = null;
  private destroyed = false;

  constructor(transports: SyncTransport<T>[]) {
    if (transports.length === 0)
      throw new Error("CompositeTransport requires at least one transport");
    for (const t of transports) this.attach(t);
  }

  /** Wires a transport's events into the composite. */
  private attach(t: SyncTransport<T>): void {
    this.transports.push(t);
    t.on("peer-open", (peerId) => {
      let set = this.routes.get(peerId);
      const first = !set;
      if (!set) {
        set = new Set();
        this.routes.set(peerId, set);
      }
      set.add(t);
      if (first) this.emitter.emit("peer-open", peerId);
    });
    t.on("peer-close", (peerId) => {
      const set = this.routes.get(peerId);
      if (!set) return;
      set.delete(t);
      if (set.size === 0) {
        this.routes.delete(peerId);
        this.emitter.emit("peer-close", peerId);
      }
    });
    t.on("frame", (peerId, frame) => this.emitter.emit("frame", peerId, frame));
    t.on("error", (err) => this.emitter.emit("error", err));
  }

  /**
   * Grafts a transport onto a composite that may already be running: replays
   * `start()`, the current identity and the joined topic so the newcomer is
   * immediately at parity with the others. Errors are reported via `error`
   * (the composite keeps working on its existing transports).
   */
  addTransport(t: SyncTransport<T>): void {
    if (this.destroyed) return;
    this.attach(t);
    if (!this.started) return; // start() les démarrera tous
    void t
      .start()
      .then(() => {
        if (this.identity) t.setIdentity(this.identity);
        if (this.topic) t.join(this.topic);
      })
      .catch((err) => this.emitter.emit("error", err));
  }

  /**
   * Starts every transport. All must be configured with the SAME identity key
   * (the local id is the key's public form); the id of the first transport that
   * starts successfully is returned. A transport that fails to start is
   * tolerated (reported via `error`) as long as at least one succeeds.
   */
  async start(): Promise<string> {
    const ids: string[] = [];
    for (const t of this.transports) {
      try {
        ids.push(await t.start());
      } catch (err) {
        this.emitter.emit("error", err);
      }
    }
    const id = ids.find((v) => v.length > 0);
    if (!id) throw new Error("CompositeTransport: no transport could start");
    this.started = true;
    return id;
  }

  join(topic: string): void {
    this.topic = topic;
    for (const t of this.transports) t.join(topic);
  }

  setIdentity(identity: Identity): void {
    this.identity = identity;
    for (const t of this.transports) t.setIdentity(identity);
  }

  send(peerId: PeerId, frame: WireFrame<T>): void {
    const set = this.routes.get(peerId);
    const t = set?.values().next().value;
    if (t) t.send(peerId, frame);
  }

  /** One delivery per peer, whatever the number of shared transports. */
  broadcast(frame: WireFrame<T>): void {
    for (const peerId of this.routes.keys()) this.send(peerId, frame);
  }

  destroy(): void {
    this.destroyed = true;
    for (const t of this.transports) {
      try {
        t.destroy();
      } catch {
        /* ignore */
      }
    }
    this.routes.clear();
  }

  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }
}
