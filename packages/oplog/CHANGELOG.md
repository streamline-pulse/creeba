# @streamline-pulse/creeba-oplog

## 5.0.0

### Minor Changes

- b76199e: New `compact(ops, { before })`: journal garbage collection.

  Without it the journal only grows — and it is what gets replayed on every
  rebuild and served to every peer catching up.

  One guarantee, and it is the only one that matters: **replaying `keep` yields
  exactly the same state as replaying everything.** An op is dropped only when it
  can no longer influence anything — every field it sets has been rewritten since,
  or its row was deleted after it. The newest tombstone of a deleted row is kept
  forever: without it an older write would resurrect the row.

  `before` is a safety window: nothing more recent is touched. Useful because
  compaction is not free for the mesh — a peer that never saw the dropped ops will
  ask for them and get nothing back. It still converges (the surviving ops carry
  the final state), but a window avoids the round trip while a fleet catches up.

  The function is **pure** — it writes nothing, and returns `{ keep, drop }`. The
  app deletes as it sees fit, so the `OpStore` port stays free of deletion.

  Covered by 12 tests, including 200 randomised write/delete sequences replayed
  against the uncompacted state.

## 4.0.0

### Minor Changes

- c02ca4d: New `MemoryOpStore` / `MemoryProjection`: in-memory implementations of the two
  app-provided ports. They don't replace real adapters (Prisma, IndexedDB…) —
  they make convergence testable without a database: replay, field-level LWW and
  multi-node exchanges become deterministic.

## 3.0.0

## 2.0.0

## 1.0.0
