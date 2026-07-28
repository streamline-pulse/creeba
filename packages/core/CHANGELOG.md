# @streamline-pulse/creeba-core

## 4.0.0

### Minor Changes

- cb0156e: New `MemoryNetwork` / `MemoryTransport`: an in-process transport where nodes
  exchange frames directly — no network, so multi-node scenarios are
  deterministic and instant. Intended for tests, examples and demos; the
  application protocol sees no difference from iroh or WebSocket. The network
  can also simulate latency, `partition(a, b)` and `heal(a, b)`.

## 3.0.0

### Minor Changes

- 54fce13: `CompositeTransport.addTransport()`: graft a transport onto a running
  composite. It is started and receives the current identity and joined topic,
  reaching parity with the existing transports. Lets a node that booted offline
  attach the link to a well-known peer later (once its address/key resolves)
  without restarting.

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

## 1.0.0
