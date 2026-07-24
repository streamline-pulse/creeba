import type { Identity, PeerId, WireFrame } from "./types.ts";

/** Events a transport reports to the core. Generic over the payload `T`. */
export interface TransportEvents<T = unknown> extends Record<string, unknown[]> {
  "peer-open": [PeerId];
  "peer-close": [PeerId];
  frame: [PeerId, WireFrame<T>];
  /** Non-fatal transport error. */
  error: [unknown];
}

/**
 * Contract for a P2P transport. It has NO knowledge of app semantics: it carries
 * opaque frames (`hello`/`data`) and signals peers joining/leaving.
 * Implementations: `IrohMdnsTransport` (Bun/Node/desktop), and a native-module
 * based transport on mobile (e.g. `IrohExpoTransport`).
 */
export interface SyncTransport<T = unknown> {
  /** Start the transport and return the local id (e.g. iroh node-id). */
  start(): Promise<string>;
  /** Join a topic/channel: (re)announce presence and start discovery. */
  join(topic: string): void;
  /** Provide/update the local identity (used for the discovery announcement). */
  setIdentity(identity: Identity): void;
  send(peerId: PeerId, frame: WireFrame<T>): void;
  broadcast(frame: WireFrame<T>): void;
  destroy(): void;
  on<K extends keyof TransportEvents<T>>(
    event: K,
    cb: (...args: TransportEvents<T>[K]) => void,
  ): () => void;
}
