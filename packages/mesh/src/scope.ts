import type { Op } from "@streamline-pulse/creeba-oplog";
import type { TrustedPeer } from "./peers.ts";

/**
 * Org scoping. Trust says WHO may talk; scoping says WHAT they may hear. Both
 * are needed: a peer trusted for org A must never receive org B's operations,
 * even though it is a perfectly legitimate member of the mesh.
 */

/** May we serve this op to that peer? A super-peer relays everything. */
export function mayServe(op: Op, peer: TrustedPeer): boolean {
  return peer.superPeer || (!!op.orgId && peer.orgIds.includes(op.orgId));
}

/**
 * May we apply an incoming op? An op with no `orgId` belongs to no org and is
 * therefore unscopable — only a super-peer, which carries everything, keeps it.
 */
export function mayAccept(
  op: Op,
  myOrgIds: string[],
  isSuperPeer = false,
): boolean {
  if (isSuperPeer) return true;
  return !!op.orgId && myOrgIds.includes(op.orgId);
}
