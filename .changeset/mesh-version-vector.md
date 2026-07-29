---
"@streamline-pulse/creeba-mesh": minor
---

Incremental catch-up: a `pull` now carries a **version vector** and gets back
only the delta.

Until now every catch-up asked for — and served — the entire journal, every
twenty seconds, forever. `sinceHlc` existed in the protocol but nothing ever set
it.

A single global cursor would have been simpler and **wrong**: ops are ordered by
HLC, not by arrival, so a peer can learn an old op from a third node long after
we passed that point — and the periodic catch-up exists precisely for those
cases. The cursor is therefore per origin node (`have: { nodeId: hlc }`), which
has no such gap.

- `pushOpsTo` is bounded too, by what the peer last declared it holds, so a
  reconnection replays the delta instead of the whole journal. That matters now
  that a departed peer is forgotten and reconnections are frequent.
- The vector is rebuilt from the journal **once** at startup, then maintained
  incrementally — a catch-up never reads the whole journal again.
- Wire-compatible: `sinceHlc` is still sent, and a peer that announces no vector
  is served everything as before. A fleet can update one node at a time.
