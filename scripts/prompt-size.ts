import type { Metafile } from "esbuild";
import { posix } from "node:path";

export interface PromptSize {
  readonly eagerBytesGzip: number;
  readonly configGraphBytesGzip: number;
  readonly configIncrementalBytesGzip: number;
  readonly totalBytesGzip: number;
  readonly statusIncrementalBytesGzip: number;
}

function entryOutput(meta: Metafile, entry: string): string {
  const matches = Object.entries(meta.outputs).filter(([, output]) => output.entryPoint === entry);
  if (matches.length !== 1) throw new Error(`Expected exactly one output for ${entry}`);
  return matches[0][0];
}

function staticGraph(meta: Metafile, start: string): Set<string> {
  const visited = new Set<string>();
  const pending = [start];
  for (let index = 0; index < pending.length; index++) {
    const path = pending[index];
    if (visited.has(path)) continue;
    const output = meta.outputs[path];
    if (!output) throw new Error(`Unknown bundle output ${path}`);
    visited.add(path);
    for (const dependency of output.imports) {
      if (dependency.external) throw new Error(`External prompt dependency ${dependency.path}`);
      const target = meta.outputs[dependency.path]
        ? dependency.path
        : posix.normalize(posix.join(posix.dirname(path), dependency.path));
      if (!meta.outputs[target]) throw new Error(`Unresolved bundle dependency ${dependency.path}`);
      if (dependency.kind !== "dynamic-import") pending.push(target);
    }
  }
  return visited;
}

export function promptSize(meta: Metafile, sizes: ReadonlyMap<string, number>): PromptSize {
  const entry = entryOutput(meta, "src/prompt/index.ts");
  const config = entryOutput(meta, "src/prompt/config/file.ts");
  const eager = staticGraph(meta, entry);
  const configGraph = staticGraph(meta, config);
  const statusOutput = Object.entries(meta.outputs).find(
    ([, output]) => output.entryPoint === "src/prompt/sources/status.ts",
  );
  const statusGraph = statusOutput ? staticGraph(meta, statusOutput[0]) : new Set<string>();
  const all = new Set(Array.from(eager).concat(Array.from(configGraph), Array.from(statusGraph)));
  for (const path of Object.keys(meta.outputs)) {
    if (!all.has(path)) throw new Error(`Unaccounted prompt output ${path}`);
    if (!sizes.has(path)) throw new Error(`Missing compressed size for ${path}`);
  }
  const sum = (paths: Iterable<string>) =>
    Array.from(paths, (path) => {
      const size = sizes.get(path);
      if (size === undefined || !Number.isFinite(size) || size <= 0)
        throw new Error(`Invalid compressed size for ${path}`);
      return size;
    }).reduce((total, size) => total + size, 0);
  return {
    eagerBytesGzip: sum(eager),
    configGraphBytesGzip: sum(configGraph),
    configIncrementalBytesGzip: sum(Array.from(configGraph).filter((path) => !eager.has(path))),
    statusIncrementalBytesGzip: sum(
      Array.from(statusGraph).filter((path) => !eager.has(path) && !configGraph.has(path)),
    ),
    totalBytesGzip: sum(all),
  };
}
