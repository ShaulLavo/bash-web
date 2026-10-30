import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const families = {
  coreutils: [
    "env",
    "clear",
    "cat",
    "echo",
    "cut",
    "tr",
    "head",
    "nl",
    "which",
    "ls",
    "mkdir",
    "seq",
    "sort",
    "tail",
    "uniq",
    "wc",
    "touch",
    "rm",
    "cp",
    "mv",
  ],
  findutils: ["find", "xargs"],
  grep: ["grep"],
  ripgrep: ["rg"],
  sed: ["sed"],
} as const;

const cooperativeFamilies = new Set(["cat", "echo", "grep", "mkdir", "seq", "tail"]);

const owners = new Map<string, string>();
for (const [family, names] of Object.entries(families)) {
  for (const name of names) owners.set(name, `waffle-${family}`);
}

export function familyWasmPath(name: string): string {
  const owner = owners.get(name);
  if (!owner) throw new Error(`Unknown family program: ${name}`);
  return resolve(dirname(require.resolve(owner)), "../dist", `${name}.wasm`);
}

export function familyWasiAdapter(name: string): string | undefined {
  return cooperativeFamilies.has(name) ? "waffle_program_support::runtime::wasi" : undefined;
}
