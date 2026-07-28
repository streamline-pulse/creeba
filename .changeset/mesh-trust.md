---
"@streamline-pulse/creeba-mesh": minor
---

New package: the trust layer of a Creeba mesh.

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
