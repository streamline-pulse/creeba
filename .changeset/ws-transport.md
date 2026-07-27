---
"@streamline-pulse/creeba-ws": minor
"@streamline-pulse/creeba-core": minor
---

New `@streamline-pulse/creeba-ws` package: a WebSocket transport so a
well-known node (e.g. a cloud peer) is reachable over plain WebSocket — same
frames, certs and convergence as any other transport. Client transport
(reconnecting, peer pinning) + framework-agnostic server bridge. Peer identity
is proven by an ed25519 nonce-signature handshake; crypto is injected so the
package stays dependency-free.

`creeba-core` gains `CompositeTransport`: aggregate several transports (e.g.
iroh+mDNS on the LAN and WebSocket to a cloud node) behind one `SyncTransport`,
with per-peer dedup so the core sees a single logical peer.
