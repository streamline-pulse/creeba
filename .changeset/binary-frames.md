---
"@streamline-pulse/creeba-core": minor
"@streamline-pulse/creeba-iroh-mdns": minor
"@streamline-pulse/creeba-ws": minor
---

Binary frames: payloads carrying `Uint8Array`/`Buffer` values (file chunks…) travel as raw bytes instead of base64 inside JSON. `encodeFrame`/`decodeFrame`/`hasBinary` (core) define the envelope; the iroh transport uses it for every frame and the WebSocket transport sends such frames as binary messages (`WsLike.send` and `WsAttachment.onMessage` accept `Uint8Array`). Frames without bytes stay plain JSON, so peers that do not send bytes keep interoperating with older versions.
