/** Shared types of the Creeba P2P layer (fully portable, no platform dependency). */

/** A peer's transport identifier (e.g. iroh node-id). */
export type PeerId = string;

/**
 * Local participant identity. `userId` is stable (created and persisted by the
 * app); `metadata` is a free presence bag chosen by the app (name, avatar,
 * role…), propagated to other peers during the `hello` handshake.
 */
export interface Identity {
  userId: string;
  metadata?: Record<string, unknown>;
}

/** A peer discovered and connected on the P2P network. */
export interface Peer {
  peerId: PeerId;
  userId: string;
  metadata?: Record<string, unknown>;
}

/** Local P2P node state. `publicKey` is the local transport identifier. */
export interface Status {
  ready: boolean;
  publicKey?: string;
}

/**
 * Frame exchanged between peers, generic over the app payload `T`. The core only
 * knows two categories:
 *  - `hello`: presence (identity + metadata), interpreted by the core;
 *  - `data`: opaque app payload, forwarded as-is. Its shape is entirely defined
 *    by the application (e.g. a chat message, a CRDT patch, a game event…).
 */
export type WireFrame<T = unknown> =
  | { kind: "hello"; userId: string; metadata?: Record<string, unknown> }
  | { kind: "data"; payload: T };
