import { describe, expect, it } from "bun:test";
import { decodeFrame, encodeFrame, hasBinary } from "./src/codec.ts";

describe("frame codec", () => {
  it("keeps plain JSON for frames without bytes (older peers read them)", () => {
    const frame = { kind: "data", payload: { t: "ops", n: [1, 2], s: "é" } };
    const bytes = encodeFrame(frame);
    expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(frame));
    expect(decodeFrame(bytes)).toEqual(frame);
  });

  it("carries Uint8Array and Buffer values as raw attachments", () => {
    const a = new Uint8Array([0, 1, 2, 255]);
    const b = Buffer.from("bonjour");
    const frame = { kind: "data", payload: { chunk: a, nested: [{ part: b }], empty: new Uint8Array(0), label: "x" } };
    expect(hasBinary(frame)).toBe(true);
    const bytes = encodeFrame(frame);
    expect(bytes[0]).toBe(1);
    // No base64 inflation: envelope ≈ JSON head + raw bytes.
    expect(bytes.length).toBeLessThan(200);
    const decoded = decodeFrame<typeof frame>(bytes);
    expect(Array.from(decoded.payload.chunk)).toEqual([0, 1, 2, 255]);
    expect(new TextDecoder().decode(decoded.payload.nested[0]!.part)).toBe("bonjour");
    expect(decoded.payload.empty.length).toBe(0);
    expect(decoded.payload.label).toBe("x");
  });

  it("rejects a truncated envelope", () => {
    const bytes = encodeFrame({ chunk: new Uint8Array(64) });
    expect(() => decodeFrame(bytes.subarray(0, bytes.length - 10))).toThrow();
  });
});
