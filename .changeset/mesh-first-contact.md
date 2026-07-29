---
"@streamline-pulse/creeba-mesh": patch
---

First contact no longer wastes a round trip, and no op crosses the wire twice.

Verifying a signature is asynchronous, so a peer's first frame could overtake
its own `hello`: the message arrived while trust was still being evaluated and
was dropped as "unknown peer". The data was only recovered on the next periodic
catch-up, up to twenty seconds later. `onData` now awaits an evaluation already
in flight for that peer — and only one already started, so an unknown peer still
gets nothing.

With that race gone, `pushOpsTo` became redundant and is removed: answering a
peer's `pull` already sends it exactly what it lacks, computed from the vector
*it* declared. Pushing our journal on top sent the same ops a second time, since
the peer's vector predated the push.

`announce()` now re-pulls from trusted peers. It is the one case a `pull` alone
does not cover: when OUR certificates change, peers that refused us start
accepting us, but our own trust in them has not grown — so nothing would have
asked again, and our earlier requests had been dropped.
