import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes } from "./crypto.ts";

/**
 * Symmetric authenticated encryption for field-level secrets — the piece an app
 * needs to keep values (connector passwords, tokens…) out of a synced journal
 * in plaintext. NOT a sealed box: there is no public-key recipient here, just a
 * shared 32-byte key the app distributes and stores as it sees fit (typically a
 * per-tenant data key, itself wrapped by a master key held outside the store).
 *
 * XChaCha20-Poly1305 with a random 192-bit nonce: collision-safe to generate at
 * random, and the Poly1305 tag makes any tampered ciphertext fail to open
 * rather than decrypt to garbage. The wire form is versioned so the algorithm
 * can change later without silently misreading old values.
 */

const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

function keyBytes(key: number[] | Uint8Array): Uint8Array {
  const bytes = key instanceof Uint8Array ? key : Uint8Array.from(key);
  if (bytes.length !== KEY_BYTES)
    throw new Error(`secret box: key must be ${KEY_BYTES} bytes, got ${bytes.length}`);
  return bytes;
}

/** Fresh 32-byte key, e.g. a per-tenant data-encryption key. */
export function newSecretKey(): number[] {
  return Array.from(randomBytes(KEY_BYTES));
}

/**
 * Encrypt a UTF-8 string. Output is hex: `version(1) || nonce(24) || ct+tag`.
 * A fresh random nonce per call — never reuse a (key, nonce) pair.
 */
export function encryptSecret(key: number[] | Uint8Array, plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(keyBytes(key), nonce).encrypt(
    new TextEncoder().encode(plaintext),
  );
  const out = new Uint8Array(1 + NONCE_BYTES + ct.length);
  out[0] = VERSION;
  out.set(nonce, 1);
  out.set(ct, 1 + NONCE_BYTES);
  return bytesToHex(out);
}

/**
 * Reverse of `encryptSecret`. Throws if the key is wrong, the version is
 * unknown, or the ciphertext was tampered with — never returns garbage.
 */
export function decryptSecret(key: number[] | Uint8Array, sealed: string): string {
  const bytes = hexToBytes(sealed);
  if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES)
    throw new Error("secret box: ciphertext too short");
  if (bytes[0] !== VERSION)
    throw new Error(`secret box: unsupported version ${bytes[0]}`);
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const ct = bytes.subarray(1 + NONCE_BYTES);
  const plain = xchacha20poly1305(keyBytes(key), nonce).decrypt(ct);
  return new TextDecoder().decode(plain);
}

/** True if `value` looks like an `encryptSecret` output (cheap, no key needed). */
export function isEncryptedSecret(value: unknown): boolean {
  if (typeof value !== "string" || value.length < 2) return false;
  if (value.length % 2 !== 0) return false;
  const minHex = (1 + NONCE_BYTES + TAG_BYTES) * 2;
  return value.length >= minHex && value.slice(0, 2) === "01" && /^[0-9a-f]+$/i.test(value);
}
