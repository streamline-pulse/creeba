/**
 * Portable entry point of the Creeba P2P layer: peer discovery, presence and
 * forwarding of opaque app payloads. Generic — message shape AND persistence
 * belong to the application. No platform-specific dependency, so it can be used
 * from Bun, Node or React Native/Expo.
 *
 * The iroh + mDNS transport (Bun/desktop) is exposed separately to avoid pulling
 * the native binding into mobile bundles:
 *
 *   import { CreebaSync } from "creeba-js";
 *   import { IrohMdnsTransport } from "creeba-js/iroh-mdns";
 */
export { CreebaSync } from "./core.ts";
export type { CreebaSyncOptions } from "./core.ts";
export { Emitter } from "./emitter.ts";
export type { Listener } from "./emitter.ts";
export type { SyncTransport, TransportEvents } from "./transport.ts";
export type { Identity, Peer, PeerId, Status, WireFrame } from "./types.ts";
