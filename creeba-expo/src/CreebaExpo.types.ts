/**
 * Contract of the native bridge (Swift/Kotlin) exposed to JavaScript.
 *
 * The native module holds ALL the transport logic (iroh endpoint,
 * length-prefixed framing, mDNS discovery) and talks to JS via high-level
 * messages: app frames travel serialized as JSON strings, exactly like the
 * desktop wire format (`WireFrame`).
 */

/** Events pushed from native to JS. */
export type CreebaExpoEvents = {
  /** iroh endpoint bound: `publicKey` = node-id (hex). */
  onReady: (payload: { publicKey: string }) => void;
  onPeerOpen: (payload: { peerId: string }) => void;
  onPeerClose: (payload: { peerId: string }) => void;
  /** Frame received from a peer (`frame` = JSON string of a `WireFrame`). */
  onFrame: (payload: { peerId: string; frame: string }) => void;
  /** Non-fatal transport error. */
  onError: (payload: { message: string }) => void;
};

/** Native function surface (mirror of the desktop `IrohMdnsTransport`). */
export interface CreebaExpoNativeModule {
  /**
   * Bind the iroh endpoint (reusing/persisting the secret key for a stable
   * node-id) and start the accept loop. Returns the `publicKey`.
   * @param identityJson JSON `{ userId, name }`.
   */
  start(identityJson: string): Promise<string>;
  /** Join a room: (re)announce over mDNS and start discovery. */
  join(room: string): void;
  /** Update the local identity (re-announce over mDNS if a room is active). */
  setIdentity(identityJson: string): void;
  send(peerId: string, frameJson: string): void;
  broadcast(frameJson: string): void;
  destroy(): void;

  /** Event subscription (provided by `expo-modules-core`). */
  addListener<K extends keyof CreebaExpoEvents>(
    event: K,
    listener: CreebaExpoEvents[K],
  ): { remove: () => void };
}
