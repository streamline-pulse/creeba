/**
 * Binding Prisma pour @streamline-pulse/creeba-oplog. Capture transparente des
 * mutations via $extends, plus un OpStore et une Projection prets a l'emploi.
 * L'app ne fournit qu'une config (liste d'entites synchronisables + identite).
 *
 *   const oplog = createOpLog(baseClient, {
 *     nodeId: myNodeId,
 *     syncable: [{ model: "projects", entity: "Projects", orgField: "groupId" }],
 *   });
 *   export const prismaClient = oplog.client as PrismaClient; // capture active
 *
 * Relationnel (pg/mysql/sqlite/cockroach) : keyStrategy "composite" (defaut).
 * MongoDB : keyStrategy "synthetic". Voir prisma/relational.prisma et
 * prisma/mongo.prisma pour les 3 modeles d'infra a ajouter au schema.
 */
import { OpLog, type Op, type OpKind } from "@streamline-pulse/creeba-oplog";
import { PrismaOpStore, type KeyStrategy } from "./op_store";
import { PrismaProjection } from "./projection";
import type { PrismaLike } from "./prisma_like";

export type { PrismaLike, PrismaDelegate } from "./prisma_like";
export { PrismaOpStore, type KeyStrategy } from "./op_store";
export { PrismaProjection } from "./projection";

/** Un modele synchronisable : accessor (camelCase), entity (nom du modele), champ d'org. */
export interface SyncableEntity {
  model: string;
  entity: string;
  orgField: string;
}

export interface OpLogConfig {
  syncable: SyncableEntity[];
  nodeId: string;
  keyStrategy?: KeyStrategy;
  volatile?: string[];
  newId?: () => string;
  now?: () => number;
  currentActorId?: () => string | undefined;
}

export interface PrismaOpLog {
  /** Client etendu : les datasources l'utilisent, la capture est transparente. */
  client: unknown;
  oplog: OpLog;
  store: PrismaOpStore;
  projection: PrismaProjection;
  ready: Promise<void>;
  onLocalOp: (listener: (op: Op) => void) => void;
}

const DEFAULT_VOLATILE = ["id", "createdAt", "updatedAt"];

interface Hook {
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

export function createOpLog(
  base: PrismaLike,
  config: OpLogConfig
): PrismaOpLog {
  const volatile = new Set(config.volatile ?? DEFAULT_VOLATILE);
  const newId = config.newId ?? (() => crypto.randomUUID());
  const now = config.now ?? ((): number => Date.now());
  const actor = config.currentActorId ?? ((): string | undefined => undefined);

  let listener: ((op: Op) => void) | null = null;
  const store = new PrismaOpStore(base, config.keyStrategy ?? "composite");
  const projection = new PrismaProjection(base);
  const oplog = new OpLog(store, config.nodeId, {
    newId,
    now,
    onLocalOp: (op) => listener?.(op),
  });
  const ready = oplog.init();

  async function record(
    entity: string,
    orgField: string,
    row: unknown,
    changed?: Set<string>
  ): Promise<void> {
    try {
      await ready;
      const r = row as Record<string, unknown>;
      const kind: OpKind = r.deleted === true ? "delete" : "upsert";
      const fields: Record<string, unknown> = {};
      if (kind === "upsert") {
        const keys = changed ?? new Set(Object.keys(r));
        for (const k of keys)
          if (!volatile.has(k) && k in r) fields[k] = r[k];
      }
      await oplog.record({
        entity,
        entityId: String(r.id),
        kind,
        fields,
        orgId: (r[orgField] as string | undefined) ?? undefined,
        actorId: actor(),
      });
    } catch (error) {
      console.warn(`[oplog] journalisation echouee (${entity}) : ${error}`);
    }
  }

  const query: Record<string, unknown> = {};
  for (const { model, entity, orgField } of config.syncable) {
    const full = async ({ args, query: run }: Hook): Promise<unknown> => {
      const r = await run(args);
      await record(entity, orgField, r);
      return r;
    };
    const delta = async ({ args, query: run }: Hook): Promise<unknown> => {
      const r = await run(args);
      await record(entity, orgField, r, changedKeys(args));
      return r;
    };
    query[model] = { create: full, update: delta, upsert: full };
  }

  const client = base.$extends({ query });

  return {
    client,
    oplog,
    store,
    projection,
    ready,
    onLocalOp: (fn) => {
      listener = fn;
    },
  };
}

/** Champs explicitement ecrits par l'appelant (data/create/update). */
function changedKeys(args: unknown): Set<string> {
  const a = args as { data?: object; create?: object; update?: object };
  const keys = new Set<string>();
  for (const src of [a?.data, a?.create, a?.update])
    if (src && typeof src === "object")
      for (const k of Object.keys(src)) keys.add(k);
  return keys;
}
