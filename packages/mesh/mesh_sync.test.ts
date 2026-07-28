import { describe, expect, it } from "bun:test";
import { CreebaSync, MemoryNetwork } from "@streamline-pulse/creeba-core";
import {
  MemoryOpStore,
  MemoryProjection,
  OpLog,
  type Op,
} from "@streamline-pulse/creeba-oplog";
import {
  MeshSync,
  nobleCrypto,
  signMembership,
  type MembershipCert,
  type MeshMsg,
  type SignedMembership,
  type TrustAnchors,
} from "./src/index.ts";

/**
 * Le protocole de bout en bout, plusieurs nœuds dans un process : confiance,
 * cloisonnement par org, rattrapage et gossip. Le transport est en mémoire —
 * l'application, elle, ne voit aucune différence avec iroh ou WebSocket.
 */

const NOW = 1_800_000_000;
let seq = 0;

async function keypair() {
  const secretKey = await nobleCrypto.generateSecretKey();
  return { secretKey, publicKey: await nobleCrypto.publicKeyOf(secretKey) };
}

type Key = Awaited<ReturnType<typeof keypair>>;

function cert(
  issuer: Key,
  nodePublicKey: string,
  userId: string,
  orgIds: string[],
  superPeer = false,
): Promise<SignedMembership> {
  const body: MembershipCert = {
    v: 1,
    iss: issuer.publicKey,
    nodePublicKey,
    userId,
    orgIds,
    superPeer,
    iat: NOW - 60,
    exp: NOW + 3_600,
  };
  return signMembership(issuer.secretKey, body);
}

interface NodeOptions {
  isSuperPeer?: boolean;
  myOrgIds?: string[];
  /** Simule une dépendance absente : tant que vrai, l'op n'est pas applicable. */
  blocked?: (op: Op, projection: MemoryProjection) => boolean;
}

/** Un nœud complet : transport, journal, mesh — comme dans une vraie app. */
async function node(
  net: MemoryNetwork<MeshMsg>,
  key: Key,
  memberships: SignedMembership[],
  anchors: TrustAnchors,
  opts: NodeOptions = {},
) {
  const store = new MemoryOpStore();
  const projection = new MemoryProjection();
  // Le journal existe avant le mesh ; le pont est branché juste après.
  let emitLocal: (op: Op) => void = () => {};

  const oplog = new OpLog(store, key.publicKey, {
    newId: () => `op-${++seq}`,
    now: () => Date.now(),
    onLocalOp: (op) => {
      // Une écriture locale a déjà atterri dans les tables de l'app.
      if (op.kind === "delete") void projection.remove(op.entity, op.entityId);
      else void projection.upsert(op.entity, op.entityId, op.fields);
      emitLocal(op);
    },
  });
  const ready = oplog.init();

  const sync = new CreebaSync<MeshMsg>({
    transport: net.transport(key.publicKey),
    identity: { userId: memberships[0]?.cert.userId ?? key.publicKey, metadata: { memberships } },
    topic: "test",
  });

  const mesh = new MeshSync({
    sync,
    journal: {
      ready,
      list: (o) => store.list(o),
      apply: async (op) => {
        if (opts.blocked?.(op, projection))
          throw new Error("dépendance manquante");
        return oplog.applyRemote(op, projection);
      },
    },
    anchors: () => anchors,
    myOrgIds: () => opts.myOrgIds ?? [],
    isSuperPeer: opts.isSuperPeer,
    catchUpIntervalMs: null, // pas de timer : les tests pilotent le rattrapage
    now: () => NOW,
  });

  emitLocal = (op) => mesh.onLocalOp(op);

  sync.on("peer", (peer) => void mesh.onPeer(peer));
  sync.on("peers", (peers) => void mesh.onPeers(peers));
  sync.on("data", (msg, from) => {
    if (from) void mesh.onData(msg, from);
  });

  await sync.start();
  await ready;
  return { key, store, projection, oplog, sync, mesh, memberships };
}

/** Laisse le réseau et les applications asynchrones se stabiliser. */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

function write(
  n: Awaited<ReturnType<typeof node>>,
  entityId: string,
  fields: Record<string, unknown>,
  orgId: string,
) {
  return n.oplog.record({
    entity: "Projects",
    entityId,
    kind: "upsert",
    fields,
    orgId,
  });
}

