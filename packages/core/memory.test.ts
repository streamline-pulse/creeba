import { describe, expect, it } from "bun:test";
import { CreebaSync, MemoryNetwork } from "./src/index.ts";

/** Laisse les livraisons (microtâches) se propager. */
const settle = () => new Promise((r) => setTimeout(r, 5));

type Msg = { kind: string; value?: number };

async function node(net: MemoryNetwork<Msg>, id: string, userId = id) {
  const sync = new CreebaSync<Msg>({
    transport: net.transport(id),
    identity: { userId, metadata: { name: userId } },
    topic: "room",
  });
  const received: { from: string | undefined; payload: Msg }[] = [];
  sync.on("data", (payload, from) => received.push({ from: from?.peerId, payload }));
  const peers: string[] = [];
  sync.on("peer", (p) => peers.push(p.peerId));
  await sync.start();
  return { sync, received, peers };
}

describe("MemoryNetwork — deux nœuds", () => {
  it("se découvrent en rejoignant le même topic", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const b = await node(net, "b");
    await settle();

    expect(a.peers).toEqual(["b"]);
    expect(b.peers).toEqual(["a"]);
    expect(a.sync.peers()[0]?.userId).toBe("b");
  });

  it("échangent des payloads dans les deux sens", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const b = await node(net, "b");
    await settle();

    a.sync.broadcast({ kind: "ping", value: 1 });
    b.sync.broadcast({ kind: "pong", value: 2 });
    await settle();

    expect(b.received).toEqual([{ from: "a", payload: { kind: "ping", value: 1 } }]);
    expect(a.received).toEqual([{ from: "b", payload: { kind: "pong", value: 2 } }]);
  });

  it("envoie à UN pair précis", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const b = await node(net, "b");
    const c = await node(net, "c");
    await settle();

    a.sync.send("b", { kind: "direct" });
    await settle();

    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(0);
  });
});

describe("MemoryNetwork — topologie", () => {
  it("isole les nœuds de topics différents", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const outsider = new CreebaSync<Msg>({
      transport: net.transport("z"),
      identity: { userId: "z" },
      topic: "autre-room",
    });
    await outsider.start();
    await settle();

    expect(a.peers).toHaveLength(0);
  });

  it("une partition coupe la livraison, la guérison la rétablit", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const b = await node(net, "b");
    await settle();

    net.partition("a", "b");
    a.sync.broadcast({ kind: "pendant-la-coupure" });
    await settle();
    expect(b.received).toHaveLength(0);

    net.heal("a", "b");
    a.sync.broadcast({ kind: "apres" });
    await settle();
    expect(b.received.map((r) => r.payload.kind)).toEqual(["apres"]);
  });

  it("signale le départ d'un nœud détruit", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const b = await node(net, "b");
    await settle();

    const left: string[] = [];
    a.sync.on("peers", (peers) => left.push(peers.map((p) => p.peerId).join(",")));
    b.sync.destroy();
    await settle();

    expect(a.sync.peers()).toHaveLength(0);
  });

  it("relaie de proche en proche (3 nœuds, diffusion complète)", async () => {
    const net = new MemoryNetwork<Msg>();
    const a = await node(net, "a");
    const b = await node(net, "b");
    const c = await node(net, "c");
    await settle();

    a.sync.broadcast({ kind: "à-tous" });
    await settle();

    expect(b.received).toHaveLength(1);
    expect(c.received).toHaveLength(1);
  });
});
