import { verifyMembership, type RejectionReason, type SignedMembership, type TrustAnchors } from "./certs.ts";
import type { NodeCrypto } from "./crypto.ts";

/**
 * A peer whose membership has been verified. `orgIds` are the orgs its
 * certificates are AUTHORITATIVE for — not the ones they claim.
 */
export interface TrustedPeer {
  peerId: string;
  userId: string;
  orgIds: string[];
  superPeer: boolean;
}

export type TrustResult =
  | { ok: true; peer: TrustedPeer; grew: boolean }
  | { ok: false; reason: RejectionReason | "no-membership" };

export interface PeerTrustOptions {
  /** Read at every evaluation: anchors change when we join or found an org. */
  anchors: () => TrustAnchors;
  /** Orgs WE belong to. Empty on a super-peer. */
  myOrgIds: () => string[];
  /** This node is a super-peer (authoritative for every org, owns none). */
  isSuperPeer?: boolean;
  crypto?: NodeCrypto;
  /** Current time in seconds. Injectable so tests can move it. */
  now?: () => number;
}

/**
 * Who is allowed in. Keeps the set of trusted peers and re-evaluates it on every
 * announcement — a peer already trusted may have joined a NEW org since, and its
 * orgs must then be merged rather than left stale.
 */
export class PeerTrust {
  private readonly trusted = new Map<string, TrustedPeer>();
  private readonly now: () => number;

  constructor(private readonly options: PeerTrustOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Verify the certificates a peer presents. A peer is trusted as soon as ONE
   * certificate holds — several may be presented (one per org), and an expired
   * or foreign one must not sink the others.
   */
  async evaluate(
    peerId: string,
    memberships: SignedMembership[],
  ): Promise<TrustResult> {
    if (memberships.length === 0) return { ok: false, reason: "no-membership" };

    const anchors = this.options.anchors();
    const myOrgIds = this.options.myOrgIds();
    const now = this.now();
    const orgs = new Set<string>();
    let superPeer = false;
    let userId = "";
    let lastReason: RejectionReason = "untrusted-issuer";

    for (const signed of memberships) {
      const verdict = await verifyMembership(signed, {
        peerId,
        anchors,
        myOrgIds,
        now,
        verifierIsSuperPeer: this.options.isSuperPeer ?? false,
        crypto: this.options.crypto,
      });
      if (!verdict.ok) {
        lastReason = verdict.reason;
        continue;
      }
      verdict.orgIds.forEach((o) => orgs.add(o));
      if (signed.cert.superPeer) superPeer = true;
      userId = signed.cert.userId;
    }

    if (orgs.size === 0 && !superPeer) return { ok: false, reason: lastReason };

    const existing = this.trusted.get(peerId);
    // "Grew" gates the expensive catch-up: a re-announcement that brings nothing
    // new must not re-push the whole journal.
    const grew = !existing || orgs.size > existing.orgIds.length;
    const peer: TrustedPeer = { peerId, userId, orgIds: [...orgs], superPeer };
    this.trusted.set(peerId, peer);
    return { ok: true, peer, grew };
  }

  peers(): TrustedPeer[] {
    return [...this.trusted.values()];
  }

  get(peerId: string): TrustedPeer | undefined {
    return this.trusted.get(peerId);
  }

  has(peerId: string): boolean {
    return this.trusted.has(peerId);
  }

  forget(peerId: string): boolean {
    return this.trusted.delete(peerId);
  }

  get size(): number {
    return this.trusted.size;
  }
}
