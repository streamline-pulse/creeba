---
"@streamline-pulse/creeba-oplog": minor
---

New `MemoryOpStore` / `MemoryProjection`: in-memory implementations of the two
app-provided ports. They don't replace real adapters (Prisma, IndexedDB…) —
they make convergence testable without a database: replay, field-level LWW and
multi-node exchanges become deterministic.
