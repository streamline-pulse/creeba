import type { PrismaDelegate, PrismaLike } from "./src/prisma_like.ts";

/**
 * Double de test structurel : réimplémente juste assez du comportement Prisma
 * (create/upsert/updateMany/findUnique/findMany, erreur P2002 sur collision de
 * clé) pour exercer `PrismaOpStore`/`PrismaProjection` sans base réelle — le
 * binding ne dépend lui-même d'aucun client généré (voir prisma_like.ts), donc
 * un vrai `PrismaClient` n'est pas nécessaire pour le tester non plus.
 */

type Row = Record<string, unknown>;

function uniqueConstraintError(): Error {
  const err = new Error("Unique constraint failed on the fields: (`id`)");
  (err as { code?: string }).code = "P2002";
  return err;
}

function matchesWhere(row: Row, where: Row): boolean {
  if ("OR" in where)
    return (where.OR as Row[]).some((clause) => matchesWhere(row, clause));
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "gt" in value)
      return (row[key] as bigint | number) > (value as { gt: bigint | number }).gt;
    return row[key] === value;
  });
}

/** Aplati les clés uniques composées Prisma (`{ a_b_c: { a, b, c } }`) en un objet plat. */
function flattenWhere(where: Row): Row {
  const flat: Row = {};
  for (const [key, value] of Object.entries(where)) {
    if (value && typeof value === "object" && !Array.isArray(value))
      Object.assign(flat, value as Row);
    else flat[key] = value;
  }
  return flat;
}

/** `PrismaDelegate` prend `args: unknown` (typage structurel délibéré, voir prisma_like.ts) — chaque méthode affine ensuite localement. */
export class FakeTable implements PrismaDelegate {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly pkOf: (row: Row) => string) {}

  async create(args: unknown): Promise<Row> {
    const { data } = args as { data: Row };
    const key = this.pkOf(data);
    if (this.rows.has(key)) throw uniqueConstraintError();
    const row = { ...data };
    this.rows.set(key, row);
    return row;
  }

  async update(args: unknown): Promise<Row> {
    const { where, data } = args as { where: Row; data: Row };
    const row = this.rows.get(this.pkOf(flattenWhere(where)));
    if (!row) throw new Error("Record not found");
    Object.assign(row, data);
    return row;
  }

  async upsert(args: unknown): Promise<Row> {
    const { where, create, update } = args as { where: Row; create: Row; update: Row };
    const key = this.pkOf(flattenWhere(where));
    const existing = this.rows.get(key);
    if (existing) {
      Object.assign(existing, update);
      return existing;
    }
    const row = { ...create };
    this.rows.set(this.pkOf(row), row);
    return row;
  }

  async updateMany(args: unknown): Promise<{ count: number }> {
    const { where, data } = args as { where: Row; data: Row };
    let count = 0;
    for (const row of this.rows.values())
      if (matchesWhere(row, where)) {
        Object.assign(row, data);
        count++;
      }
    return { count };
  }

  async findUnique(args: unknown): Promise<Row | null> {
    const { where } = args as { where: Row };
    return this.rows.get(this.pkOf(flattenWhere(where))) ?? null;
  }

  async findMany(args?: unknown): Promise<Row[]> {
    const { where, orderBy } = (args ?? {}) as { where?: Row; orderBy?: Row[] };
    let result = [...this.rows.values()].filter((r) => !where || matchesWhere(r, where));
    if (orderBy?.length)
      result = [...result].sort((a, b) => {
        for (const clause of orderBy)
          for (const [key, dir] of Object.entries(clause)) {
            const av = a[key] as never;
            const bv = b[key] as never;
            if (av < bv) return dir === "asc" ? -1 : 1;
            if (av > bv) return dir === "asc" ? 1 : -1;
          }
        return 0;
      });
    return result.map((r) => ({ ...r }));
  }
}

export class FakeClient implements PrismaLike {
  [model: string]: unknown;
  syncOps = new FakeTable((r) => String(r.id));
  syncClock = new FakeTable((r) => String(r.id));
  /**
   * Composite (pas de `id`) : clé dérivée de (entity, entityId, field), comme
   * le ferait une vraie clé primaire composée. Synthétique : `id` fourni tel
   * quel — c'est justement la même info déjà concaténée côté appelant.
   */
  syncFieldState = new FakeTable((r) =>
    typeof r.id === "string"
      ? r.id
      : `${r.entity as string}::${r.entityId as string}::${r.field as string}`,
  );
  projects = new FakeTable((r) => String(r.id));

  $extends(): unknown {
    throw new Error("FakeClient: $extends non simulé — inutile pour ces tests");
  }
}
