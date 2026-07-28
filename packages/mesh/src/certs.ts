import * as ed from "@noble/ed25519";
import { bytesToHex, nobleCrypto, type NodeCrypto } from "./crypto.ts";

/**
 * Membership certificate. `iss` is the issuer's public key: either an
 * organisation key (authoritative for ITS org only), or the super-peer key
 * (optional global authority, typically a cloud node). The certificate is
 * self-contained and verifiable OFFLINE — no directory, no CA, no round-trip.
 */
export interface MembershipCert {
  v: 1;
  /**
   * Certificate identifier. Optional for backward compatibility, but required
   * to revoke THIS certificate alone (re-issued device, rotated key…) without
   * banning the node.
   */
  id?: string;
  iss: string;
  nodePublicKey: string;
  userId: string;
  orgIds: string[];
  superPeer: boolean;
  iat: number;
  exp: number;
}

export interface SignedMembership {
  cert: MembershipCert;
  signature: number[];
}

/** Trust anchors of a node: keys of the orgs it belongs to, plus revocations. */
export interface TrustAnchors {
  /** orgId -> org public key. The authority for that org, and only that one. */
  orgKeys: Map<string, string>;
  /** Optional global authority. `null` on a pure LAN mesh. */
  superPeerKey: string | null;
  /** Revoked certificates (by `cert.id`). */
  revokedCertIds?: ReadonlySet<string>;
  /** Revoked nodes: every certificate naming this node-id is refused. */
  revokedNodeKeys?: ReadonlySet<string>;
}

/**
 * Why a certificate was refused. Purely informational — a rejection is a
 * rejection — but a mesh that says "no" without saying why is a mesh you debug
 * blind.
 */
export type RejectionReason =
  | "bad-signature"
  | "peer-mismatch"
  | "expired"
  | "revoked"
  | "untrusted-issuer"
  | "no-shared-org";

export type MembershipVerdict =
  | { ok: true; orgIds: string[] }
  | { ok: false; orgIds: string[]; reason: RejectionReason };

export interface VerifyOptions {
  /** Node-id of the peer presenting the certificate (it must be its subject). */
  peerId: string;
  anchors: TrustAnchors;
  /** Orgs the VERIFIER belongs to. Empty on a super-peer. */
  myOrgIds: string[];
  /** Current time, in SECONDS (same unit as `iat`/`exp`). */
  now: number;
  /**
   * The VERIFIER is a super-peer: it is authoritative for every org and owns
   * none of its own, so the "share an org" requirement does not apply to it.
   * Without this, a super-peer refuses every member certificate… including the
   * ones it signed itself.
   */
  verifierIsSuperPeer?: boolean;
  crypto?: NodeCrypto;
}

/** Random certificate identifier, for later revocation. */
export function randomCertId(): string {
  return bytesToHex(ed.etc.randomBytes(16));
}

/**
 * Signed bytes. Canonical form: fixed field order and sorted `orgIds`, so the
 * same certificate always yields the same bytes whatever produced the object.
 * An absent `id` simply disappears from the JSON — certificates issued before
 * revocation existed keep verifying.
 */
function canonicalBytes(cert: MembershipCert): Uint8Array {
  const ordered = {
    v: cert.v,
    id: cert.id,
    iss: cert.iss,
    nodePublicKey: cert.nodePublicKey,
    userId: cert.userId,
    orgIds: [...cert.orgIds].sort(),
    superPeer: cert.superPeer,
    iat: cert.iat,
    exp: cert.exp,
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/** Sign a certificate. `cert.iss` must be the public key of `issuerSecretKey`. */
export async function signMembership(
  issuerSecretKey: number[],
  cert: MembershipCert,
  crypto: NodeCrypto = nobleCrypto,
): Promise<SignedMembership> {
  return { cert, signature: await crypto.sign(issuerSecretKey, canonicalBytes(cert)) };
}

/** Valid signature under the declared issuer, expected node, and not expired. */
export async function verifyMembershipSignature(
  signed: SignedMembership,
  connectingPeerId: string,
  nowSeconds: number,
  crypto: NodeCrypto = nobleCrypto,
): Promise<RejectionReason | null> {
  const valid = await crypto.verify(
    signed.cert.iss,
    canonicalBytes(signed.cert),
    signed.signature,
  );
  if (!valid) return "bad-signature";
  if (signed.cert.nodePublicKey !== connectingPeerId) return "peer-mismatch";
  if (signed.cert.exp <= nowSeconds) return "expired";
  return null;
}

function isRevoked(cert: MembershipCert, anchors: TrustAnchors): boolean {
  if (cert.id && anchors.revokedCertIds?.has(cert.id)) return true;
  return anchors.revokedNodeKeys?.has(cert.nodePublicKey) ?? false;
}

/**
 * Trust decision. Returns the orgs the certificate is AUTHORITATIVE for (the
 * super-peer vouches for every org it declares; an org key vouches for its own
 * org only), and whether at least one org is shared with the verifier.
 */
export async function verifyMembership(
  signed: SignedMembership,
  opts: VerifyOptions,
): Promise<MembershipVerdict> {
  const { peerId, anchors, myOrgIds, now, verifierIsSuperPeer = false } = opts;

  const bad = await verifyMembershipSignature(
    signed,
    peerId,
    now,
    opts.crypto ?? nobleCrypto,
  );
  if (bad) return { ok: false, orgIds: [], reason: bad };
  if (isRevoked(signed.cert, anchors))
    return { ok: false, orgIds: [], reason: "revoked" };

  const iss = signed.cert.iss;
  const mine = new Set(myOrgIds);

  if (anchors.superPeerKey && iss === anchors.superPeerKey) {
    const orgIds = signed.cert.orgIds;
    if (signed.cert.superPeer) return { ok: true, orgIds };
    const shared = verifierIsSuperPeer || orgIds.some((o) => mine.has(o));
    return shared ? { ok: true, orgIds } : { ok: false, orgIds, reason: "no-shared-org" };
  }

  const authorized = signed.cert.orgIds.filter(
    (o) => anchors.orgKeys.get(o) === iss,
  );
  if (authorized.length === 0)
    return { ok: false, orgIds: [], reason: "untrusted-issuer" };
  if (!verifierIsSuperPeer && !authorized.some((o) => mine.has(o)))
    return { ok: false, orgIds: authorized, reason: "no-shared-org" };
  return { ok: true, orgIds: authorized };
}
