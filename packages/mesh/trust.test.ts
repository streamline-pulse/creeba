import { describe, expect, it } from "bun:test";
import {
  confirmationCode,
  decodeInvite,
  encodeInvite,
  nobleCrypto,
  randomCertId,
  signMembership,
  verifyMembership,
  type MembershipCert,
  type SignedMembership,
  type TrustAnchors,
} from "./src/index.ts";

/**
 * Confiance : un certificat autoportant, vérifié HORS-LIGNE contre des ancres
 * locales. Ces tests fixent qui est accepté, qui est refusé, et pourquoi.
 */

const NOW = 1_800_000_000;
const crypto = nobleCrypto;

async function keypair() {
  const secretKey = await crypto.generateSecretKey();
  return { secretKey, publicKey: await crypto.publicKeyOf(secretKey) };
}

/** Certificat émis par `issuer` pour le nœud `nodePublicKey`. */
async function issue(
  issuer: { secretKey: number[]; publicKey: string },
  nodePublicKey: string,
  over: Partial<MembershipCert> = {},
): Promise<SignedMembership> {
  const cert: MembershipCert = {
    v: 1,
    id: randomCertId(),
    iss: issuer.publicKey,
    nodePublicKey,
    userId: "u1",
    orgIds: ["org-a"],
    superPeer: false,
    iat: NOW - 60,
    exp: NOW + 3_600,
    ...over,
  };
  return signMembership(issuer.secretKey, cert, crypto);
}

function anchors(over: Partial<TrustAnchors> = {}): TrustAnchors {
  return { orgKeys: new Map(), superPeerKey: null, ...over };
}

describe("crypto de nœud", () => {
  it("dérive un node-id hex stable et signe de façon vérifiable", async () => {
    const me = await keypair();
    expect(me.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await crypto.publicKeyOf(me.secretKey)).toBe(me.publicKey);

    const msg = new TextEncoder().encode("bonjour");
    const sig = await crypto.sign(me.secretKey, msg);
    expect(sig).toHaveLength(64);
    expect(await crypto.verify(me.publicKey, msg, sig)).toBe(true);
  });

  it("refuse une signature d'un autre message ou d'une autre clé", async () => {
    const me = await keypair();
    const other = await keypair();
    const msg = new TextEncoder().encode("bonjour");
    const sig = await crypto.sign(me.secretKey, msg);

    expect(
      await crypto.verify(me.publicKey, new TextEncoder().encode("bonsoir"), sig),
    ).toBe(false);
    expect(await crypto.verify(other.publicKey, msg, sig)).toBe(false);
  });

  it("renvoie false — jamais une exception — sur une clé mal formée", async () => {
    const msg = new TextEncoder().encode("bonjour");
    expect(await crypto.verify("pas-du-hex", msg, new Array(64).fill(0))).toBe(
      false,
    );
  });
});

describe("certificats — signature et péremption", () => {
  it("accepte un certificat émis par la clé de MON org", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey);

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", org.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toEqual({ ok: true, orgIds: ["org-a"] });
  });

  it("refuse un certificat altéré (la signature ne couvre plus le contenu)", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey);
    signed.cert.orgIds = ["org-a", "org-secret"]; // élévation tentée

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", org.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "bad-signature" });
  });

  it("refuse un certificat présenté par un AUTRE nœud (vol de cert)", async () => {
    const org = await keypair();
    const node = await keypair();
    const thief = await keypair();
    const signed = await issue(org, node.publicKey);

    const verdict = await verifyMembership(signed, {
      peerId: thief.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", org.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "peer-mismatch" });
  });

  it("refuse un certificat expiré", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey, { exp: NOW - 1 });

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", org.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "expired" });
  });

  it("un certificat sans `id` reste vérifiable (compatibilité ascendante)", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey, { id: undefined });

    expect(signed.cert.id).toBeUndefined();
    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", org.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });
    expect(verdict.ok).toBe(true);
  });

  it("l'ordre des orgIds ne change pas la signature (forme canonique)", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey, {
      orgIds: ["org-a", "org-b"],
    });
    signed.cert.orgIds = ["org-b", "org-a"]; // même ensemble, autre ordre

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({
        orgKeys: new Map([
          ["org-a", org.publicKey],
          ["org-b", org.publicKey],
        ]),
      }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("certificats — autorité", () => {
  it("une clé d'org ne fait autorité QUE pour son propre org", async () => {
    const orgA = await keypair();
    const node = await keypair();
    // orgA signe un cert qui revendique org-b, dont il n'est pas l'autorité.
    const signed = await issue(orgA, node.publicKey, {
      orgIds: ["org-a", "org-b"],
    });

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", orgA.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toEqual({ ok: true, orgIds: ["org-a"] }); // org-b écarté
  });

  it("refuse un émetteur inconnu des ancres", async () => {
    const stranger = await keypair();
    const node = await keypair();
    const signed = await issue(stranger, node.publicKey);

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors(),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "untrusted-issuer" });
  });

  it("refuse un membre valide d'un org que je ne partage PAS", async () => {
    const orgB = await keypair();
    const node = await keypair();
    const signed = await issue(orgB, node.publicKey, { orgIds: ["org-b"] });

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-b", orgB.publicKey]]) }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "no-shared-org" });
  });

  it("le super-pair fait autorité pour les orgs qu'il déclare", async () => {
    const superPeer = await keypair();
    const node = await keypair();
    const signed = await issue(superPeer, node.publicKey, { orgIds: ["org-a"] });

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ superPeerKey: superPeer.publicKey }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toEqual({ ok: true, orgIds: ["org-a"] });
  });

  it("un cert `superPeer` est accepté sans partager d'org", async () => {
    const superPeer = await keypair();
    const cloud = await keypair();
    const signed = await issue(superPeer, cloud.publicKey, {
      superPeer: true,
      orgIds: [],
    });

    const verdict = await verifyMembership(signed, {
      peerId: cloud.publicKey,
      anchors: anchors({ superPeerKey: superPeer.publicKey }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict.ok).toBe(true);
  });

  it("un super-pair VÉRIFICATEUR accepte les certs qu'il a signés (il n'a aucun org)", async () => {
    // Le bug historique : sans ce bypass, le super-pair rejette tout le monde,
    // y compris les membres dont il est lui-même l'émetteur.
    const superPeer = await keypair();
    const node = await keypair();
    const signed = await issue(superPeer, node.publicKey, { orgIds: ["org-a"] });

    const opts = {
      peerId: node.publicKey,
      anchors: anchors({ superPeerKey: superPeer.publicKey }),
      myOrgIds: [] as string[],
      now: NOW,
      crypto,
    };

    expect(await verifyMembership(signed, opts)).toMatchObject({ ok: false });
    expect(
      await verifyMembership(signed, { ...opts, verifierIsSuperPeer: true }),
    ).toEqual({ ok: true, orgIds: ["org-a"] });
  });

  it("un super-pair vérificateur accepte aussi un cert signé par une clé d'org", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey);

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({ orgKeys: new Map([["org-a", org.publicKey]]) }),
      myOrgIds: [],
      now: NOW,
      verifierIsSuperPeer: true,
      crypto,
    });

    expect(verdict).toEqual({ ok: true, orgIds: ["org-a"] });
  });
});