describe("MeshSync — confiance et convergence", () => {
  it("deux membres d'une même org convergent", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();

    expect(a.mesh.peers()).toHaveLength(1);
    expect(b.mesh.peers()).toHaveLength(1);

    await write(a, "p1", { name: "Alpha" }, "org-a");
    await settle();

    expect(b.projection.row("Projects", "p1")).toEqual({ name: "Alpha" });
  });

  it("un nœud sans certificat est refusé et ne reçoit rien", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const intruder = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const x = await node(net, intruder, [], anchors, { myOrgIds: ["org-a"] });
    await settle();

    expect(a.mesh.peers()).toHaveLength(0);

    await write(a, "p1", { name: "Alpha" }, "org-a");
    await settle();

    expect(x.projection.row("Projects", "p1")).toBeUndefined();
  });

  it("un membre d'une AUTRE org n'est pas de confiance", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const orgA = await keypair();
    const orgB = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([
        ["org-a", orgA.publicKey],
        ["org-b", orgB.publicKey],
      ]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(orgA, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(orgB, kb.publicKey, "u-b", ["org-b"])], anchors, { myOrgIds: ["org-b"] });
    await settle();

    expect(a.mesh.peers()).toHaveLength(0);
    expect(b.mesh.peers()).toHaveLength(0);
  });

  it("rattrape l'historique en arrivant après coup", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await write(a, "p1", { name: "écrit avant l'arrivée de b" }, "org-a");
    await settle();

    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();

    expect(b.projection.row("Projects", "p1")).toEqual({
      name: "écrit avant l'arrivée de b",
    });
  });

  it("converge après une partition (rattrapage bidirectionnel)", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();

    net.partition(ka.publicKey, kb.publicKey);
    await write(a, "pa", { name: "hors ligne côté a" }, "org-a");
    await write(b, "pb", { name: "hors ligne côté b" }, "org-a");
    await settle();

    expect(b.projection.row("Projects", "pa")).toBeUndefined();

    net.heal(ka.publicKey, kb.publicKey);
    await settle();

    const expected = {
      pa: { name: "hors ligne côté a" },
      pb: { name: "hors ligne côté b" },
    };
    expect(a.projection.rows("Projects")).toEqual(expected);
    expect(b.projection.rows("Projects")).toEqual(expected);
  });
});

describe("MeshSync — cloisonnement par org", () => {
  it("le super-pair relaie SANS mélanger les orgs", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const orgA = await keypair();
    const orgB = await keypair();
    const superKey = await keypair();

    const memberAnchors: TrustAnchors = {
      orgKeys: new Map([
        ["org-a", orgA.publicKey],
        ["org-b", orgB.publicKey],
      ]),
      superPeerKey: superKey.publicKey,
    };

    const ka = await keypair();
    const kb = await keypair();

    // Le super-pair : autorité globale, membre d'aucune org.
    const s = await node(
      net,
      superKey,
      [await cert(superKey, superKey.publicKey, "superpeer", [], true)],
      { ...memberAnchors, superPeerKey: superKey.publicKey },
      { isSuperPeer: true, myOrgIds: [] },
    );
    const a = await node(net, ka, [await cert(orgA, ka.publicKey, "u-a", ["org-a"])], memberAnchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(orgB, kb.publicKey, "u-b", ["org-b"])], memberAnchors, { myOrgIds: ["org-b"] });
    await settle();

    expect(s.mesh.peers()).toHaveLength(2);

    await write(a, "pa", { name: "secret de org-a" }, "org-a");
    await write(b, "pb", { name: "secret de org-b" }, "org-b");
    await settle(20);

    // Le super-pair, lui, porte tout.
    expect(s.projection.rows("Projects")).toEqual({
      pa: { name: "secret de org-a" },
      pb: { name: "secret de org-b" },
    });
    // Mais chaque membre ne voit que son org.
    expect(a.projection.rows("Projects")).toEqual({ pa: { name: "secret de org-a" } });
    expect(b.projection.rows("Projects")).toEqual({ pb: { name: "secret de org-b" } });
  });

  it("gossip multi-saut : a et b se rejoignent via le super-pair", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const superKey = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: superKey.publicKey,
    };
    const ka = await keypair();
    const kb = await keypair();

    const s = await node(
      net,
      superKey,
      [await cert(superKey, superKey.publicKey, "superpeer", [], true)],
      anchors,
      { isSuperPeer: true, myOrgIds: [] },
    );
    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();

    // a et b ne se voient plus : seul le chemin a → s → b subsiste.
    net.partition(ka.publicKey, kb.publicKey);
    await settle();

    await write(a, "p1", { name: "par relais" }, "org-a");
    await settle(20);

    expect(s.projection.row("Projects", "p1")).toEqual({ name: "par relais" });
    expect(b.projection.row("Projects", "p1")).toEqual({ name: "par relais" });
  });
});

