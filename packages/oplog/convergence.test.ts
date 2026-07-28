import { describe, expect, it } from "bun:test";
import {
  MemoryOpStore,
  MemoryProjection,
  OpLog,
  replay,
  type Op,
} from "./src/index.ts";

/**
 * Convergence de l'op-log : rejeu, LWW par champ, et échanges entre plusieurs
 * nœuds. C'est le comportement que la couche maillage devra préserver — ces
 * tests font office de spécification exécutable.
 */

let seq = 0;
const newId = () => `op-${++seq}`;

/** Un nœud : journal + projection, avec une horloge murale contrôlée. */
function node(nodeId: string, startAt = 1_000) {
  let clock = startAt;
  const store = new MemoryOpStore();
  const projection = new MemoryProjection();
  const emitted: Op[] = [];
  const oplog = new OpLog(store, nodeId, {
    newId,
    now: () => clock,
    onLocalOp: (op) => {
      emitted.push(op);
      // Fidélité au fonctionnement réel : une écriture LOCALE a déjà atterri
      // dans les tables de l'app (l'op-log la capture après coup). La
      // projection locale est donc à jour sans passer par applyRemote.
      if (op.kind === "delete") void projection.remove(op.entity, op.entityId);
      else void projection.upsert(op.entity, op.entityId, op.fields);
    },
  });
  return {
    nodeId,
    store,
    projection,
    oplog,
    emitted,
    /** Avance l'horloge murale (les HLC suivent). */
    tick: (ms: number) => (clock += ms),
    ready: oplog.init(),
  };
}

/** Applique sur `to` toutes les ops émises par `from` (comme le transport). */
async function push(from: ReturnType<typeof node>, to: ReturnType<typeof node>) {
  for (const op of await from.store.list()) {
    await to.oplog.applyRemote(op, to.projection);
  }
}

describe("op-log — journal et rejeu", () => {
  it("journalise une mutation locale et la notifie", async () => {
    const a = node("a");
    await a.ready;

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });

    expect(a.store.size()).toBe(1);
    expect(a.emitted).toHaveLength(1);
    expect(a.emitted[0]?.nodeId).toBe("a");
  });

  it("rejoue le journal pour reconstruire l'état", async () => {
    const a = node("a");
    await a.ready;

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });
    a.tick(10);
    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Beta" },
    });

    const rebuilt = new MemoryProjection();
    await replay(await a.store.list(), rebuilt);

    expect(rebuilt.row("Projects", "p1")).toEqual({ name: "Beta" });
  });

  it("un rejeu est idempotent (rejouer deux fois ne change rien)", async () => {
    const a = node("a");
    await a.ready;
    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha", tag: "x" },
    });

    const rebuilt = new MemoryProjection();
    const ops = await a.store.list();
    await replay(ops, rebuilt);
    await replay(ops, rebuilt);

    expect(rebuilt.rows("Projects")).toEqual({ p1: { name: "Alpha", tag: "x" } });
  });
});

describe("op-log — convergence entre nœuds", () => {
  it("propage une création d'un nœud à l'autre", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });
    await push(a, b);

    expect(b.projection.row("Projects", "p1")).toEqual({ name: "Alpha" });
  });

  it("ignore une op déjà appliquée (dédup)", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });
    await push(a, b);
    const applied = await b.oplog.applyRemote(
      (await a.store.list())[0]!,
      b.projection,
    );

    expect(applied).toBe(false);
  });

  it("la plus RÉCENTE gagne sur un même champ (LWW)", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "depuis-a" },
    });
    b.tick(500); // b écrit plus tard
    await b.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "depuis-b" },
    });

    await push(a, b);
    await push(b, a);

    expect(a.projection.row("Projects", "p1")).toEqual({ name: "depuis-b" });
    expect(b.projection.row("Projects", "p1")).toEqual({ name: "depuis-b" });
  });

  it("des champs DIFFÉRENTS modifiés en concurrence fusionnent", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });
    await push(a, b);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "renommé-par-a" },
    });
    await b.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { note: "annoté-par-b" },
    });

    await push(a, b);
    await push(b, a);

    const expected = { name: "renommé-par-a", note: "annoté-par-b" };
    expect(a.projection.row("Projects", "p1")).toEqual(expected);
    expect(b.projection.row("Projects", "p1")).toEqual(expected);
  });

  it("converge quel que soit l'ORDRE d'arrivée des ops", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "un" },
    });
    a.tick(10);
    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "deux" },
    });

    // b reçoit dans le DÉSORDRE.
    const ops = await a.store.list();
    for (const op of [...ops].reverse())
      await b.oplog.applyRemote(op, b.projection);

    expect(b.projection.row("Projects", "p1")).toEqual({ name: "deux" });
  });

  it("propage une suppression, et une écriture ANTÉRIEURE ne la ressuscite pas", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });
    await push(a, b);

    // b écrit, puis a supprime PLUS TARD.
    await b.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "modifié-par-b" },
    });
    a.tick(1_000);
    await a.oplog.record({ entity: "Projects", entityId: "p1", kind: "delete" });

    await push(a, b);
    await push(b, a);

    expect(b.projection.row("Projects", "p1")).toBeUndefined();
    expect(a.projection.row("Projects", "p1")).toBeUndefined();
  });

  it("trois nœuds convergent vers le même état", async () => {
    const a = node("a");
    const b = node("b");
    const c = node("c");
    await Promise.all([a.ready, b.ready, c.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "Alpha" },
    });
    b.tick(100);
    await b.oplog.record({
      entity: "Projects",
      entityId: "p2",
      kind: "upsert",
      fields: { name: "Beta" },
    });
    c.tick(200);
    await c.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { note: "vu-par-c" },
    });

    // Diffusion croisée (comme le gossip : tout le monde voit tout).
    for (const [from, to] of [
      [a, b], [a, c], [b, a], [b, c], [c, a], [c, b],
    ] as const) {
      await push(from, to);
    }

    const expected = {
      p1: { name: "Alpha", note: "vu-par-c" },
      p2: { name: "Beta" },
    };
    expect(a.projection.rows("Projects")).toEqual(expected);
    expect(b.projection.rows("Projects")).toEqual(expected);
    expect(c.projection.rows("Projects")).toEqual(expected);
  });

  it("rattrape après une coupure (sinceHlc ne renvoie que le delta)", async () => {
    const a = node("a");
    const b = node("b");
    await Promise.all([a.ready, b.ready]);

    await a.oplog.record({
      entity: "Projects",
      entityId: "p1",
      kind: "upsert",
      fields: { name: "avant" },
    });
    await push(a, b);
    const cursor = (await a.store.list()).at(-1)!.hlc;

    // b est hors ligne pendant que a continue d'écrire.
    a.tick(50);
    await a.oplog.record({
      entity: "Projects",
      entityId: "p2",
      kind: "upsert",
      fields: { name: "pendant" },
    });

    const delta = await a.store.list({ sinceHlc: cursor });
    expect(delta).toHaveLength(1);

    for (const op of delta) await b.oplog.applyRemote(op, b.projection);
    expect(b.projection.rows("Projects")).toEqual({
      p1: { name: "avant" },
      p2: { name: "pendant" },
    });
  });
});
