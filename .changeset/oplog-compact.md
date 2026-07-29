---
"@streamline-pulse/creeba-oplog": minor
---

New `compact(ops, { before })`: journal garbage collection.

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