describe("MeshSync — application des ops", () => {
  it("applique un lot malgré une dépendance reçue APRÈS celle qui en dépend", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await write(a, "enfant", { name: "dépend du parent" }, "org-a");
    await write(a, "parent", { name: "Parent" }, "org-a");
    await settle();

    // b reçoit le lot dans l'ordre du journal : « enfant » d'abord, alors que
    // sa dépendance n'existe pas encore. Sans re-passe, l'op serait perdue.
    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, {
      myOrgIds: ["org-a"],
      blocked: (op, projection) =>
        op.entityId === "enfant" && !projection.row("Projects", "parent"),
    });
    await settle(20);

    expect(b.projection.rows("Projects")).toEqual({
      enfant: { name: "dépend du parent" },
      parent: { name: "Parent" },
    });
  });

  it("une op sans org n'est acceptée que par le super-pair", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const superKey = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: superKey.publicKey,
    };
    const ka = await keypair();

    const s = await node(
      net,
      superKey,
      [await cert(superKey, superKey.publicKey, "superpeer", [], true)],
      anchors,
      { isSuperPeer: true, myOrgIds: [] },
    );
    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();

    await s.oplog.record({
      entity: "Projects",
      entityId: "orphan",
      kind: "upsert",
      fields: { name: "sans org" },
    });
    await settle(20);

    // Servie (le super-pair sert tout) mais REFUSÉE à l'application : le
    // membre ne peut pas la rattacher à une org qu'il partage.
    expect(a.projection.row("Projects", "orphan")).toBeUndefined();
  });

  it("expose un état de synchronisation exploitable par l'UI", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();

    expect(a.mesh.status().lastSyncAt).toBeNull();
    expect(a.mesh.pullNow()).toEqual({ ok: true, peers: 1 });

    await write(b, "p1", { name: "Alpha" }, "org-a");
    await settle();

    expect(a.mesh.status().trustedPeers).toBe(1);
    expect(a.mesh.status().lastSyncAt).not.toBeNull();
  });

  it("sans pair de confiance, pullNow le dit au lieu de mentir", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const ka = await keypair();
    const a = await node(
      net,
      ka,
      [await cert(org, ka.publicKey, "u-a", ["org-a"])],
      { orgKeys: new Map([["org-a", org.publicKey]]), superPeerKey: null },
      { myOrgIds: ["org-a"] },
    );
    await settle();

    expect(a.mesh.pullNow()).toEqual({ ok: false, peers: 0 });
  });
});

describe("MeshSync — départ et retour d'un pair", () => {
  it("oublie un pair parti (plus de diffusion dans le vide)", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    const b = await node(net, kb, [await cert(org, kb.publicKey, "u-b", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await settle();
    expect(a.mesh.status().trustedPeers).toBe(1);

    b.sync.destroy();
    await settle();

    expect(a.mesh.status().trustedPeers).toBe(0);
  });
});

describe("MeshSync — annonce d'identité", () => {
  it("un pair refusé devient de confiance dès que l'ancre arrive", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const ka = await keypair();
    const kb = await keypair();

    // a ignore d'abord la clé de l'org : b sera refusé.
    const anchorsA: TrustAnchors = { orgKeys: new Map(), superPeerKey: null };
    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchorsA, { myOrgIds: ["org-a"] });
    const b = await node(
      net,
      kb,
      [await cert(org, kb.publicKey, "u-b", ["org-a"])],
      { orgKeys: new Map([["org-a", org.publicKey]]), superPeerKey: null },
      { myOrgIds: ["org-a"] },
    );
    await settle();

    expect(a.mesh.peers()).toHaveLength(0);

    // L'org est rejointe : l'ancre apparaît, et les pairs DÉJÀ connus doivent
    // être ré-évalués — ils ne re-annonceront rien d'eux-mêmes.
    anchorsA.orgKeys.set("org-a", org.publicKey);
    await a.mesh.reevaluateKnownPeers();
    await settle();

    expect(a.mesh.peers()).toHaveLength(1);

    await write(b, "p1", { name: "Alpha" }, "org-a");
    await settle();
    expect(a.projection.row("Projects", "p1")).toEqual({ name: "Alpha" });
  });

  it("un appareil appairé APRÈS coup est accepté dès qu'il annonce son cert", async () => {
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();

    const a = await node(net, ka, [await cert(org, ka.publicKey, "u-a", ["org-a"])], anchors, { myOrgIds: ["org-a"] });
    await write(a, "p1", { name: "Alpha" }, "org-a");
    // b démarre SANS certificat — comme un desktop pas encore appairé.
    const b = await node(net, kb, [], anchors, { myOrgIds: ["org-a"] });
    await settle();

    expect(a.mesh.peers()).toHaveLength(0);
    expect(b.projection.row("Projects", "p1")).toBeUndefined();

    // Appairage : le cert arrive, on l'annonce — et le rattrapage part seul.
    await b.mesh.announce([await cert(org, kb.publicKey, "u-b", ["org-a"])]);
    await settle();

    expect(a.mesh.peers()).toHaveLength(1);
    expect(b.projection.row("Projects", "p1")).toEqual({ name: "Alpha" });
  });
});
