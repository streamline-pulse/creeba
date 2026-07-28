---
title: Trust with the mesh
description: Membership certificates verified offline, org scoping, catch-up and gossip.
---

The [core](../core/) moves payloads and the [op-log](../oplog/) makes state
converge — but neither asks *who is on the other end*. `@streamline-pulse/creeba-mesh`
answers that, and then runs the protocol on top: scoping, catch-up and gossip.

## A node is a key pair

Identity is an ed25519 key pair; the public key (hex) is the node-id peers see.
The default implementation is **pure JavaScript**, so it runs on Bun, Node,
browsers and React Native alike:

```ts
import { nobleCrypto } from '@streamline-pulse/creeba-mesh'

const secretKey = await nobleCrypto.generateSecretKey()  // persist this
const nodeId = await nobleCrypto.publicKeyOf(secretKey)
```

If the node already holds an ed25519 identity — `creeba-iroh-mdns` for instance —
plug it in instead of carrying a second key pair. Same node-id, same signatures:

```ts
import { generateSecretKey, publicKeyOf, sign, verify } from '@streamline-pulse/creeba-iroh-mdns'

const irohCrypto = { generateSecretKey, publicKeyOf, sign, verify }
```

## Membership, verified offline

A `MembershipCert` is **self-contained**: an issuer vouches for a node, for a set
of orgs, until an expiry. Verification needs local **trust anchors** and nothing
else — no directory, no CA, no round-trip. A laptop with no internet still tells
friend from stranger.

```ts
import { signMembership, verifyMembership } from '@streamline-pulse/creeba-mesh'

const signed = await signMembership(orgSecretKey, {
  v: 1,
  iss: orgPublicKey,        // an org key vouches for ITS org only
  nodePublicKey: joinerId,
  userId,
  orgIds: ['org-a'],
  superPeer: false,
  iat: now, exp: now + 30 * 24 * 3600,
})

const verdict = await verifyMembership(signed, {
  peerId: joinerId,
  anchors: { orgKeys: new Map([['org-a', orgPublicKey]]), superPeerKey: null },
  myOrgIds: ['org-a'],
  now,
})
// { ok: true, orgIds: ['org-a'] } — or { ok: false, reason: 'expired' }
```

`orgIds` in the verdict are the orgs the certificate is **authoritative** for,
not the ones it claims: an org key that vouches for someone else's org is simply
ignored.

An optional `superPeerKey` is a global authority — useful when a cloud node
relays between sites — but it stays *optional*: a LAN-only mesh has none.

### Revocation

Give certificates an `id` (`randomCertId()`) and you can drop one without
banning the node — a re-issued device, a rotated key. `revokedNodeKeys` is the
blunter tool: every certificate naming that node is refused.

```ts
anchors.revokedCertIds = new Set([oldCert.id])
anchors.revokedNodeKeys = new Set([stolenLaptopNodeId])
```

## The protocol

`MeshSync` wires trust to the journal: it evaluates peers, scopes operations by
org, catches up on connect and gossips the rest. It owns none of the plumbing —
the app keeps its transport, its journal and its own message types.

```ts
import { MeshSync } from '@streamline-pulse/creeba-mesh'

const mesh = new MeshSync({
  sync,                                   // a CreebaSync
  journal: {                              // your op-log, seen narrowly
    ready,
    list: (opts) => store.list(opts),
    apply: (op) => oplog.applyRemote(op, projection),
  },
  anchors: () => myAnchors,               // re-read at every evaluation
  myOrgIds: () => myOrgs,
})

sync.on('peer', (peer) => void mesh.onPeer(peer))
sync.on('peers', (peers) => void mesh.onPeers(peers))
sync.on('data', (msg, from) => from && void mesh.onData(msg, from))
oplog.onLocalOp((op) => mesh.onLocalOp(op))
mesh.start()                              // periodic catch-up
```

`onData` returns `false` for anything that is not a mesh message, so your own
messages keep flowing on the same channel.

**Scoping.** Trust says who may talk; scoping says what they may hear. A peer
trusted for org A never receives org B's operations, even as a legitimate member
of the mesh. Only a super-peer carries everything.

**Catch-up.** Trusting a peer triggers a pull *and* a push, so a device that was
just paired receives its history immediately instead of waiting for a tick.
Feeding `onPeers` matters here: a peer that disappears is forgotten, so when it
comes back it is treated as new and catches up at once.

**Gossip.** Applied operations are relayed to the other peers concerned, so two
nodes that cannot see each other still converge through a common one. HLC dedup
stops the propagation — it terminates even on a cyclic mesh.

## Pairing

Joining an org offline: the admin issues an invite (a string to copy — a QR code
is just one way to render it), the joiner redeems it and asks a peer for a
certificate. Security rests on the secret of the token; the six-digit
`confirmationCode` is a human check against a wrong org or a wrong peer, not a
second factor.

```ts
import { encodeInvite, decodeInvite, confirmationCode } from '@streamline-pulse/creeba-mesh'
```
