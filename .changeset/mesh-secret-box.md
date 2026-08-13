---
"@streamline-pulse/creeba-mesh": minor
---

feat(mesh): `encryptSecret`/`decryptSecret` (XChaCha20-Poly1305) + `newSecretKey`/`isEncryptedSecret` — chiffrement symétrique authentifié pour garder des secrets de champ (mots de passe de connecteurs, tokens) hors d'un journal synchronisé en clair. Format versionné, nonce aléatoire de 192 bits, ciphertext falsifié rejeté à l'ouverture.

feat(mesh): le message de pairing `join-grant` porte un champ optionnel `secrets` (Record opaque) pour livrer du matériel secret d'app (ex. une clé de données d'org) avec le cert, sur le canal de pairing authentifié.
