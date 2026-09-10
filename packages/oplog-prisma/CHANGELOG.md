# @streamline-pulse/creeba-oplog-prisma

## 6.0.1

### Patch Changes

- @streamline-pulse/creeba-oplog@6.0.1

## 6.0.0

### Patch Changes

- b54f20b: fix(oplog-prisma): la projection retombe sur une mise à jour quand son `create` perd la course contre une écriture concurrente (P2002) — l'erreur ne remonte plus au mesh, qui la prenait pour une dépendance manquante et pouvait finir par abandonner l'op.
  - @streamline-pulse/creeba-oplog@6.0.0

## 5.0.1

### Patch Changes

- @streamline-pulse/creeba-oplog@5.0.1

## 5.0.0

### Patch Changes

- Updated dependencies [b76199e]
  - @streamline-pulse/creeba-oplog@5.0.0

## 4.0.0

### Patch Changes

- Updated dependencies [c02ca4d]
  - @streamline-pulse/creeba-oplog@4.0.0

## 3.0.0

### Patch Changes

- @streamline-pulse/creeba-oplog@3.0.0

## 2.0.0

### Patch Changes

- @streamline-pulse/creeba-oplog@2.0.0

## 1.0.0

### Patch Changes

- @streamline-pulse/creeba-oplog@1.0.0
