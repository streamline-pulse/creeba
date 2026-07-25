---
title: Getting started
description: Install Creeba and move your first payload between two peers.
---

Creeba is a local-first P2P layer: local databases stay local, and the network
only carries **opaque app payloads**. The message shape and its persistence
belong to your application.

## Install

```bash
# transport + core (Bun / desktop / server)
bun add @streamline-pulse/creeba-core @streamline-pulse/creeba-iroh-mdns

# convergence layer (optional)
bun add @streamline-pulse/creeba-oplog
bun add @streamline-pulse/creeba-oplog-prisma   # if you use Prisma
```

## Move a payload

The core is generic over the app payload `T`. You define your own message type
and handle persistence yourself.

```ts
import { CreebaSync } from '@streamline-pulse/creeba-core'
import { IrohMdnsTransport } from '@streamline-pulse/creeba-iroh-mdns'

interface ChatMessage { id: string; userId: string; body: string; ts: number }

const sync = new CreebaSync<ChatMessage>({
  transport: new IrohMdnsTransport<ChatMessage>(),
  identity: { userId: 'abc', metadata: { name: 'alice' } },
  topic: 'creeba-chat',
})

sync.on('data', (message, from) => {/* received from a peer → persist + display */})
sync.on('peer', (peer) => {/* a peer joined → good place to backfill history */})
sync.on('status', (s) => {/* s.ready, s.publicKey */})

const { publicKey } = await sync.start() // bind + join the topic
sync.broadcast({ id: '1', userId: 'abc', body: 'hi', ts: Date.now() })
```

## Two layers, independent

- **Transport + core** — move payloads between peers. See [Core](../guides/core/).
- **Op-log** — add convergent state (HLC + LWW) when a message log isn't enough.
  See [Convergence](../guides/oplog/).

Persistence is never part of a core — each app plugs its own store (DuckDB,
`bun:sqlite`, `expo-sqlite`, Prisma…).

## Discovery

Discovery in `creeba-iroh-mdns` is **mDNS = local network only**. The iroh
connection itself traverses the internet (QUIC holepunch + relays) once a peer's
ticket is known; WAN rendezvous is on the roadmap. See
[Transports & discovery](../guides/transport/).
