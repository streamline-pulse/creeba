/**
 * Portable op-log for local-first apps — persistence-agnostic.
 *
 * The app owns its database: it plugs an `OpStore` (where ops + clock live) and
 * a `Projection` (how ops materialize into its tables). This module knows
 * nothing about SQL, Prisma or any ORM — it only orchestrates a hybrid logical
 * clock and last-writer-wins convergence over those two interfaces.
 *
 *   const oplog = new OpLog(store, nodeId, { newId, now });
 *   await oplog.init();
 *   await oplog.record({ entity: "Projects", entityId, kind: "upsert", fields });
 *   await replay(await store.list(), projection);   // rebuild state
 */

export interface Hlc {
  wall: number;
  counter: number;
}

export type OpKind = "upsert" | "delete";

export interface Op {
  id: string;
  hlc: Hlc;
  nodeId: string;
  actorId?: string;
  orgId?: string;
  entity: string;
  entityId: string;
  kind: OpKind;
  fields: Record<string, unknown>;
}

/** Total order over HLCs, node-id as final tiebreaker. */
export function compareHlc(a: Hlc, b: Hlc, aNode = "", bNode = ""): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return aNode < bNode ? -1 : aNode > bNode ? 1 : 0;
}

export function compareOps(a: Op, b: Op): number {
  return compareHlc(a.hlc, b.hlc, a.nodeId, b.nodeId);
}

export class HybridLogicalClock {
  private state: Hlc;

  constructor(initial: Hlc = { wall: 0, counter: 0 }) {
    this.state = { ...initial };
  }

  get current(): Hlc {
    return { ...this.state };
  }

  /** Local event: monotonic, never goes backwards even if the wall clock does. */
  tick(nowMs: number): Hlc {
    const wall = Math.max(nowMs, this.state.wall);
    const counter = wall === this.state.wall ? this.state.counter + 1 : 0;
    this.state = { wall, counter };
    return this.current;
  }

  /** Merge a remote HLC on receipt (used when applying remote ops). */
  receive(remote: Hlc, nowMs: number): Hlc {
    const wall = Math.max(nowMs, this.state.wall, remote.wall);
    let counter: number;
    if (wall === this.state.wall && wall === remote.wall)
      counter = Math.max(this.state.counter, remote.counter) + 1;
    else if (wall === this.state.wall) counter = this.state.counter + 1;
    else if (wall === remote.wall) counter = remote.counter + 1;
    else counter = 0;
    this.state = { wall, counter };
    return this.current;
  }
}

/** Where the journal, the clock and the per-row applied-HLC live. App-provided. */
export interface OpStore {
  append: (op: Op) => Promise<void>;
  list: (opts?: { sinceHlc?: Hlc }) => Promise<Op[]>;
  loadClock: () => Promise<Hlc | null>;
  saveClock: (hlc: Hlc) => Promise<void>;
  getAppliedHlc: (entity: string, entityId: string) => Promise<Hlc | null>;
  setAppliedHlc: (entity: string, entityId: string, hlc: Hlc) => Promise<void>;
}

/** How an op materializes into the app's tables. App-provided. `upsert` MERGES. */
export interface Projection {
  upsert: (
    entity: string,
    entityId: string,
    fields: Record<string, unknown>
  ) => Promise<void>;
  remove: (entity: string, entityId: string) => Promise<void>;
}

export interface RecordInput {
  entity: string;
  entityId: string;
  kind: OpKind;
  fields?: Record<string, unknown>;
  actorId?: string;
  orgId?: string;
}

export interface OpLogDeps {
  newId: () => string;
  now: () => number;
}

export class OpLog {
  private clock = new HybridLogicalClock();

  constructor(
    private readonly store: OpStore,
    private readonly nodeId: string,
    private readonly deps: OpLogDeps
  ) {}

  /** Restore the persisted clock so HLCs stay monotonic across restarts. */
  async init(): Promise<void> {
    const saved = await this.store.loadClock();
    if (saved) this.clock = new HybridLogicalClock(saved);
  }

  /** Journal a local mutation. Returns the created op. */
  async record(input: RecordInput): Promise<Op> {
    const hlc = this.clock.tick(this.deps.now());
    await this.store.saveClock(hlc);
    const op: Op = {
      id: this.deps.newId(),
      hlc,
      nodeId: this.nodeId,
      actorId: input.actorId,
      orgId: input.orgId,
      entity: input.entity,
      entityId: input.entityId,
      kind: input.kind,
      fields: input.fields ?? {},
    };
    await this.store.append(op);
    await this.store.setAppliedHlc(op.entity, op.entityId, hlc);
    return op;
  }

  /**
   * Apply a remote op (Phase 3). LWW: ignored if an equal/newer HLC was already
   * applied to that row. Returns whether it was applied.
   */
  async applyRemote(op: Op, projection: Projection): Promise<boolean> {
    this.clock.receive(op.hlc, this.deps.now());
    await this.store.saveClock(this.clock.current);

    const applied = await this.store.getAppliedHlc(op.entity, op.entityId);
    if (applied && compareHlc(op.hlc, applied, op.nodeId, op.nodeId) <= 0)
      return false;

    if (op.kind === "delete") await projection.remove(op.entity, op.entityId);
    else await projection.upsert(op.entity, op.entityId, op.fields);

    await this.store.setAppliedHlc(op.entity, op.entityId, op.hlc);
    await this.store.append(op);
    return true;
  }
}

/** Rebuild state from a set of ops (HLC-ordered). Used for the replay proof. */
export async function replay(
  ops: Op[],
  projection: Projection
): Promise<void> {
  for (const op of [...ops].sort(compareOps)) {
    if (op.kind === "delete") await projection.remove(op.entity, op.entityId);
    else await projection.upsert(op.entity, op.entityId, op.fields);
  }
}
