import { describe, expect, it } from "bun:test";
import type { PrismaDelegate, PrismaLike } from "./src/prisma_like.ts";
import { PrismaProjection } from "./src/index.ts";
import { FakeClient } from "./fake_prisma.ts";

describe("PrismaProjection — upsert/remove", () => {
  it("crée la ligne si elle n'existe pas encore", async () => {
    const client = new FakeClient();
    const projection = new PrismaProjection(client);

    await projection.upsert("Projects", "p1", { name: "Alpha" });

    expect(await client.projects.findUnique({ where: { id: "p1" } })).toEqual({
      id: "p1",
      name: "Alpha",
    });
  });

  it("met à jour sans écraser les champs absents de la maj (update-then-create)", async () => {
    const client = new FakeClient();
    const projection = new PrismaProjection(client);

    await projection.upsert("Projects", "p1", { name: "Alpha", status: "open" });
    await projection.upsert("Projects", "p1", { status: "closed" });

    expect(await client.projects.findUnique({ where: { id: "p1" } })).toEqual({
      id: "p1",
      name: "Alpha",
      status: "closed",
    });
  });

  it("marque `deleted: true` sans supprimer la ligne", async () => {
    const client = new FakeClient();
    const projection = new PrismaProjection(client);
    await projection.upsert("Projects", "p1", { name: "Alpha" });

    await projection.remove("Projects", "p1");

    expect(await client.projects.findUnique({ where: { id: "p1" } })).toEqual({
      id: "p1",
      name: "Alpha",
      deleted: true,
    });
  });

  it("entité inconnue : erreur explicite plutôt qu'un crash sur `undefined`", async () => {
    const projection = new PrismaProjection(new FakeClient());
    await expect(projection.upsert("Bogus", "x", {})).rejects.toThrow(/entite inconnue/);
  });
});

describe("PrismaProjection — course update-then-create", () => {
  /**
   * `upsert` fait `updateMany` (count 0 = la ligne n'existe pas encore) puis
   * `create`. Si un AUTRE nœud crée la même ligne entre les deux, notre
   * `create` prend une violation de contrainte unique (P2002) — la ligne
   * existe désormais, donc on doit retomber sur une mise à jour au lieu de
   * laisser l'erreur remonter jusqu'au mesh.
   */
  function racyDelegate(): { delegate: PrismaDelegate; calls: string[] } {
    const calls: string[] = [];
    let updateManyCount = 0;
    const delegate: PrismaDelegate = {
      updateMany: async () => {
        calls.push("updateMany");
        updateManyCount++;
        return { count: updateManyCount > 1 ? 1 : 0 };
      },
      create: async () => {
        calls.push("create");
        const err = new Error("Unique constraint failed on the fields: (`id`)");
        (err as { code?: string }).code = "P2002";
        throw err;
      },
      update: async () => {
        throw new Error("not used by upsert()");
      },
      upsert: async () => {
        throw new Error("not used by upsert()");
      },
      findUnique: async () => null,
      findMany: async () => [],
    };
    return { delegate, calls };
  }

  it("retombe sur update quand create échoue en P2002", async () => {
    const { delegate, calls } = racyDelegate();
    const db = { projects: delegate } as unknown as PrismaLike;
    const projection = new PrismaProjection(db);

    await projection.upsert("Projects", "p1", { name: "Alpha" });

    expect(calls).toEqual(["updateMany", "create", "updateMany"]);
  });

  it("relance l'erreur d'origine si la seconde updateMany ne trouve toujours rien (P2002 non lié à une vraie course)", async () => {
    const delegate: PrismaDelegate = {
      updateMany: async () => ({ count: 0 }),
      create: async () => {
        const err = new Error("Unique constraint failed on the fields: (`id`)");
        (err as { code?: string }).code = "P2002";
        throw err;
      },
      update: async () => {
        throw new Error("not used");
      },
      upsert: async () => {
        throw new Error("not used");
      },
      findUnique: async () => null,
      findMany: async () => [],
    };
    const db = { projects: delegate } as unknown as PrismaLike;
    const projection = new PrismaProjection(db);

    await expect(projection.upsert("Projects", "p1", { name: "Alpha" })).rejects.toThrow(
      "Unique constraint failed",
    );
  });

  it("une erreur `create` qui n'est PAS une violation de contrainte unique n'est jamais avalée", async () => {
    const delegate: PrismaDelegate = {
      updateMany: async () => ({ count: 0 }),
      create: async () => {
        throw new Error("connection reset");
      },
      update: async () => {
        throw new Error("not used");
      },
      upsert: async () => {
        throw new Error("not used");
      },
      findUnique: async () => null,
      findMany: async () => [],
    };
    const db = { projects: delegate } as unknown as PrismaLike;
    const projection = new PrismaProjection(db);

    await expect(projection.upsert("Projects", "p1", { name: "Alpha" })).rejects.toThrow(
      "connection reset",
    );
  });
});
