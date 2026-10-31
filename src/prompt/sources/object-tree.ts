import type { ParsedIndex } from "./index-types";
import type { ObjectReader } from "./object-reader";
import { decoder, hex, oid, requireObject } from "./object-work";

export function commitHeaders(bytes: Uint8Array): { tree: string; parents: string[] } {
  // Commit messages need not be UTF-8. Only the ASCII header is interpreted.
  let end = bytes.length;
  for (let position = 0; position + 1 < bytes.length; position++) {
    if (bytes[position] !== 10 || bytes[position + 1] !== 10) continue;
    end = position;
    break;
  }
  const lines = decoder.decode(bytes.subarray(0, end)).split("\n");
  requireObject(lines[0]?.startsWith("tree "), "Missing Git commit tree");
  return {
    tree: oid(lines[0].slice(5)),
    parents: lines.filter((line) => line.startsWith("parent ")).map((line) => oid(line.slice(7))),
  };
}

export async function stagedChanges(
  reader: ObjectReader,
  head: string | undefined,
  index: ParsedIndex,
): Promise<number> {
  requireObject(index.entries.length <= 20_000, "Git index exceeds 20,000 entries");
  const tracked = new Map(
    index.entries
      .filter((entry) => entry.stage === 0 && !entry.intentToAdd)
      .map((entry) => [entry.path, entry]),
  );
  const conflicts = new Set(
    index.entries.filter((entry) => entry.stage !== 0).map((entry) => entry.path),
  );
  if (!head) return tracked.size;
  const commit = await reader.read(head);
  requireObject(commit.type === "commit", "HEAD is not a commit");
  const pending = [{ oid: commitHeaders(commit.bytes).tree, path: "", depth: 0 }];
  let count = 0;
  let entries = 0;
  for (let position = 0; position < pending.length; position++) {
    const item = pending[position];
    requireObject(item.depth < 128, "Git tree depth exceeds 128");
    const tree = await reader.read(item.oid);
    requireObject(tree.type === "tree");
    for (const entry of treeEntries(tree.bytes)) {
      await reader.work.checkpoint();
      requireObject(++entries <= 20_000, "Git tree exceeds 20,000 entries");
      const path = item.path + entry.path;
      if (entry.mode === 0o40000) {
        pending.push({ oid: entry.oid, path: `${path}/`, depth: item.depth + 1 });
        continue;
      }
      if (conflicts.has(path)) continue;
      const indexed = tracked.get(path);
      if (!indexed || indexed.oid !== entry.oid || indexed.mode !== entry.mode) count++;
      tracked.delete(path);
    }
  }
  return count + tracked.size;
}

function* treeEntries(bytes: Uint8Array): Generator<{ path: string; mode: number; oid: string }> {
  let offset = 0;
  const names = new Set<string>();
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const nul = bytes.indexOf(0, space + 1);
    requireObject(space > offset && nul > space + 1 && nul + 21 <= bytes.length);
    const modeText = decoder.decode(bytes.subarray(offset, space));
    requireObject(/^(40000|100644|100755|120000|160000)$/.test(modeText));
    const path = decoder.decode(bytes.subarray(space + 1, nul));
    requireObject(path !== "." && path !== ".." && !path.includes("/") && !names.has(path));
    names.add(path);
    yield { path, mode: Number.parseInt(modeText, 8), oid: hex(bytes.subarray(nul + 1, nul + 21)) };
    offset = nul + 21;
  }
}

export async function aheadBehind(
  reader: ObjectReader,
  head: string,
  upstream: string,
): Promise<{ ahead: number; behind: number }> {
  if (head === upstream) return { ahead: 0, behind: 0 };
  const parents = new Map<string, readonly string[]>();
  const local = await reachable(reader, head, parents);
  const remote = await reachable(reader, upstream, parents);
  return {
    ahead: Array.from(local).filter((name) => !remote.has(name)).length,
    behind: Array.from(remote).filter((name) => !local.has(name)).length,
  };
}

async function reachable(
  reader: ObjectReader,
  tip: string,
  parents: Map<string, readonly string[]>,
): Promise<Set<string>> {
  const result = new Set<string>();
  const pending = [tip];
  for (let position = 0; position < pending.length; position++) {
    await reader.work.checkpoint();
    const name = pending[position];
    if (result.has(name)) continue;
    result.add(name);
    let next = parents.get(name);
    if (!next) {
      requireObject(parents.size < 2_000, "Git commit walk exceeds 2,000 commits");
      const commit = await reader.read(name);
      requireObject(commit.type === "commit");
      next = commitHeaders(commit.bytes).parents;
      parents.set(name, next);
    }
    for (const parent of next) pending.push(parent);
  }
  return result;
}