describe("révocation", () => {
  it("révoque UN certificat sans bannir le nœud", async () => {
    const org = await keypair();
    const node = await keypair();
    const orgKeys = new Map([["org-a", org.publicKey]]);
    const old = await issue(org, node.publicKey);
    const fresh = await issue(org, node.publicKey);

    const base = { peerId: node.publicKey, myOrgIds: ["org-a"], now: NOW, crypto };
    const withRevocation = anchors({
      orgKeys,
      revokedCertIds: new Set([old.cert.id!]),
    });

    expect(
      await verifyMembership(old, { ...base, anchors: withRevocation }),
    ).toMatchObject({ ok: false, reason: "revoked" });
    // Le nœud reste membre via son certificat courant.
    expect(
      await verifyMembership(fresh, { ...base, anchors: withRevocation }),
    ).toMatchObject({ ok: true });
  });

  it("bannit un nœud : tous ses certificats tombent, même émis ensuite", async () => {
    const org = await keypair();
    const node = await keypair();
    const signed = await issue(org, node.publicKey);

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({
        orgKeys: new Map([["org-a", org.publicKey]]),
        revokedNodeKeys: new Set([node.publicKey]),
      }),
      myOrgIds: ["org-a"],
      now: NOW,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "revoked" });
  });

  it("la révocation s'applique aussi aux certificats du super-pair", async () => {
    const superPeer = await keypair();
    const node = await keypair();
    const signed = await issue(superPeer, node.publicKey, { superPeer: true });

    const verdict = await verifyMembership(signed, {
      peerId: node.publicKey,
      anchors: anchors({
        superPeerKey: superPeer.publicKey,
        revokedCertIds: new Set([signed.cert.id!]),
      }),
      myOrgIds: [],
      now: NOW,
      verifierIsSuperPeer: true,
      crypto,
    });

    expect(verdict).toMatchObject({ ok: false, reason: "revoked" });
  });
});

describe("pairing", () => {
  it("encode et décode une invitation sans perte", async () => {
    const org = await keypair();
    const invite = {
      orgId: "org-a",
      orgPublicKey: org.publicKey,
      token: "jeton-très-secret-éàü",
      exp: NOW + 900,
    };

    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
  });

  it("tolère les espaces autour d'une invitation collée", async () => {
    const invite = {
      orgId: "org-a",
      orgPublicKey: "ab".repeat(32),
      token: "t",
      exp: NOW,
    };
    expect(decodeInvite(`\n  ${encodeInvite(invite)}  \n`)).toEqual(invite);
  });

  it("renvoie null sur une invitation illisible ou incomplète", () => {
    expect(decodeInvite("n'importe quoi")).toBeNull();
    expect(decodeInvite("")).toBeNull();
    expect(
      decodeInvite(
        encodeInvite({ orgId: "org-a", orgPublicKey: "", token: "t", exp: 1 }),
      ),
    ).toBeNull();
  });

  it("le code de confirmation est à 6 chiffres, stable et lié aux trois valeurs", () => {
    const code = confirmationCode("org-key", "node-key", "token");
    expect(code).toMatch(/^\d{6}$/);
    expect(confirmationCode("org-key", "node-key", "token")).toBe(code);
    expect(confirmationCode("org-key", "autre-node", "token")).not.toBe(code);
    expect(confirmationCode("org-key", "node-key", "autre-token")).not.toBe(code);
  });
});
