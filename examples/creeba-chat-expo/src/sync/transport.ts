import { Emitter } from "creeba-js";
import type { Identity, PeerId, SyncTransport, TransportEvents, WireFrame } from "creeba-js";
import type { Wire } from "./types";

/**
 * Mobile transport — STUB (not implemented), typed on the `Wire` payload.
 *
 * iroh CANNOT be reused as-is: `@number0/iroh` is a native NAPI addon (Node/Bun)
 * that does not run in Hermes. Two ways to get a real mobile transport, pluggable
 * here without touching the rest:
 *
 *  1. Native iroh module (recommended): `creeba-expo` (Swift/Kotlin via iroh-ffi),
 *     which exposes `IrohExpoTransport`. Requires a dev build (not Expo Go).
 *  2. WebSocket relay to a backend: simple, works in Expo Go, but depends on the
 *     server (not pure LAN P2P).
 *
 * Until this transport is wired up, the app persists and displays local messages
 * but does not exchange with any peer.
 */
export class StubTransport implements SyncTransport<Wire> {
  private readonly emitter = new Emitter<TransportEvents<Wire>>();

  on<K extends keyof TransportEvents<Wire>>(
    event: K,
    cb: (...args: TransportEvents<Wire>[K]) => void,
  ): () => void {
    return this.emitter.on(event, cb);
  }

  async start(): Promise<string> {
    console.warn("[creeba-chat-expo] P2P transport not implemented — see src/sync/README.md");
    return "mobile-stub";
  }

  join(_topic: string): void {}
  setIdentity(_identity: Identity): void {}
  send(_peerId: PeerId, _frame: WireFrame<Wire>): void {}
  broadcast(_frame: WireFrame<Wire>): void {}

  destroy(): void {
    this.emitter.clear();
  }
}
