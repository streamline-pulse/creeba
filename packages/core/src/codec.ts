/**
 * Frame codec shared by the byte transports (iroh, WebSocket).
 *
 * A frame without binary content is plain JSON (UTF-8) — exactly what older
 * peers send and read. A frame carrying `Uint8Array` values (file chunks…) is
 * sent as a binary envelope instead of base64 inside JSON: no 33 % inflation,
 * no giant strings to build and parse.
 *
 * Envelope: `0x01` · u32 JSON length · JSON (each binary value replaced by
 * `{"$bin": index}`) · u32 attachment count · (u32 length · bytes)*. All
 * integers are big-endian. JSON frames always start with `{` (0x7b), so the
 * first byte tells the two apart.
 */

const MAGIC = 0x01;
const BIN_KEY = "$bin";

/** True when the value holds at least one `Uint8Array` (Buffer included). */
export function hasBinary(value: unknown, depth = 0): boolean {
  if (value instanceof Uint8Array) return true;
  if (!value || typeof value !== "object" || depth > 32) return false;
  if (Array.isArray(value)) return value.some((item) => hasBinary(item, depth + 1));
  for (const key in value) if (hasBinary((value as Record<string, unknown>)[key], depth + 1)) return true;
  return false;
}

/** Encodes a frame: JSON bytes, or the binary envelope when it carries bytes. */
export function encodeFrame(value: unknown): Uint8Array {
  if (!hasBinary(value)) return new TextEncoder().encode(JSON.stringify(value));
  const blobs: Uint8Array[] = [];
  // `this[key]` is the value before toJSON (Buffer.toJSON would turn it into an array).
  const json = JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
    const original = this[key];
    if (original instanceof Uint8Array) {
      blobs.push(original);
      return { [BIN_KEY]: blobs.length - 1 };
    }
    return current;
  });
  const head = new TextEncoder().encode(json);
  const size = 1 + 4 + head.length + 4 + blobs.reduce((total, blob) => total + 4 + blob.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  out[offset++] = MAGIC;
  view.setUint32(offset, head.length, false);
  offset += 4;
  out.set(head, offset);
  offset += head.length;
  view.setUint32(offset, blobs.length, false);
  offset += 4;
  for (const blob of blobs) {
    view.setUint32(offset, blob.length, false);
    offset += 4;
    out.set(blob, offset);
    offset += blob.length;
  }
  return out;
}

/** Decodes a frame produced by `encodeFrame` (or a plain JSON frame). */
export function decodeFrame<T = unknown>(bytes: Uint8Array): T {
  if (bytes[0] !== MAGIC) return JSON.parse(new TextDecoder().decode(bytes)) as T;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 1;
  const headLength = view.getUint32(offset, false);
  offset += 4;
  const json = new TextDecoder().decode(bytes.subarray(offset, offset + headLength));
  offset += headLength;
  const count = view.getUint32(offset, false);
  offset += 4;
  const blobs: Uint8Array[] = [];
  for (let index = 0; index < count; index++) {
    const length = view.getUint32(offset, false);
    offset += 4;
    if (offset + length > bytes.length) throw new Error("truncated frame");
    // A copy: the caller may reuse its read buffer.
    blobs.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === BIN_KEY && typeof value[BIN_KEY] === "number") {
        const blob = blobs[value[BIN_KEY]];
        if (!blob) throw new Error("missing frame attachment");
        return blob;
      }
    }
    return value;
  }) as T;
}
