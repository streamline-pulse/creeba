# @streamline-pulse/creeba-mesh

## 6.0.1

### Patch Changes

- c378820: Serve pull replies in size-bounded `ops` batches (1 MiB by default, `maxBatchBytes` option) instead of one message. A whole-org catch-up above the transport frame limit was dropped by the receiver, which cut the peer and replayed the same oversized reply forever.
  - @streamline-pulse/creeba-core@6.0.1
  - @streamline-pulse/creeba-oplog@6.0.1

## 6.0.0

### Minor Changes

- b498679: feat(mesh): `encryptSecret`/`decryptSecret` (XChaCha20-Poly1305) + `newSecretKey`/`isEncryptedSecret` — chiffrement symétrique authentifié pour garder des secrets de champ (mots de passe de connecteurs, tokens) hors d'un journal synchronisé en clair. Format versionné, nonce aléatoire de 192 bits, ciphertext falsifié rejeté à l'ouverture.

  feat(mesh): le message de pairing `join-grant` porte un champ optionnel `secrets` (Record opaque) pour livrer du matériel secret d'app (ex. une clé de données d'org) avec le cert, sur le canal de pairing authentifié.

### Patch Changes

- b54f20b: fix(mesh): le cloisonnement par org vaut aussi à la RÉCEPTION — un op n'est appliqué que si l'expéditeur est de confiance pour son org (`mayServe` sur le pair émetteur, en plus de `mayAccept`). Avant, un nœud multi-org pouvait servir de point d'injection vers une org que le pair émetteur ne couvrait pas. Supprime aussi `servedTo`/`noteServed`, état write-only resté après le retrait de `pushOpsTo`.
  - @streamline-pulse/creeba-core@6.0.0
  - @streamline-pulse/creeba-oplog@6.0.0

## 5.0.1

### Patch Changes

- 540e543: First contact no longer wastes a round trip, and no op crosses the wire twice.

  Verifying a signature is asynchronous, so a peer's first frame could overtake
  its own `hello`: the message arrived while trust was still being evaluated and
  was dropped as "unknown peer". The data was only recovered on the next periodic
  catch-up, up to twenty seconds later. `onData` now awaits an evaluation already
  in flight for that peer — and only one already started, so an unknown peer still
  gets nothing.

  With that race gone, `pushOpsTo` became redundant and is removed: answering a
  peer's `pull` already sends it exactly what it lacks, computed from the vector
  _it_ declared. Pushing our journal on top sent the same ops a second time, since
  the peer's vector predated the push.

  `announce()` now re-pulls from trusted peers. It is the one case a `pull` alone
  does not cover: when OUR certificates change, peers that refused us start
  accepting us, but our own trust in them has not grown — so nothing would have
  asked again, and our earlier requests had been dropped.

  - @streamline-pulse/creeba-core@5.0.1
  - @streamline-pulse/creeba-oplog@5.0.1

## 5.0.0

### Minor Changes

- 01766c3: Incremental catch-up: a `pull` now carries a **version vector** and gets back
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

### Patch Changes

- Updated dependencies [b76199e]
  - @streamline-pulse/creeba-oplog@5.0.0
  - @streamline-pulse/creeba-core@5.0.0

## 4.0.0

### Minor Changes

- 3365bbf: The mesh protocol itself: trust evaluation, org scoping, catch-up and gossip.

  - **`PeerTrust`** — evaluates the certificates a peer announces and keeps the
    trusted set. One valid certificate is enough; an expired or foreign one no
    longer sinks the others. Re-evaluated on every announcement, since a peer may
    have joined a new org since.
  - **`mayServe` / `mayAccept`** — org scoping. Trust says who may talk, scoping
    says what they may hear: a peer trusted for org A never receives org B's ops.
  - **`MeshSync`** — ties it together over an existing `CreebaSync` and op-log:
    pull/push catch-up on connect, multi-hop gossip, and multi-pass application so
    an op whose dependency has not landed yet is retried instead of dropped.
    `onData` returns `false` for non-mesh messages, so the app keeps its own on the
    same channel.
  - **`onPeers`** forgets peers that have disappeared. Two consequences: we stop
    broadcasting into the void, and a peer that reconnects is treated as new — so
    a healed partition catches up immediately instead of waiting for the next tick.

  The app keeps its transport, its storage and its message types; the journal is
  seen through a three-method port (`ready` / `list` / `apply`).

- 29ccd74: New package: the trust layer of a Creeba mesh.

  A node is an ed25519 key pair and proves its membership with a self-contained
  `MembershipCert`, verified **offline** against local `TrustAnchors` — no server,
  no CA, no round-trip. An org key vouches for its own org only; an optional
  super-peer key vouches globally.

  - `NodeCrypto` is **injectable**, with a pure-JS default (`nobleCrypto`) that
    runs on Bun, Node, browsers and React Native. It is wire-compatible with
    `creeba-iroh-mdns`: same node-id for a given private key, signatures verify
    across both — so a desktop node and a browser node recognise each other.
  - **Revocation**: `revokedCertIds` drops a single certificate (re-issued device)
    without banning the node; `revokedNodeKeys` bans the node outright.
  - A refusal now says **why** (`bad-signature`, `peer-mismatch`, `expired`,
    `revoked`, `untrusted-issuer`, `no-shared-org`) instead of a bare `false`.
  - Local pairing: `encodeInvite` / `decodeInvite` / `confirmationCode`, with a
    portable base64url (no `Buffer`).

### Patch Changes

- Updated dependencies [c02ca4d]
- Updated dependencies [cb0156e]
  - @streamline-pulse/creeba-oplog@4.0.0
  - @streamline-pulse/creeba-core@4.0.0
