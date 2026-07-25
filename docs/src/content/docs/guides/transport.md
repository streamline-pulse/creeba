---
title: Transports & discovery
description: The iroh + mDNS transport, LAN vs WAN discovery, and how to write your own transport.
---

A transport implements `SyncTransport`: it carries frames between peers and
ignores their semantics — the [core](../core/) does the rest.

## iroh + mDNS (Bun/Node)

`@streamline-pulse/creeba-iroh-mdns` provides encrypted QUIC (iroh: holepunch +
relay fallback) with **serverless mDNS discovery**. It also exposes ed25519
identity helpers (`generateSecretKey`, `publicKeyOf`, `sign`, `verify`).

```ts
import { IrohMdnsTransport } from '@streamline-pulse/creeba-iroh-mdns'

const transport = new IrohMdnsTransport({
  protocol: 'myapp/0',        // ALPN — peers connect only if it matches
  serviceType: 'myapp',       // mDNS service type
  secretKey,                  // persist it for a STABLE node-id across restarts
})
```

## Discovery: LAN today, WAN next

Discovery over mDNS is **local network only** — it does not cross routers. The
iroh **connection** itself already traverses the internet (QUIC holepunch +
public relays) *once you have a peer's ticket*; what mDNS provides is finding
that ticket on the LAN.

Internet (WAN) rendezvous is on the roadmap as a **separate** discovery package
(e.g. `creeba-iroh-dns` / bootstrap-ticket) layered over a shared `creeba-iroh`
transport core, so `creeba-iroh-mdns` stays the LAN variant and the public API is
unchanged.

## Writing a transport

Implement `SyncTransport`:

- `start()` — returns the local id
- `join(topic)`
- `setIdentity(identity)`
- `send(peerId, frame)`
- `broadcast(frame)`
- `destroy()`
- `on(event, cb)` — emits `peer-open` / `peer-close` / `frame` / `error`

The transport never interprets frame semantics (`hello` / `data`): it carries
frames, the core does the rest. This is how the mobile
[`creeba-expo`](../expo/) transport interoperates with desktop over the same wire
format.
