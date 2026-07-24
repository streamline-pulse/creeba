import type {
  OpStore,
  Op,
  Hlc,
  RowState,
  Stamp,
} from "@streamline-pulse/creeba-oplog";
import { delegate, type PrismaLike } from "./prisma_like";

const DELETED_FIELD = ":deleted";
const SEP = "::";

/**
 * Cle de SyncFieldState. `composite` : cle primaire (entity,entityId,field)
 * pour les connecteurs relationnels. `synthetic` : `_id` unique concatene pour
 * MongoDB, qui n'autorise pas de cle primaire composite.
 */
export type KeyStrategy = "composite" | "synthetic";

/** OpStore Prisma : SyncOps (journal) / SyncClock / SyncFieldState (etat par-champ). */
export class PrismaOpStore implements OpStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly keyStrategy: KeyStrategy = "composite"
  ) {}

  async append(op: Op): Promise<void> {
    await delegate(this.db, "syncOps").create({
      data: {
        id: op.id,
        hlcWall: BigInt(op.hlc.wall),
        hlcCounter: op.hlc.counter,
        nodeId: op.nodeId,
        actorId: op.actorId ?? null,
        orgId: op.orgId ?? null,
        entity: op.entity,
        entityId: op.entityId,
        kind: op.kind,
        fields: op.fields,
      },
    });
  }

  async list(opts?: { sinceHlc?: Hlc }): Promise<Op[]> {
    const since = opts?.sinceHlc;
    const rows = (await delegate(this.db, "syncOps").findMany({
      where: since
        ? {
            OR: [
              { hlcWall: { gt: BigInt(since.wall) } },
              { hlcWall: BigInt(since.wall), hlcCounter: { gt: since.counter } },
            ],
          }
        : undefined,
      orderBy: [{ hlcWall: "asc" }, { hlcCounter: "asc" }],
    })) as SyncOpRow[];
    return rows.map((row) => ({
      id: row.id,
      hlc: { wall: Number(row.hlcWall), counter: row.hlcCounter },
      nodeId: row.nodeId,
      actorId: row.actorId ?? undefined,
      orgId: row.orgId ?? undefined,
      entity: row.entity,
      entityId: row.entityId,
      kind: row.kind as Op["kind"],
      fields: (row.fields ?? {}) as Record<string, unknown>,
    }));
  }

  async loadClock(): Promise<Hlc | null> {
    const row = (await delegate(this.db, "syncClock").findUnique({
      where: { id: "singleton" },
    })) as { wall: bigint; counter: number } | null;
    return row ? { wall: Number(row.wall), counter: row.counter } : null;
  }

  async saveClock(hlc: Hlc): Promise<void> {
    await delegate(this.db, "syncClock").upsert({
      where: { id: "singleton" },
      create: { id: "singleton", wall: BigInt(hlc.wall), counter: hlc.counter },
      update: { wall: BigInt(hlc.wall), counter: hlc.counter },
    });
  }

  async loadRowState(entity: string, entityId: string): Promise<RowState | null> {
    const rows = (await delegate(this.db, "syncFieldState").findMany({
      where: { entity, entityId },
    })) as SyncFieldStateRow[];
    if (rows.length === 0) return null;
    const fields: Record<string, Stamp> = {};
    let deletedHlc: Stamp | null = null;
    for (const row of rows) {
      const stamp: Stamp = {
        hlc: { wall: Number(row.hlcWall), counter: row.hlcCounter },
        nodeId: row.nodeId,
      };
      if (row.field === DELETED_FIELD) deletedHlc = stamp;
      else fields[row.field] = stamp;
    }
    return { fields, deletedHlc };
  }

  saveFieldHlc(
    entity: string,
    entityId: string,
    field: string,
    stamp: Stamp
  ): Promise<void> {
    return this.putStamp(entity, entityId, field, stamp);
  }

  saveDeletedHlc(entity: string, entityId: string, stamp: Stamp): Promise<void> {
    return this.putStamp(entity, entityId, DELETED_FIELD, stamp);
  }

  private async putStamp(
    entity: string,
    entityId: string,
    field: string,
    stamp: Stamp
  ): Promise<void> {
    const data = {
      hlcWall: BigInt(stamp.hlc.wall),
      hlcCounter: stamp.hlc.counter,
      nodeId: stamp.nodeId,
    };
    const model = delegate(this.db, "syncFieldState");
    if (this.keyStrategy === "synthetic") {
      const id = [entity, entityId, field].join(SEP);
      await model.upsert({
        where: { id },
        create: { id, entity, entityId, field, ...data },
        update: data,
      });
      return;
    }
    await model.upsert({
      where: { entity_entityId_field: { entity, entityId, field } },
      create: { entity, entityId, field, ...data },
      update: data,
    });
  }
}

interface SyncOpRow {
  id: string;
  hlcWall: bigint;
  hlcCounter: number;
  nodeId: string;
  actorId: string | null;
  orgId: string | null;
  entity: string;
  entityId: string;
  kind: string;
  fields: unknown;
}

interface SyncFieldStateRow {
  entity: string;
  entityId: string;
  field: string;
  hlcWall: bigint;
  hlcCounter: number;
  nodeId: string;
}
