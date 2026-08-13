import { describe, expect, it } from "bun:test";
import type { Op } from "@streamline-pulse/creeba-oplog";
import { PrismaOpStore } from "./src/index.ts";
import { FakeClient } from "./fake_prisma.ts";

function op(overrides: Partial<Op> = {}): Op {
  return {
    id: "op-1",
    hlc: { wall: 1000, counter: 0 },
    nodeId: "node-a",
    entity: "Projects",
    entityId: "p1",
    kind: "upsert",
    fields: { name: "Alpha" },
    ...overrides,
  };
}

describe("PrismaOpStore — journal (append/list)", () => {
  it("fait l'aller-retour des champs optionnels (actorId, orgId)", async () => {
    const store = new PrismaOpStore(new FakeClient());
    await store.append(op({ actorId: "user-1", orgId: "org-a" }));

    const [row] = await store.list();
    expect(row).toEqual(op({ actorId: "user-1", orgId: "org-a" }));
  });

  it("actorId/orgId absents restent `undefined`, pas `null`", async () => {
    const store = new PrismaOpStore(new FakeClient());
    await store.append(op());

    const [row] = await store.list();
    expect(row.actorId).toBeUndefined();
    expect(row.orgId).toBeUndefined();
  });

  it("`list({ sinceHlc })` ne renvoie que le delta, trié par HLC croissante", async () => {
    const store = new PrismaOpStore(new FakeClient());
    await store.append(op({ id: "op-1", hlc: { wall: 100, counter: 0 } }));
    await store.append(op({ id: "op-2", hlc: { wall: 100, counter: 1 } }));
    await store.append(op({ id: "op-3", hlc: { wall: 200, counter: 0 } }));

    const delta = await store.list({ sinceHlc: { wall: 100, counter: 0 } });
    expect(delta.map((o) => o.id)).toEqual(["op-2", "op-3"]);
  });
});

describe("PrismaOpStore — horloge", () => {
  it("`loadClock` renvoie `null` tant que rien n'a été sauvegardé", async () => {
    const store = new PrismaOpStore(new FakeClient());
    expect(await store.loadClock()).toBeNull();
  });

  it("`saveClock` puis `loadClock` fait l'aller-retour, y compris un wall > Number.MAX_SAFE_INTEGER en BigInt", async () => {
    const store = new PrismaOpStore(new FakeClient());
    await store.saveClock({ wall: 1_700_000_000_000, counter: 3 });
    expect(await store.loadClock()).toEqual({ wall: 1_700_000_000_000, counter: 3 });

    await store.saveClock({ wall: 1_700_000_000_001, counter: 0 });
    expect(await store.loadClock()).toEqual({ wall: 1_700_000_000_001, counter: 0 });
  });
});

describe("PrismaOpStore — état par champ (les deux stratégies de clé)", () => {
  for (const keyStrategy of ["composite", "synthetic"] as const) {
    it(`stratégie "${keyStrategy}" : loadRowState reconstruit fields + deletedHlc`, async () => {
      const store = new PrismaOpStore(new FakeClient(), keyStrategy);

      expect(await store.loadRowState("Projects", "p1")).toBeNull();

      await store.saveFieldHlc("Projects", "p1", "name", {
        hlc: { wall: 10, counter: 0 },
        nodeId: "node-a",
      });
      await store.saveFieldHlc("Projects", "p1", "status", {
        hlc: { wall: 11, counter: 0 },
        nodeId: "node-a",
      });

      let state = await store.loadRowState("Projects", "p1");
      expect(state).toEqual({
        fields: {
          name: { hlc: { wall: 10, counter: 0 }, nodeId: "node-a" },
          status: { hlc: { wall: 11, counter: 0 }, nodeId: "node-a" },
        },
        deletedHlc: null,
      });

      // Une maj ultérieure du MÊME champ écrase, ne duplique pas.
      await store.saveFieldHlc("Projects", "p1", "name", {
        hlc: { wall: 20, counter: 0 },
        nodeId: "node-b",
      });
      state = await store.loadRowState("Projects", "p1");
      expect(state?.fields.name).toEqual({
        hlc: { wall: 20, counter: 0 },
        nodeId: "node-b",
      });

      await store.saveDeletedHlc("Projects", "p1", {
        hlc: { wall: 30, counter: 0 },
        nodeId: "node-a",
      });
      state = await store.loadRowState("Projects", "p1");
      expect(state?.deletedHlc).toEqual({
        hlc: { wall: 30, counter: 0 },
        nodeId: "node-a",
      });

      // Une autre ligne ne doit rien mélanger avec celle-ci.
      await store.saveFieldHlc("Projects", "p2", "name", {
        hlc: { wall: 1, counter: 0 },
        nodeId: "node-a",
      });
      expect((await store.loadRowState("Projects", "p2"))?.fields).toEqual({
        name: { hlc: { wall: 1, counter: 0 }, nodeId: "node-a" },
      });
      expect(Object.keys((await store.loadRowState("Projects", "p1"))!.fields)).toHaveLength(2);
    });
  }
});
