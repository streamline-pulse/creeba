---
"@streamline-pulse/creeba-mesh": patch
---

Serve pull replies in size-bounded `ops` batches (1 MiB by default, `maxBatchBytes` option) instead of one message. A whole-org catch-up above the transport frame limit was dropped by the receiver, which cut the peer and replayed the same oversized reply forever.
