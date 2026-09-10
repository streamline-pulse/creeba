import { describe, expect, it } from "bun:test";
import { batchBySize } from "./src/index.ts";

/**
 * Une réponse de rattrapage doit rester sous la limite de trame du transport :
 * un seul message trop gros est rejeté par le receveur, qui coupe le pair et
 * redemande la même chose indéfiniment.
 */
describe("batchBySize", () => {
  const op = (n: number, size: number) => ({ id: n, payload: "x".repeat(size) });

  it("keeps one batch when everything fits", () => {
    const ops = [op(1, 10), op(2, 10), op(3, 10)];
    expect(batchBySize(ops, 1_000)).toEqual([ops]);
  });

  it("splits into consecutive batches under the bound, preserving order", () => {
    const ops = Array.from({ length: 10 }, (_, i) => op(i, 100));
    const batches = batchBySize(ops, 350);
    expect(batches.flat()).toEqual(ops);
    for (const b of batches)
      expect(JSON.stringify(b).length).toBeLessThanOrEqual(350 + b.length + 2);
    expect(batches.length).toBeGreaterThan(1);
  });

  it("still sends an op larger than the bound, alone in its batch", () => {
    const big = op(1, 5_000);
    const batches = batchBySize([op(0, 10), big, op(2, 10)], 200);
    expect(batches.some((b) => b.length === 1 && b[0] === big)).toBe(true);
    expect(batches.flat()).toHaveLength(3);
  });

  it("returns nothing for no ops", () => {
    expect(batchBySize([], 100)).toEqual([]);
  });
});
