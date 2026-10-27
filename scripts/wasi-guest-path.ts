export function wasiGuestFilename(name: string): string {
  return name.endsWith(".wasm") ? name : `${name}.wasm`;
}
