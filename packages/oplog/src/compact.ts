import { compareOps } from "./index.ts";
import type { Hlc, Op } from "./index.ts";

/**
 * Compactage du journal. Sans purge, le journal ne fait que grossir — et c'est
 * lui qu'on relit à chaque rejeu et qu'on sert aux pairs qui rattrapent.
 *
 * La garantie, et c'est la seule qui compte : **rejouer `keep` donne exactement
 * le même état que rejouer tout**. Une op n'est purgée que si elle ne peut plus
 * influencer quoi que ce soit — chacun de ses champs a été réécrit depuis, ou
 * sa ligne a été supprimée après elle.
 */

export interface CompactOptions {
  /**
   * Ne purger que ce qui est STRICTEMENT antérieur à ce point. Une op récente
   * est conservée même si elle a perdu.
   *
   * Utile parce que la purge n'est pas gratuite pour le maillage : un pair qui
   * n'a jamais vu ces ops les redemandera (son curseur ne connaît pas ce nœud
   * d'origine), et on n'aura plus rien à lui servir. Il convergera quand même —
   * les ops gagnantes portent l'état final — mais garder une fenêtre récente
   * évite ce va-et-vient tant que le parc n'a pas rattrapé.
   */
  before?: Hlc;
}

export interface CompactResult {
  keep: Op[];
  drop: Op[];
}

function isBefore(a: Hlc, b: Hlc): boolean {
  if (a.wall !== b.wall) return a.wall < b.wall;
  return a.counter < b.counter;
}

function rowKey(op: Op): string {
  return `${op.entity} ${op.entityId}`;
}

/**
 * Sépare le journal en « à garder » / « purgeable ». Fonction PURE : elle
 * n'écrit rien. L'application supprime les `drop` comme elle l'entend — le port
 * `OpStore` n'a pas à connaître la suppression.
 */
export function compact(
  ops: Op[],
  options: CompactOptions = {},
): CompactResult {
  const sorted = [...ops].sort(compareOps);

  const rows = new Map<string, Op[]>();
  for (const op of sorted) {
    const key = rowKey(op);
    const list = rows.get(key);
    if (list) list.push(op);
    else rows.set(key, [op]);
  }

  const keep = new Set<Op>();
  for (const rowOps of rows.values()) {
    // La dernière suppression fait table rase : tout ce qui la précède est sans
    // effet, quelle que soit la valeur écrite. Elle, en revanche, doit survivre
    // pour toujours — sans elle, une écriture ancienne ressusciterait la ligne.
    let lastDelete: Op | undefined;
    for (const op of rowOps) if (op.kind === "delete") lastDelete = op;

    const live = lastDelete
      ? rowOps.filter((op) => compareOps(op, lastDelete) > 0)
      : rowOps;
    if (lastDelete) keep.add(lastDelete);

    // Gagnant par CHAMP : les ops sont triées, le dernier écrivain l'emporte.
    // Une op qui ne gagne sur aucun champ n'apporte plus rien.
    const winners = new Map<string, Op>();
    for (const op of live)
      if (op.kind === "upsert")
        for (const field of Object.keys(op.fields)) winners.set(field, op);
    for (const op of winners.values()) keep.add(op);
  }

  const kept: Op[] = [];
  const dropped: Op[] = [];
  for (const op of sorted) {
    const recent = options.before ? !isBefore(op.hlc, options.before) : false;
    if (recent || keep.has(op)) kept.push(op);
    else dropped.push(op);
  }
  return { keep: kept, drop: dropped };
}
