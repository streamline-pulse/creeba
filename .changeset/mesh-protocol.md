---
"@streamline-pulse/creeba-mesh": minor
---

The mesh protocol itself: trust evaluation, org scoping, catch-up and gossip.

- **`PeerTrust`** — evaluates the certificates a peer announces and keeps the
  trusted set. One valid certificate is enough; an expired or foreign one no
  longer sinks the others. Re-evaluated on every announcement, since a peer may
  have joined a new org since.
- **`mayServe` / `mayAccept`** — org scoping. Trust says who may talk, scoping
  says what they may hear: a peer trusted for org A never receives org B's ops.
- **`MeshSync`** — ties it together over an existing `CreebaSync` and op-log:
  pull/push catch-up on connect, multi-hop gossip, and multi-pass application so
  an op whose dependency has not landed yet is retried instead of dropped.
  `onData` returns `false` for non-mesh messages, so the app keeps its own on the
  same channel.
- **`onPeers`** forgets peers that have disappeared. Two consequences: we stop
  broadcasting into the void, and a peer that reconnects is treated as new — so
  a healed partition catches up immediately instead of waiting for the next tick.

The app keeps its transport, its storage and its message types; the journal is
seen through a three-method port (`ready` / `list` / `apply`).
