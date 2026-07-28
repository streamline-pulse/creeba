import { compareOps } from "./index.ts";
import type { Hlc, Op, OpStore, Projection, RowState, Stamp } from "./index.ts";

/**
 * Implémentations EN MÉMOIRE de l'`OpStore` et de la `Projection`. Elles ne
 * remplacent pas les adaptateurs applicatifs (Prisma, IndexedDB…) : elles
 * servent à exercer la convergence — rejeu, LWW par champ, échanges entre
 * plusieurs nœuds — sans base de données, donc de façon déterministe.
 */

function key(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}

export class MemoryOpStore implements OpStore {
  private readonly ops: Op[] = [];
  private clock: Hlc | null = null;
  private readonly rows = new Map<string, RowState>();

  async append(op: Op): Promise<void> {
    this.ops.push(op);
  }

  /** Journal trié par HLC — `sinceHlc` EXCLUT les ops déjà connues. */
  async list(opts?: { sinceHlc?: Hlc }): Promise<Op[]> {
    const sorted = [...this.ops].sort(compareOps);
    const since = opts?.sinceHlc;
    if (!since) return sorted;
    return sorted.filter(
      (op) =>
        op.hlc.wall > since.wall ||
        (op.hlc.wall === since.wall && op.hlc.counter > since.counter),
    );
  }

  async loadClock(): Promise<Hlc | null> {
    return this.clock;
  }

  async saveClock(hlc: Hlc): Promise<void> {
    this.clock = hlc;
  }

  async loadRowState(
    entity: string,
    entityId: string,
  ): Promise<RowState | null> {
    return this.rows.get(key(entity, entityId)) ?? null;
  }

  private row(entity: string, entityId: string): RowState {
    const k = key(entity, entityId);
    let state = this.rows.get(k);
    if (!state) {
      state = { fields: {}, deletedHlc: null };
      this.rows.set(k, state);
    }
    return state;
  }

  async saveFieldHlc(
    entity: string,
    entityId: string,
    field: string,
    stamp: Stamp,
  ): Promise<void> {
    this.row(entity, entityId).fields[field] = stamp;
  }

  async saveDeletedHlc(
    entity: string,
    entityId: string,
    stamp: Stamp,
  ): Promise<void> {
    this.row(entity, entityId).deletedHlc = stamp;
  }

  /** Nombre d'ops journalisées (diagnostic de test). */
  size(): number {
    return this.ops.length;
  }
}

/** Projection en mémoire : `entity -> entityId -> champs` (upsert MERGE). */
export class MemoryProjection implements Projection {
  readonly tables = new Map<string, Map<string, Record<string, unknown>>>();

  private table(entity: string): Map<string, Record<string, unknown>> {
    let rows = this.tables.get(entity);
    if (!rows) {
      rows = new Map();
      this.tables.set(entity, rows);
    }
    return rows;
  }

  async upsert(
    entity: string,
    entityId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const rows = this.table(entity);
    rows.set(entityId, { ...(rows.get(entityId) ?? {}), ...fields });
  }

  async remove(entity: string, entityId: string): Promise<void> {
    this.table(entity).delete(entityId);
  }

  /** Lignes d'une entité (diagnostic de test). */
  rows(entity: string): Record<string, Record<string, unknown>> {
    return Object.fromEntries(this.table(entity));
  }

  row(entity: string, entityId: string): Record<string, unknown> | undefined {
    return this.table(entity).get(entityId);
  }
}
