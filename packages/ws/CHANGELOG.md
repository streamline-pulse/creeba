# @streamline-pulse/creeba-ws

## 7.0.0

### Minor Changes

- 50bfd44: Binary frames: payloads carrying `Uint8Array`/`Buffer` values (file chunks…) travel as raw bytes instead of base64 inside JSON. `encodeFrame`/`decodeFrame`/`hasBinary` (core) define the envelope; the iroh transport uses it for every frame and the WebSocket transport sends such frames as binary messages (`WsLike.send` and `WsAttachment.onMessage` accept `Uint8Array`). Frames without bytes stay plain JSON, so peers that do not send bytes keep interoperating with older versions.

### Patch Changes

- Updated dependencies [50bfd44]
  - @streamline-pulse/creeba-core@7.0.0

## 6.0.1

### Patch Changes

- @streamline-pulse/creeba-core@6.0.1

## 6.0.0

### Patch Changes

- @streamline-pulse/creeba-core@6.0.0

## 5.0.1

### Patch Changes

- @streamline-pulse/creeba-core@5.0.1

## 5.0.0

### Patch Changes

- @streamline-pulse/creeba-core@5.0.0

## 4.0.0

### Patch Changes

- Updated dependencies [cb0156e]
  - @streamline-pulse/creeba-core@4.0.0

## 3.0.0

### Patch Changes

- Updated dependencies [54fce13]
  - @streamline-pulse/creeba-core@3.0.0

## 2.0.0

### Minor Changes

- f9e2afe: New `@streamline-pulse/creeba-ws` package: a WebSocket transport so a
  well-known node (e.g. a cloud peer) is reachable over plain WebSocket — same
  frames, certs and convergence as any other transport. Client transport
  (reconnecting, peer pinning) + framework-agnostic server bridge. Peer identity
  is proven by an ed25519 nonce-signature handshake; crypto is injected so the
  package stays dependency-free.

  `creeba-core` gains `CompositeTransport`: aggregate several transports (e.g.
  iroh+mDNS on the LAN and WebSocket to a cloud node) behind one `SyncTransport`,
  with per-peer dedup so the core sees a single logical peer.

### Patch Changes

- Updated dependencies [f9e2afe]
  - @streamline-pulse/creeba-core@2.0.0
