import { describe, expect, it } from "bun:test";
import {
  advance,
  isMissingFrom,
  vectorFrom,
  type VersionVector,
} from "./src/index.ts";
import type { Op } from "@streamline-pulse/creeba-oplog";

/**
 * Le curseur de rattrapage. L'enjeu n'est pas l'économie de bande passante — il
 * est de ne RIEN sauter : un curseur mal choisi perd des ops silencieusement,
 * et c'est le genre de bug qu'on ne voit que des semaines plus tard.
 */

function op(nodeId: string, wall: number, counter = 0): Op {
  return {
    id: `${nodeId}-${wall}-${counter}`,
    hlc: { wall, counter },
    nodeId,
    entity: "Projects",
    entityId: "p1",
    kind: "upsert",
    fields: {},
  };
}

describe("vecteur de version", () => {
  it("sans vecteur (pair d'une version antérieure), tout est à servir", () => {
    expect(isMissingFrom(op("a", 100), undefined)).toBe(true);
  });

  it("ne sert pas ce que le demandeur détient déjà", () => {
    const vv: VersionVector = { a: { wall: 100, counter: 0 } };
    expect(isMissingFrom(op("a", 50), vv)).toBe(false);
    expect(isMissingFrom(op("a", 100), vv)).toBe(false); // l'op pivot elle-même
    expect(isMissingFrom(op("a", 101), vv)).toBe(true);
  });

  it("départage sur le compteur à horloge murale égale", () => {
    const vv: VersionVector = { a: { wall: 100, counter: 3 } };
    expect(isMissingFrom(op("a", 100, 3), vv)).toBe(false);
    expect(isMissingFrom(op("a", 100, 4), vv)).toBe(true);
  });

  it("une origine INCONNUE est toujours à servir, même avec une HLC ancienne", () => {
    // Le cœur du sujet : un curseur global sur la plus haute HLC vue aurait
    // sauté cette op — elle est plus ancienne que tout ce que le demandeur
    // possède, mais elle vient d'un nœud dont il n'a jamais rien vu.
    const vv: VersionVector = { a: { wall: 9_000, counter: 0 } };
    expect(isMissingFrom(op("c", 10), vv)).toBe(true);
  });

  it("n'avance que vers l'avant (une op ancienne ne fait pas reculer)", () => {
    const vv: VersionVector = {};
    advance(vv, op("a", 100));
    advance(vv, op("a", 50));
    expect(vv.a).toEqual({ wall: 100, counter: 0 });
  });

  it("se reconstruit depuis un journal, par origine", () => {
    const vv = vectorFrom([
      op("a", 10),
      op("b", 900),
      op("a", 40),
      op("b", 20),
    ]);
    expect(vv).toEqual({
      a: { wall: 40, counter: 0 },
      b: { wall: 900, counter: 0 },
    });
  });
});
