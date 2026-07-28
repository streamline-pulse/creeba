/**
 * Trust layer of a Creeba mesh. A node is an ed25519 key pair; it proves its
 * membership with a SELF-CONTAINED certificate, verified offline against local
 * trust anchors. No server, no CA, no round-trip — a laptop with no internet
 * can still tell friend from stranger.
 *
 *   import { nobleCrypto, signMembership, verifyMembership } from "@streamline-pulse/creeba-mesh";
 *
 * The crypto is injectable: a node already holding an ed25519 identity (iroh,
 * a keychain, a hardware token) plugs it in instead of carrying a second key
 * pair. The formats — hex node-id, raw 64-byte signature — are the same either
 * way, so certificates cross implementations.
 */
export { nobleCrypto, bytesToHex, hexToBytes } from "./crypto.ts";
export type { Awaitable, NodeCrypto } from "./crypto.ts";
export {
  randomCertId,
  signMembership,
  verifyMembership,
  verifyMembershipSignature,
} from "./certs.ts";
export type {
  MembershipCert,
  MembershipVerdict,
  RejectionReason,
  SignedMembership,
  TrustAnchors,
  VerifyOptions,
} from "./certs.ts";
export {
  confirmationCode,
  decodeInvite,
  encodeInvite,
} from "./pairing.ts";
export type { Invite, JoinerProfile, PairingMsg } from "./pairing.ts";
