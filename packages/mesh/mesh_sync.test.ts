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
  /** Horloge murale du nœud, pour fabriquer des HLC volontairement anciennes. */
  clock?: () => number;
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
    now: opts.clock ?? (() => Date.now()),
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

  // Compteur de trafic : combien d'ops ce nœud a-t-il réellement mises sur le fil.
  const sent = { messages: 0, ops: 0 };
  const rawSend = sync.send.bind(sync);
  sync.send = (peerId: string, msg: MeshMsg) => {
    if (msg.t === "ops") {
      sent.messages++;
      sent.ops += msg.ops.length;
    }
    return rawSend(peerId, msg);
  };

  sync.on("peer", (peer) => void mesh.onPeer(peer));
  sync.on("peers", (peers) => void mesh.onPeers(peers));
  sync.on("data", (msg, from) => {
    if (from) void mesh.onData(msg, from);
  });

  await sync.start();
  await ready;
  return { key, store, projection, oplog, sync, mesh, memberships, sent };
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

  it("un pair ne peut pas injecter d'op dans une org pour laquelle il n'a pas confiance", async () => {
    // n est membre de org-a ET org-b. p n'a confiance que pour org-a. Un p
    // compromis (ou un bug côté transport) qui forge un message `ops` portant
    // org-b ne doit PAS pouvoir s'en servir pour atteindre org-b via n — même
    // si n, lui, en est bien membre. mayAccept seul (« suis-JE membre de cette
    // org ? ») ne suffit pas : il faut aussi que l'EXPÉDITEUR le soit.
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
    const kn = await keypair();
    const kp = await keypair();

    const n = await node(
      net,
      kn,
      [
        await cert(orgA, kn.publicKey, "u-n", ["org-a"]),
        await cert(orgB, kn.publicKey, "u-n", ["org-b"]),
      ],
      anchors,
      { myOrgIds: ["org-a", "org-b"] },
    );
    const p = await node(net, kp, [await cert(orgA, kp.publicKey, "u-p", ["org-a"])], anchors, {
      myOrgIds: ["org-a"],
    });
    await settle();

    expect(n.mesh.peers()).toHaveLength(1);

    // Message forgé à la main : p n'a jamais reçu confiance pour org-b, donc
    // son propre mesh ne construirait jamais ça — on simule un client
    // compromis qui parle le protocole directement sur le fil.
    p.sync.send(kn.publicKey, {
      t: "ops",
      ops: [
        {
          id: "forged-1",
          hlc: { wall: NOW * 1000, counter: 0 },
          nodeId: kp.publicKey,
          entity: "Projects",
          entityId: "forged",
          kind: "upsert",
          fields: { name: "injecté par un pair non habilité pour org-b" },
          orgId: "org-b",
        },
      ],
    });
    await settle(20);

    expect(n.projection.row("Projects", "forged")).toBeUndefined();
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

describe("MeshSync — rattrapage incrémental", () => {
  it("un rattrapage sans rien de neuf ne met AUCUNE op sur le fil", async () => {
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

    for (let i = 0; i < 30; i++)
      await write(a, `p${i}`, { name: `Projet ${i}` }, "org-a");
    await settle(20);
    expect(Object.keys(b.projection.rows("Projects"))).toHaveLength(30);

    // Tout le monde est à jour : les rattrapages suivants doivent être muets.
    const before = { a: a.sent.ops, b: b.sent.ops };
    a.mesh.pullNow();
    b.mesh.pullNow();
    await settle(20);

    expect(a.sent.ops - before.a).toBe(0);
    expect(b.sent.ops - before.b).toBe(0);
  });

  it("ne renvoie que le delta, pas le journal entier", async () => {
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

    for (let i = 0; i < 20; i++)
      await write(a, `p${i}`, { name: `Projet ${i}` }, "org-a");
    await settle(20);

    // b coupé : il rate deux écritures en direct.
    net.partition(ka.publicKey, kb.publicKey);
    await settle();
    await write(a, "tardif-1", { name: "raté 1" }, "org-a");
    await write(a, "tardif-2", { name: "raté 2" }, "org-a");
    await settle();

    const before = a.sent.ops;
    net.heal(ka.publicKey, kb.publicKey);
    await settle(20);

    // 22 ops au journal de a, mais seules les 2 manquantes traversent.
    expect(await a.store.list()).toHaveLength(22);
    expect(a.sent.ops - before).toBe(2);
    expect(b.projection.row("Projects", "tardif-2")).toEqual({ name: "raté 2" });
  });

  it("échange dans les DEUX sens dès le premier contact, sans doublon", async () => {
    // Pas de rattrapage périodique dans les tests : si le premier contact ne
    // suffit pas, rien n'arrive. Et chaque op ne doit traverser QU'UNE fois —
    // pousser son journal en plus de répondre au `pull` la enverrait deux fois.
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

    // Chacun écrit dans son coin, hors de portée de l'autre.
    net.partition(ka.publicKey, kb.publicKey);
    await settle();
    for (let i = 0; i < 3; i++) await write(a, `a${i}`, { n: i }, "org-a");
    for (let i = 0; i < 2; i++) await write(b, `b${i}`, { n: i }, "org-a");
    await settle();

    const before = { a: a.sent.ops, b: b.sent.ops };
    net.heal(ka.publicKey, kb.publicKey);
    await settle(25);

    // Convergence complète, sans attendre le moindre tick.
    expect(Object.keys(a.projection.rows("Projects"))).toHaveLength(5);
    expect(Object.keys(b.projection.rows("Projects"))).toHaveLength(5);
    // Et chaque op n'a traversé qu'une fois.
    expect(a.sent.ops - before.a).toBe(3);
    expect(b.sent.ops - before.b).toBe(2);
  });

  it("ne SAUTE pas une op ancienne venue d'un nœud jamais entendu", async () => {
    // Le piège qu'un curseur global unique n'évite pas : a possède des ops
    // récentes, et c écrit avec une horloge très en retard. Un « depuis la plus
    // haute HLC vue » laisserait l'op de c sous le curseur, à jamais.
    const net = new MemoryNetwork<MeshMsg>();
    const org = await keypair();
    const anchors: TrustAnchors = {
      orgKeys: new Map([["org-a", org.publicKey]]),
      superPeerKey: null,
    };
    const ka = await keypair();
    const kb = await keypair();
    const kc = await keypair();

    const member = async (k: Key, id: string, o: NodeOptions = {}) =>
      node(net, k, [await cert(org, k.publicKey, id, ["org-a"])], anchors, {
        myOrgIds: ["org-a"],
        ...o,
      });

    const a = await member(ka, "u-a", { clock: () => 9_000_000 });
    const b = await member(kb, "u-b");
    // c a une horloge très en retard : ses ops naissent « anciennes ».
    const c = await member(kc, "u-c", { clock: () => 1_000 });
    await settle();

    // a ne verra JAMAIS c directement : tout doit transiter par b.
    net.partition(ka.publicKey, kc.publicKey);
    await write(a, "recent", { name: "écrit par a" }, "org-a");
    await settle(20);

    // a est coupé de b pendant que c publie son op ancienne.
    net.partition(ka.publicKey, kb.publicKey);
    await settle();
    await write(c, "ancien", { name: "écrit par c, horloge en retard" }, "org-a");
    await settle(20);
    expect(b.projection.row("Projects", "ancien")).toBeDefined();
    expect(a.projection.row("Projects", "ancien")).toBeUndefined();

    // a revient : le rattrapage doit lui livrer l'op de c malgré son HLC basse.
    net.heal(ka.publicKey, kb.publicKey);
    await settle(25);

    expect(a.projection.row("Projects", "ancien")).toEqual({
      name: "écrit par c, horloge en retard",
    });
    expect(a.mesh.version()[kc.publicKey]).toBeDefined();
  });

  it("sert tout à un pair qui n'annonce pas de vecteur (version antérieure)", async () => {
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
    await write(a, "p1", { name: "Alpha" }, "org-a");
    await write(a, "p2", { name: "Beta" }, "org-a");
    await settle(20);

    // Un `pull` à l'ancienne : ni `have`, ni curseur.
    const before = a.sent.ops;
    b.sync.send(ka.publicKey, { t: "pull", sinceHlc: null });
    await settle(20);

    expect(a.sent.ops - before).toBe(2);
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
