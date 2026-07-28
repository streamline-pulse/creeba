import * as ed from "@noble/ed25519";

/**
 * Identity primitives of a mesh node. A node IS its ed25519 key pair: the
 * public key (hex, 64 chars) is the node-id peers see on the wire.
 *
 * The implementation is INJECTABLE so a node can reuse the signer it already
 * has — a native one (iroh), the platform keychain, a hardware token — instead
 * of a second key pair. Whatever the implementation, the format is the same
 * (hex node-id, raw 64-byte signature), so a certificate signed on one node
 * verifies on any other.
 */
export interface NodeCrypto {
  /** Fresh 32-byte private key, to be persisted by the app. */
  generateSecretKey(): Awaitable<number[]>;
  /** Node-id (hex public key) of a private key. */
  publicKeyOf(secretKey: number[]): Awaitable<string>;
  /** Raw 64-byte ed25519 signature of `message`. */
  sign(secretKey: number[], message: Uint8Array): Awaitable<number[]>;
  /** Never throws: an ill-formed key or signature is simply invalid. */
  verify(
    publicKey: string,
    message: Uint8Array,
    signature: number[],
  ): Awaitable<boolean>;
}

export type Awaitable<T> = T | Promise<T>;

const HEX = /^[0-9a-f]+$/i;

export function bytesToHex(bytes: Uint8Array | number[]): string {
  let out = "";
  for (const b of bytes) out += (b & 0xff).toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Default implementation: pure JavaScript, no native binding — it runs on Bun,
 * Node, browsers and React Native alike. Wire-compatible with iroh: same
 * node-id for the same private key, and signatures verify across both.
 */
export const nobleCrypto: NodeCrypto = {
  generateSecretKey: () => Array.from(ed.utils.randomSecretKey()),

  publicKeyOf: async (secretKey) =>
    bytesToHex(await ed.getPublicKeyAsync(Uint8Array.from(secretKey))),

  sign: async (secretKey, message) =>
    Array.from(await ed.signAsync(message, Uint8Array.from(secretKey))),

  verify: async (publicKey, message, signature) => {
    try {
      return await ed.verifyAsync(
        Uint8Array.from(signature),
        message,
        hexToBytes(publicKey),
      );
    } catch {
      return false;
    }
  },
};
