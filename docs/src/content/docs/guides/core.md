---
title: Core & payloads
description: Move opaque payloads between peers with CreebaSync, and backfill history on join.
---

`@streamline-pulse/creeba-core` (`CreebaSync`) is the portable orchestrator:
identity, presence, peer list, and routing of opaque payloads over a pluggable
`SyncTransport`. It has no native dependency, so it runs from Bun, Node, the
browser or React Native.

## Events

```ts
sync.on('data', (message, from) => {/* received from a peer */})
sync.on('peer', (peer) => {/* a peer was identified */})
sync.on('peers', (peers) => {/* full peer list changed */})
sync.on('status', (s) => {/* s.ready, s.publicKey */})
```

## Backfilling history on join

The core carries only live payloads and stores nothing, so replaying the history
a late peer missed is an **app concern**. `CreebaSync` gives you the hook — the
`peer` event — and point-to-point `send(peerId, payload)`; the app owns the
cursor, ordering and dedup.

The recommended shape is a **pull** (request/response) inside your own payload
union:

```ts
type Wire =
  | { t: 'msg'; msg: ChatMessage }
  | { t: 'sync-req'; since: number }        // requester's cursor
  | { t: 'sync-res'; items: ChatMessage[] }

// On join, ask the new peer for what we're missing.
sync.on('peer', (peer) => sync.send(peer.peerId, { t: 'sync-req', since: store.latestTs() }))

sync.on('data', (frame, from) => {
  if (frame.t === 'sync-req' && from) sync.send(from.peerId, { t: 'sync-res', items: store.since(frame.since) })
  else if (frame.t === 'sync-res') for (const m of frame.items) store.insert(m) // idempotent by id
  else if (frame.t === 'msg') store.insert(frame.msg)
})
```

Dedup by message `id` (idempotent inserts) makes this robust even if several
peers answer. For **convergent state** (not just a message log), use the
[op-log](../oplog/) instead of hand-rolling the merge.
