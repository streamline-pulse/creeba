# @streamline-pulse/creeba-iroh-mdns

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

### Patch Changes

- Updated dependencies [f9e2afe]
  - @streamline-pulse/creeba-core@2.0.0

## 1.0.0

### Minor Changes

- 8cc0069: Add `bootstrapPeers` option to `IrohMdnsTransport`: node-ids that are always
  connected and kept connected, dialed by node-id alone (no ticket, no mDNS).
  iroh's n0 discovery resolves the address and relays handle NAT, so a node can
  reach a well-known peer (e.g. a super-node) across the internet. A maintenance
  loop redials on drop and tolerates being offline. `bootstrapIntervalMs`
  (default 5000) tunes the loop. Purely additive; existing LAN/mDNS behaviour is
  unchanged.

### Patch Changes

- @streamline-pulse/creeba-core@1.0.0
