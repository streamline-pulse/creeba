---
"@streamline-pulse/creeba-mesh": patch
---

fix(mesh): le cloisonnement par org vaut aussi à la RÉCEPTION — un op n'est appliqué que si l'expéditeur est de confiance pour son org (`mayServe` sur le pair émetteur, en plus de `mayAccept`). Avant, un nœud multi-org pouvait servir de point d'injection vers une org que le pair émetteur ne couvrait pas. Supprime aussi `servedTo`/`noteServed`, état write-only resté après le retrait de `pushOpsTo`.
