const digits = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
export function hex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += digits[byte];
  return value;
}
