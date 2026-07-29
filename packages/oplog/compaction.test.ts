import { describe, expect, it } from "bun:test";
import {
  MemoryOpStore,
  MemoryProjection,
  OpLog,
  compact,
  replay,
  type Op,
} from "./src/index.ts";

/**
 * Compactage du journal. Un seul invariant compte, et tous les tests le
 * vérifient : **rejouer le journal purgé donne le même état que rejouer le
 * journal complet**. Le reste (combien d'ops disparaissent) n'est qu'une
 * mesure du gain.
 */

let seq = 0;

/** Fabrique un journal via un vrai OpLog, pour des HLC authentiques. */
async function journal(
  writes: (log: {
    write: (
      entityId: string,
      fields: Record<string, unknown>,
      entity?: string,
    ) => Promise<void>;
    remove: (entityId: string, entity?: string) => Promise<void>;
    tick: (ms: number) => void;
  }) => Promise<void>,
): Promise<Op[]> {
  let clock = 1_000;
  const store = new MemoryOpStore();
  const oplog = new OpLog(store, "n1", {
    newId: () => `op-${++seq}`,
    now: () => clock,
  });
  await oplog.init();
  await writes({
    write: async (entityId, fields, entity = "Projects") => {
      clock += 1;
      await oplog.record({ entity, entityId, kind: "upsert", fields });
    },
    remove: async (entityId, entity = "Projects") => {
      clock += 1;
      await oplog.record({ entity, entityId, kind: "delete" });
    },
    tick: (ms) => {
      clock += ms;
    },
  });
  return store.list();
}

/** L'état obtenu en rejouant un ensemble d'ops. */
async function state(ops: Op[]): Promise<Record<string, unknown>> {
  const projection = new MemoryProjection();
  await replay(ops, projection);
  return Object.fromEntries(
    [...projection.tables].map(([entity, rows]) => [
      entity,
      Object.fromEntries(rows),
    ]),
  );
}

/** L'invariant, vérifié à chaque fois. */
async function expectSameState(ops: Op[], keep: Op[]): Promise<void> {
  expect(await state(keep)).toEqual(await state(ops));
}

describe("compactage — l'état est préservé", () => {
  it("ne garde que la dernière écriture d'un champ", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "un" });
      await log.write("p1", { name: "deux" });
      await log.write("p1", { name: "trois" });
    });

    const { keep, drop } = compact(ops);

    expect(drop).toHaveLength(2);
    expect(keep).toHaveLength(1);
    await expectSameState(ops, keep);
  });

  it("garde les gagnants de CHAQUE champ, pas seulement la dernière op", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "Alpha", note: "à garder" });
      await log.write("p1", { name: "Beta" }); // ne réécrit pas `note`
    });

    const { keep, drop } = compact(ops);

    // Les deux survivent : la première reste seule détentrice de `note`.
    expect(drop).toHaveLength(0);
    expect(keep).toHaveLength(2);
    await expectSameState(ops, keep);
  });

  it("purge une op dont TOUS les champs ont été réécrits", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "Alpha", note: "ancienne" });
      await log.write("p1", { name: "Beta", note: "nouvelle" });
    });

    const { keep, drop } = compact(ops);

    expect(drop).toHaveLength(1);
    await expectSameState(ops, keep);
  });

  it("efface tout l'historique d'une ligne supprimée, sauf la pierre tombale", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "Alpha" });
      await log.write("p1", { name: "Beta" });
      await log.write("p1", { note: "annotée" });
      await log.remove("p1");
    });

    const { keep, drop } = compact(ops);

    expect(drop).toHaveLength(3);
    expect(keep).toHaveLength(1);
    expect(keep[0]?.kind).toBe("delete");
    await expectSameState(ops, keep);
  });

  it("garde la pierre tombale POUR TOUJOURS (sinon la ligne ressuscite)", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "Alpha" });
      await log.remove("p1");
    });

    const { keep } = compact(ops);
    expect(keep.some((op) => op.kind === "delete")).toBe(true);

    // Preuve par l'absurde : sans la pierre tombale, l'écriture antérieure
    // recréerait la ligne au rejeu.
    const sansTombe = ops.filter((op) => op.kind !== "delete");
    expect(await state(sansTombe)).not.toEqual(await state(ops));
  });

  it("conserve ce qui a été réécrit APRÈS la suppression", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "Alpha" });
      await log.remove("p1");
      await log.write("p1", { name: "recréée" });
    });

    const { keep } = compact(ops);
    await expectSameState(ops, keep);
    expect(await state(keep)).toEqual({ Projects: { p1: { name: "recréée" } } });
  });

  it("ne mélange ni les lignes ni les entités", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "un" });
      await log.write("p2", { name: "deux" });
      await log.write("p1", { name: "un-bis" });
      await log.write("u1", { name: "utilisateur" }, "Users");
      await log.write("u1", { name: "utilisateur-bis" }, "Users");
    });

    const { keep, drop } = compact(ops);

    expect(drop).toHaveLength(2);
    await expectSameState(ops, keep);
    expect(await state(keep)).toEqual({
      Projects: { p1: { name: "un-bis" }, p2: { name: "deux" } },
      Users: { u1: { name: "utilisateur-bis" } },
    });
  });

  it("un journal déjà compact ne perd rien", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "un" });
      await log.write("p2", { name: "deux" });
    });

    const { keep, drop } = compact(ops);
    expect(drop).toHaveLength(0);
    expect(keep).toHaveLength(2);
  });

  it("est idempotent : recompacter ne purge plus rien", async () => {
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "un" });
      await log.write("p1", { name: "deux" });
      await log.write("p2", { name: "trois" });
      await log.remove("p2");
    });

    const first = compact(ops);
    const second = compact(first.keep);

    expect(second.drop).toHaveLength(0);
    await expectSameState(ops, second.keep);
  });
});

