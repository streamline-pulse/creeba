import { Emitter } from "./emitter.ts";
import type { SyncTransport, TransportEvents } from "./transport.ts";
import type { Identity, PeerId, WireFrame } from "./types.ts";

/**
 * Transport EN MÉMOIRE : les nœuds vivent dans le même process et échangent
 * leurs frames directement. Aucun réseau, donc des scénarios multi-nœuds
 * déterministes et instantanés — c'est le transport des tests, des exemples et
 * des démos. Le protocole applicatif ne voit aucune différence avec iroh ou WS.
 *
 *   const net = new MemoryNetwork()
 *   const a = net.transport("node-a")
 *   const b = net.transport("node-b")   // a et b se découvrent en rejoignant
 *                                       // le même topic
 */

interface Member<T> {
  transport: MemoryTransport<T>;
  topic: string | null;
}

export class MemoryNetwork<T = unknown> {
  private readonly members = new Map<PeerId, Member<T>>();
  /** Latence simulée (ms) : 0 = livraison synchrone via microtâche. */
  constructor(private readonly latencyMs = 0) {}

  /** Crée un transport pour un nœud (id = clé publique dans une vraie app). */
  transport(peerId: PeerId): MemoryTransport<T> {
    const transport = new MemoryTransport<T>(peerId, this);
    this.members.set(peerId, { transport, topic: null });
    return transport;
  }

  /** Nœuds actuellement présents sur le même topic (hors soi-même). */
  private roommates(peerId: PeerId): Member<T>[] {
    const me = this.members.get(peerId);
    if (!me?.topic) return [];
    return [...this.members.entries()]
      .filter(([id, m]) => id !== peerId && m.topic === me.topic)
      .map(([, m]) => m);
  }

  /** @internal */
  join(peerId: PeerId, topic: string): void {
    const me = this.members.get(peerId);
    if (!me) return;
    me.topic = topic;
    // Découverte mutuelle : on LIE d'abord les deux côtés, puis on annonce.
    // Annoncer trop tôt ferait partir un `hello` vers un pair pas encore lié.
    const others = this.roommates(peerId);
    for (const other of others) {
      other.transport.link(peerId);
      me.transport.link(other.transport.id);
    }
    for (const other of others) {
      other.transport.announce(peerId);
      me.transport.announce(other.transport.id);
    }
  }

  /** @internal */
  deliver(from: PeerId, to: PeerId, frame: WireFrame<T>): void {
    const target = this.members.get(to);
    if (!target) return;
    // Le lien est vérifié à la LIVRAISON : une frame émise juste avant une
    // coupure n'arrive pas, comme sur un vrai réseau.
    const send = () => {
      if (target.transport.connectedTo(from)) target.transport.receive(from, frame);
    };
    if (this.latencyMs > 0) setTimeout(send, this.latencyMs);
    else queueMicrotask(send);
  }

  /** @internal */
  peersOf(peerId: PeerId): PeerId[] {
    return this.roommates(peerId).map((m) => m.transport.id);
  }

  /** @internal */
  leave(peerId: PeerId): void {
    for (const other of this.roommates(peerId)) other.transport.close(peerId);
    this.members.delete(peerId);
  }

  /** Coupe le lien entre deux nœuds (simule une partition réseau). */
  partition(a: PeerId, b: PeerId): void {
    this.members.get(a)?.transport.close(b);
    this.members.get(b)?.transport.close(a);
  }

  /** Rétablit le lien entre deux nœuds (fin de partition). */
  heal(a: PeerId, b: PeerId): void {
    const ta = this.members.get(a)?.transport;
    const tb = this.members.get(b)?.transport;
    if (!ta || !tb) return;
    ta.link(b);
    tb.link(a);
    ta.announce(b);
    tb.announce(a);
  }
}

export class MemoryTransport<T = unknown> implements SyncTransport<T> {
  private readonly emitter = new Emitter<TransportEvents<T>>();
  private readonly connected = new Set<PeerId>();
  private destroyed = false;

  constructor(
    readonly id: PeerId,
    private readonly network: MemoryNetwork<T>,
  ) {}

  async start(): Promise<string> {
    return this.id;
  }

  join(topic: string): void {
    if (this.destroyed) return;
    this.network.join(this.id, topic);
  }

  setIdentity(_identity: Identity): void {
    /* la présence transite dans le `hello` du cœur */
  }

  send(peerId: PeerId, frame: WireFrame<T>): void {
    if (this.destroyed) return;
    this.network.deliver(this.id, peerId, frame);
  }

  broadcast(frame: WireFrame<T>): void {
    for (const peerId of this.connected) this.send(peerId, frame);
  }

  destroy(): void {
    this.destroyed = true;
    this.connected.clear();
    this.network.leave(this.id);
  }

  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  /** @internal */
  connectedTo(peerId: PeerId): boolean {
    return this.connected.has(peerId);
  }

  /** @internal Enregistre le lien SANS l'annoncer. */
  link(peerId: PeerId): void {
    if (this.destroyed) return;
    this.connected.add(peerId);
  }

  /** @internal Annonce un lien déjà enregistré. */
  announce(peerId: PeerId): void {
    if (this.destroyed || !this.connected.has(peerId)) return;
    this.emitter.emit("peer-open", peerId);
  }

  /** @internal */
  close(peerId: PeerId): void {
    if (this.connected.delete(peerId)) this.emitter.emit("peer-close", peerId);
  }

  /** @internal */
  receive(from: PeerId, frame: WireFrame<T>): void {
    if (!this.destroyed) this.emitter.emit("frame", from, frame);
  }
}
