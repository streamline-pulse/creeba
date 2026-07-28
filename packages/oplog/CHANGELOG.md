# @streamline-pulse/creeba-oplog

## 4.0.0

### Minor Changes

- c02ca4d: New `MemoryOpStore` / `MemoryProjection`: in-memory implementations of the two
  app-provided ports. They don't replace real adapters (Prisma, IndexedDB…) —
  they make convergence testable without a database: replay, field-level LWW and
  multi-node exchanges become deterministic.

## 3.0.0

## 2.0.0

## 1.0.0
