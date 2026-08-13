import { describe, expect, it } from "bun:test";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  newSecretKey,
} from "./src/index.ts";

describe("secret box — round-trip", () => {
  it("chiffre puis déchiffre une chaîne ASCII", () => {
    const key = newSecretKey();
    const sealed = encryptSecret(key, "super-secret-password");
    expect(decryptSecret(key, sealed)).toBe("super-secret-password");
  });

  it("préserve l'unicode et les chaînes vides", () => {
    const key = newSecretKey();
    for (const plain of ["", "🔐 møt de påsse", "a".repeat(5000)]) {
      expect(decryptSecret(key, encryptSecret(key, plain))).toBe(plain);
    }
  });

  it("deux chiffrements du même clair diffèrent (nonce aléatoire)", () => {
    const key = newSecretKey();
    const a = encryptSecret(key, "x");
    const b = encryptSecret(key, "x");
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a)).toBe("x");
    expect(decryptSecret(key, b)).toBe("x");
  });

  it("accepte une clé fournie en Uint8Array comme en number[]", () => {
    const arr = newSecretKey();
    const sealed = encryptSecret(Uint8Array.from(arr), "v");
    expect(decryptSecret(arr, sealed)).toBe("v");
  });
});

describe("secret box — échecs d'authentification", () => {
  it("une mauvaise clé ne déchiffre pas (throw, jamais de garbage)", () => {
    const sealed = encryptSecret(newSecretKey(), "secret");
    expect(() => decryptSecret(newSecretKey(), sealed)).toThrow();
  });

  it("un ciphertext falsifié échoue", () => {
    const key = newSecretKey();
    const sealed = encryptSecret(key, "secret");
    // Flip du dernier octet (dans le tag/ciphertext).
    const flipped =
      sealed.slice(0, -2) +
      (Number.parseInt(sealed.slice(-2), 16) ^ 0xff).toString(16).padStart(2, "0");
    expect(() => decryptSecret(key, flipped)).toThrow();
  });

  it("un nonce falsifié échoue", () => {
    const key = newSecretKey();
    const sealed = encryptSecret(key, "secret");
    // Octet 1 = premier octet du nonce (après le byte de version).
    const flipped =
      sealed.slice(0, 2) +
      (Number.parseInt(sealed.slice(2, 4), 16) ^ 0xff).toString(16).padStart(2, "0") +
      sealed.slice(4);
    expect(() => decryptSecret(key, flipped)).toThrow();
  });

  it("rejette une version inconnue", () => {
    const key = newSecretKey();
    const sealed = encryptSecret(key, "secret");
    const badVersion = "ff" + sealed.slice(2);
    expect(() => decryptSecret(key, badVersion)).toThrow(/version/);
  });

  it("rejette un blob trop court", () => {
    expect(() => decryptSecret(newSecretKey(), "0100")).toThrow(/too short/);
  });

  it("rejette une clé de mauvaise longueur", () => {
    expect(() => encryptSecret([1, 2, 3], "x")).toThrow(/32 bytes/);
  });
});

describe("secret box — inter-nœud (même clé, instances différentes)", () => {
  it("un secret chiffré sur un nœud se déchiffre sur un autre partageant la clé", () => {
    // La clé (DEK d'org) est le SEUL matériel partagé ; le ciphertext transite
    // en clair par l'oplog/relais et reste opaque sans elle.
    const dek = newSecretKey();
    const onNodeA = encryptSecret(dek, "pg-password");
    // « Nœud B » : mêmes octets de clé, aucune autre coordination.
    const onNodeB = decryptSecret([...dek], onNodeA);
    expect(onNodeB).toBe("pg-password");
  });
});

describe("secret box — isEncryptedSecret", () => {
  it("reconnaît une sortie d'encryptSecret", () => {
    expect(isEncryptedSecret(encryptSecret(newSecretKey(), "x"))).toBe(true);
  });

  it("rejette du texte clair, un non-hex, un non-string", () => {
    expect(isEncryptedSecret("motdepasse")).toBe(false);
    expect(isEncryptedSecret("")).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
    expect(isEncryptedSecret(42)).toBe(false);
    // Bon préfixe mais trop court pour être un vrai ciphertext.
    expect(isEncryptedSecret("0102")).toBe(false);
  });
});
