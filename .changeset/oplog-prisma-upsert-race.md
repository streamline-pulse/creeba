---
"@streamline-pulse/creeba-oplog-prisma": patch
---

fix(oplog-prisma): la projection retombe sur une mise à jour quand son `create` perd la course contre une écriture concurrente (P2002) — l'erreur ne remonte plus au mesh, qui la prenait pour une dépendance manquante et pouvait finir par abandonner l'op.
