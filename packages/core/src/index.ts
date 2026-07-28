/**
 * Portable entry point of the Creeba P2P layer: peer discovery, presence and
 * forwarding of opaque app payloads. Generic — message shape AND persistence
 * belong to the application. No platform-specific dependency, so it can be used
 * from Bun, Node or React Native/Expo.
 *
 * The iroh + mDNS transport (Bun/desktop) lives in a separate package so the
 * native binding never reaches mobile/browser bundles:
 *
 *   import { CreebaSync } from "@streamline-pulse/creeba-core";
 *   import { IrohMdnsTransport } from "@streamline-pulse/creeba-iroh-mdns";
 */
export { CreebaSync } from "./core.ts";
export type { CreebaSyncOptions } from "./core.ts";
export { CompositeTransport } from "./composite.ts";
export { MemoryNetwork, MemoryTransport } from "./memory.ts";
export { Emitter } from "./emitter.ts";
export type { Listener } from "./emitter.ts";
export type { SyncTransport, TransportEvents } from "./transport.ts";
export type { Identity, Peer, PeerId, Status, WireFrame } from "./types.ts";
