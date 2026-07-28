import type { SignedMembership } from "./certs.ts";

/**
 * Local pairing onto an org (offline-first). An admin issues an invite — a
 * string to copy; a QR code is only one way to render it — and the joiner
 * redeems it by asking an admin node of the org for a certificate, over the
 * transport.
 *
 * Security rests on the SECRET of the token. The confirmation code is a human
 * check against mistakes (wrong org, wrong peer), not a second factor.
 */
export interface Invite {
  orgId: string;
  orgPublicKey: string;
  token: string;
  /** Expiry, in seconds. */
  exp: number;
}

/** Display profile of the joiner (sanitised — never a secret) sent to the grant. */
export interface JoinerProfile {
  userId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  avatar?: string | null;
}

export type PairingMsg =
  | { t: "join-request"; orgId: string; token: string; profile: JoinerProfile }
  | { t: "join-grant"; cert: SignedMembership };

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url, hand-rolled: `Buffer` is Node-only and `btoa` is latin1-only. */
function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64URL[c & 63];
  }
  return out;
}

function decodeBase64Url(text: string): Uint8Array {
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const value = B64URL.indexOf(ch);
    if (value < 0) {
      if (ch === "=") continue;
      throw new Error("invalid base64url");
    }
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function encodeInvite(invite: Invite): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(invite)));
}

/** `null` on anything unusable — a mistyped invite must not throw at the caller. */
export function decodeInvite(encoded: string): Invite | null {
  try {
    const invite = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encoded.trim())),
    ) as Invite;
    if (invite.orgId && invite.orgPublicKey && invite.token && invite.exp)
      return invite;
    return null;
  } catch {
    return null;
  }
}

/**
 * Six-digit code shown on BOTH sides for human confirmation. Derived from the
 * three values that identify this pairing, so it only matches when both sides
 * really are talking about the same one.
 */
export function confirmationCode(
  orgPublicKey: string,
  joinerNodeKey: string,
  token: string,
): string {
  const input = `${orgPublicKey}:${joinerNodeKey}:${token}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return String((hash >>> 0) % 1_000_000).padStart(6, "0");
}
