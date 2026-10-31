import type { WorkBudget } from "../live";

export type ObjectWork = WorkBudget;

export function requireObject(
  condition: unknown,
  message = "Invalid Git object",
): asserts condition {
  if (!condition) throw new Error(message);
}

export const objectLimit = 8 * 1024 * 1024;
export const decoder = new TextDecoder("utf-8", { fatal: true });
export const encoder = new TextEncoder();

export function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function oid(value: string): string {
  requireObject(/^[0-9a-f]{40}$/.test(value), "Invalid Git SHA-1");
  return value;
}

export async function digest(bytes: Uint8Array): Promise<string> {
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", input)));
}

export async function inflate(
  bytes: Uint8Array,
  work: ObjectWork,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(
        bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes),
      );
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      work.check();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      requireObject(length <= objectLimit, "Git object exceeds 8 MiB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  work.check();
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export class ObjectCursor {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  byte(): number {
    requireObject(this.offset < this.bytes.length);
    return this.bytes[this.offset++];
  }
  variable(): number {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = this.byte();
      value += (byte & 127) * scale;
      requireObject(Number.isSafeInteger(value));
      if (!(byte & 128)) return value;
      scale *= 128;
    }
  }
}
