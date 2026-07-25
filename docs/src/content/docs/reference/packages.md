---
title: Packages
description: The Creeba packages, what they do, and their native dependencies.
---

All packages are published under the `@streamline-pulse` scope.

| Package | What it is | Native deps |
|---|---|---|
| `@streamline-pulse/creeba-core` | Portable P2P core: identity, presence, peers, routing of opaque payloads over a pluggable `SyncTransport`. | none |
| `@streamline-pulse/creeba-iroh-mdns` | Bun/Node transport: encrypted QUIC (iroh, holepunch + relay) with LAN discovery over mDNS, serverless. + ed25519 identity helpers. | `@number0/iroh` |
| `@streamline-pulse/creeba-expo` | Mobile transport (Expo/React Native): native iroh via `iroh-ffi` (Swift/Kotlin), same ALPN + wire format as desktop. | native module |
| `@streamline-pulse/creeba-oplog` | Portable op-log: hybrid logical clock, operation journal, LWW convergence. Persistence-agnostic. | none |
| `@streamline-pulse/creeba-oplog-prisma` | Prisma binding for the op-log: transparent mutation capture (`$extends`), ready-made `OpStore` + `Projection`. | Prisma (peer) |

## Layered architecture

```
Your app
├── CreebaSync (creeba-core)          — portable, no native dependency
│     └── SyncTransport  ← P2P network (pluggable)
│           ├── IrohMdnsTransport  (creeba-iroh-mdns)  — Bun/desktop/server, LAN
│           └── IrohExpoTransport  (creeba-expo)       — mobile, same wire format
└── OpLog (creeba-oplog)              — optional convergence layer (HLC + LWW)
      ├── OpStore     ← journal persistence (pluggable)
      └── Projection  ← domain-state writes (pluggable)
            └── creeba-oplog-prisma   — a ready OpStore + Projection over Prisma
```

The two layers are independent: use `creeba-core` alone to move payloads, add
`creeba-oplog` when you need convergent state across nodes.

## Versioning & release

This is a Bun-workspace monorepo with a shared dependency catalog and coordinated
versioning via [changesets](https://github.com/changesets/changesets). Internal
deps use the `workspace:*` protocol (rewritten to the concrete version at
publish). See the repository README for the build & publish flow.
