/**
 * Typage STRUCTUREL du client Prisma : le binding ne dépend d'aucun client
 * généré d'app. N'importe quel PrismaClient (relationnel ou Mongo) satisfait
 * cette forme. Les délégués sont accédés par nom de modèle.
 */
export interface PrismaDelegate {
  create: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
  upsert: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
  findUnique: (args: unknown) => Promise<unknown>;
  findMany: (args: unknown) => Promise<unknown[]>;
}

export interface PrismaLike {
  $extends: (ext: unknown) => unknown;
  [delegate: string]: unknown;
}

export function delegate(db: PrismaLike, model: string): PrismaDelegate {
  const d = (db as Record<string, unknown>)[model];
  if (!d) throw new Error(`creeba-oplog-prisma: modèle Prisma introuvable "${model}"`);
  return d as PrismaDelegate;
}
