import type { Projection } from "@streamline-pulse/creeba-oplog";
import { type PrismaLike, type PrismaDelegate } from "./prisma_like.ts";

/**
 * Materialise les ops dans les tables du domaine, adressees par nom d'entite.
 * Update-then-create : une maj partielle ne porte pas les champs requis, donc
 * `upsert` (qui valide toujours la branche create) ne convient pas.
 */
export class PrismaProjection implements Projection {
  constructor(private readonly db: PrismaLike) {}

  private model(entity: string): PrismaDelegate {
    const key = entity.charAt(0).toLowerCase() + entity.slice(1);
    const d = (this.db as Record<string, unknown>)[key];
    if (!d) throw new Error(`creeba-oplog-prisma: entite inconnue "${entity}"`);
    return d as PrismaDelegate;
  }

  async upsert(
    entity: string,
    entityId: string,
    fields: Record<string, unknown>
  ): Promise<void> {
    const model = this.model(entity);
    const { count } = await model.updateMany({
      where: { id: entityId },
      data: fields,
    });
    if (count > 0) return;
    try {
      await model.create({ data: { id: entityId, ...fields } });
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      // Une autre écriture a créé la ligne entre notre updateMany et notre
      // create (deux nœuds appliquant le même op en parallèle) : elle existe
      // maintenant, donc on retente la mise à jour au lieu de laisser
      // remonter une erreur — sinon le mesh la traite comme une dépendance
      // manquante et peut finir par abandonner un op pourtant applicable.
      const retry = await model.updateMany({
        where: { id: entityId },
        data: fields,
      });
      if (retry.count === 0) throw error;
    }
  }

  async remove(entity: string, entityId: string): Promise<void> {
    await this.model(entity).updateMany({
      where: { id: entityId },
      data: { deleted: true },
    });
  }
}

/** Duck-typé : ce binding ne dépend pas de `@prisma/client` (voir prisma_like.ts). */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
