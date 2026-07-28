---
"@streamline-pulse/creeba-core": minor
---

New `MemoryNetwork` / `MemoryTransport`: an in-process transport where nodes
exchange frames directly — no network, so multi-node scenarios are
deterministic and instant. Intended for tests, examples and demos; the
application protocol sees no difference from iroh or WebSocket. The network
can also simulate latency, `partition(a, b)` and `heal(a, b)`.
