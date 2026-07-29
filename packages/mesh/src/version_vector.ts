import type { Hlc, Op } from "@streamline-pulse/creeba-oplog";

/**
 * Vecteur de version : la plus haute HLC connue POUR CHAQUE nœud d'origine.
 *
 * Un curseur global unique serait plus simple mais FAUX. Les ops sont ordonnées
 * par HLC, pas par ordre d'arrivée : un pair peut apprendre tardivement une op
 * ancienne venue d'un troisième nœud. Avec un curseur global déjà avancé, cette
 * op passe dessous et n'est jamais réclamée — alors que le rattrapage
 * périodique existe précisément pour ces cas-là.
 *
 * Un curseur par origine n'a pas ce trou : on ne saute que ce qu'on a vraiment
 * vu de ce nœud-là.
 */
export type VersionVector = Record<string, Hlc>;

/**
 * Comparaison d'HLC. Réimplémentée ici plutôt qu'importée de creeba-oplog :
 * l'op-log n'est qu'une dépendance de TYPES du maillage, et l'importer pour
 * quatre lignes en ferait une dépendance d'exécution.
 */
function isAfter(a: Hlc, b: Hlc): boolean {
  if (a.wall !== b.wall) return a.wall > b.wall;
  return a.counter > b.counter;
}

/** Cette op nous manque-t-elle, au vu de ce que le demandeur déclare connaître ? */
export function isMissingFrom(op: Op, vv: VersionVector | undefined): boolean {
  if (!vv) return true; // pair d'une version antérieure : on lui sert tout
  const known = vv[op.nodeId];
  return !known || isAfter(op.hlc, known);
}

/** Note qu'on connaît cette op (qu'elle ait été appliquée ou jugée périmée). */
export function advance(vv: VersionVector, op: Op): void {
  const known = vv[op.nodeId];
  if (!known || isAfter(op.hlc, known)) vv[op.nodeId] = op.hlc;
}

/** Vecteur reconstruit depuis un journal (au démarrage). */
export function vectorFrom(ops: Iterable<Op>): VersionVector {
  const vv: VersionVector = {};
  for (const op of ops) advance(vv, op);
  return vv;
}
