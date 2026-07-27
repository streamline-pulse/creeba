---
"@streamline-pulse/creeba-iroh-mdns": minor
---

Add `bootstrapPeers` option to `IrohMdnsTransport`: node-ids that are always
connected and kept connected, dialed by node-id alone (no ticket, no mDNS).
iroh's n0 discovery resolves the address and relays handle NAT, so a node can
reach a well-known peer (e.g. a super-node) across the internet. A maintenance
loop redials on drop and tolerates being offline. `bootstrapIntervalMs`
(default 5000) tunes the loop. Purely additive; existing LAN/mDNS behaviour is
unchanged.