describe("compactage — fenêtre de sécurité", () => {
  it("`before` protège les ops récentes, même perdantes", async () => {
    let pivot: Op["hlc"] | null = null;
    const ops = await journal(async (log) => {
      await log.write("p1", { name: "ancienne" });
      await log.write("p1", { name: "intermédiaire" });
      log.tick(10_000);
      await log.write("p1", { name: "récente" });
    });
    // Pivot : juste avant la dernière écriture.
    pivot = ops.at(-1)!.hlc;

    const sans = compact(ops);
    const avec = compact(ops, { before: pivot });

    expect(sans.drop).toHaveLength(2);
    expect(avec.drop).toHaveLength(2); // les deux anciennes restent purgeables
    await expectSameState(ops, avec.keep);

    // Un pivot placé au tout début ne laisse plus rien à purger.
    const debut = compact(ops, { before: ops[0]!.hlc });
    expect(debut.drop).toHaveLength(0);
  });
});

describe("compactage — épreuve aléatoire", () => {
  /** Générateur déterministe : un échec doit se rejouer à l'identique. */
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
      return s / 4_294_967_296;
    };
  }

  /** Sérialisation à clés triées : l'ordre d'insertion n'est pas de l'état. */
  function stable(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }

  it("préserve l'état sur 200 séquences quelconques d'écritures et suppressions", async () => {
    const ids = ["p1", "p2", "p3", "p4"];
    const champs = ["name", "note", "tag"];

    for (let graine = 1; graine <= 200; graine++) {
      const rand = rng(graine);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

      const ops = await journal(async (log) => {
        const coups = 5 + Math.floor(rand() * 20);
        for (let i = 0; i < coups; i++) {
          const id = pick(ids);
          if (rand() < 0.15) await log.remove(id);
          else {
            // Une op écrit un à trois champs — c'est ce qui rend la purge
            // par champ non triviale.
            const fields: Record<string, unknown> = {};
            const combien = 1 + Math.floor(rand() * champs.length);
            for (let f = 0; f < combien; f++) fields[pick(champs)] = i;
            await log.write(id, fields);
          }
          if (rand() < 0.2) log.tick(1 + Math.floor(rand() * 500));
        }
      });

      const { keep } = compact(ops);
      const attendu = stable(await state(ops));
      const obtenu = stable(await state(keep));
      if (obtenu !== attendu)
        throw new Error(
          `graine ${graine} : état divergent\nattendu ${attendu}\nobtenu  ${obtenu}`,
        );
    }
  });
});

describe("compactage — gain mesuré", () => {
  it("réduit massivement un journal fait de réécritures répétées", async () => {
    const ops = await journal(async (log) => {
      for (let round = 0; round < 50; round++)
        for (const id of ["p1", "p2", "p3"])
          await log.write(id, { name: `tour ${round}` });
    });

    const { keep, drop } = compact(ops);

    expect(ops).toHaveLength(150);
    expect(keep).toHaveLength(3); // une op par ligne survit
    expect(drop).toHaveLength(147);
    await expectSameState(ops, keep);
  });
});
