---
title: Convergence with the op-log
description: Turn mutations into a mergeable journal (HLC + LWW), independent of any database.
---

`@streamline-pulse/creeba-oplog` turns mutations into an ordered, mergeable
journal — a hybrid logical clock plus last-writer-wins convergence — independent
of any database. The app implements two interfaces, or plugs in a ready binding:

- **`OpStore`** — journal persistence (append, list, clock).
- **`Projection`** — domain-state writes (upsert, remove).

## Prisma binding

`@streamline-pulse/creeba-oplog-prisma` captures mutations transparently via a
Prisma `$extends`: every write to a syncable entity is journaled (scalar fields
only, relations dropped, secrets omitted), and it provides a ready `OpStore` +
`Projection`.

```ts
import { createOpLog } from '@streamline-pulse/creeba-oplog-prisma'

const { client, oplog, projection } = createOpLog(prisma, {
  nodeId,
  syncable: [
    { model: 'projects', entity: 'Projects', orgField: 'groupId' },
    // …
  ],
})

// Feed remote ops in, broadcast local ops out — over creeba-core:
oplog.onLocalOp((op) => sync.broadcast(op))
sync.on('data', (op) => oplog.applyRemote(op, projection))
```

Use the domain client (`client`) in your data sources — capture is transparent,
the rest of the app is unchanged. One schema covers relational connectors
(pg/mysql/sqlite/cockroach); a Mongo variant (synthetic key) is provided.

The op-log and the [transport](../transport/) are independent: use the core alone
to move payloads, add the op-log when you need convergent state across nodes.
