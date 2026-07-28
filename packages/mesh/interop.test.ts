import { describe, expect, it } from "bun:test";
import {
  generateSecretKey,
  publicKeyOf,
  sign,
  verify,
} from "@streamline-pulse/creeba-iroh-mdns";
import {
  nobleCrypto,
  signMembership,
  verifyMembership,
  type MembershipCert,
  type NodeCrypto,
} from "./src/index.ts";

/**
 * Interopérabilité : la crypto JS pure par défaut et la crypto NATIVE d'iroh
 * doivent être la MÊME crypto. Sans ça, un desktop (iroh) et un pair
 * navigateur/mobile (JS pur) ne pourraient pas se reconnaître — la promesse
 * « le certificat se vérifie partout » tomberait.
 */

/** Adaptateur : l'identité iroh existante branchée sur l'interface du maillage. */
const irohCrypto: NodeCrypto = {
  generateSecretKey,
  publicKeyOf,
  sign,
  verify,
};

const NOW = 1_800_000_000;

describe("interop iroh ↔ JS pur", () => {
  it("dérive le MÊME node-id depuis la même clé privée", async () => {
    const secretKey = generateSecretKey();
    expect(await nobleCrypto.publicKeyOf(secretKey)).toBe(publicKeyOf(secretKey));
  });

  it("une clé générée en JS pur est utilisable par iroh", async () => {
    const secretKey = await nobleCrypto.generateSecretKey();
    expect(publicKeyOf(secretKey)).toBe(await nobleCrypto.publicKeyOf(secretKey));
  });

  it("les signatures se vérifient dans les deux sens", async () => {
    const secretKey = generateSecretKey();
    const publicKey = publicKeyOf(secretKey);
    const message = new TextEncoder().encode("bonjour maillage");

    expect(
      await nobleCrypto.verify(publicKey, message, sign(secretKey, message)),
    ).toBe(true);
    expect(
      verify(publicKey, message, await nobleCrypto.sign(secretKey, message)),
    ).toBe(true);
  });

  it("un certificat signé par un nœud iroh est accepté par un nœud JS pur", async () => {
    const org = generateSecretKey();
    const orgPublicKey = publicKeyOf(org);
    const nodePublicKey = await nobleCrypto.publicKeyOf(
      await nobleCrypto.generateSecretKey(),
    );

    const cert: MembershipCert = {
      v: 1,
      iss: orgPublicKey,
      nodePublicKey,
      userId: "u1",
      orgIds: ["org-a"],
      superPeer: false,
      iat: NOW - 60,
      exp: NOW + 3_600,
    };

    // Émis côté desktop (natif), vérifié côté portable.
    const signed = await signMembership(org, cert, irohCrypto);
    const verdict = await verifyMembership(signed, {
      peerId: nodePublicKey,
      anchors: { orgKeys: new Map([["org-a", orgPublicKey]]), superPeerKey: null },
      myOrgIds: ["org-a"],
      now: NOW,
      crypto: nobleCrypto,
    });

    expect(verdict).toEqual({ ok: true, orgIds: ["org-a"] });
  });

  it("et réciproquement : signé en JS pur, accepté par un nœud iroh", async () => {
    const org = await nobleCrypto.generateSecretKey();
    const orgPublicKey = await nobleCrypto.publicKeyOf(org);
    const nodePublicKey = publicKeyOf(generateSecretKey());

    const signed = await signMembership(
      org,
      {
        v: 1,
        iss: orgPublicKey,
        nodePublicKey,
        userId: "u1",
        orgIds: ["org-a"],
        superPeer: false,
        iat: NOW - 60,
        exp: NOW + 3_600,
      },
      nobleCrypto,
    );

    const verdict = await verifyMembership(signed, {
      peerId: nodePublicKey,
      anchors: { orgKeys: new Map([["org-a", orgPublicKey]]), superPeerKey: null },
      myOrgIds: ["org-a"],
      now: NOW,
      crypto: irohCrypto,
    });

    expect(verdict).toEqual({ ok: true, orgIds: ["org-a"] });
  });
});
