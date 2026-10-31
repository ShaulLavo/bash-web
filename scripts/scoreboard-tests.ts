import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const families = [
  /^test-shell-scoreboard.*\.(?:mjs|ts)$/,
  /^test-own-shell-.*\.(?:mjs|ts)$/,
  /^test-bash-compat.*\.(?:mjs|ts)$/,
  /^test-compat-selection\.(?:mjs|ts)$/,
];
function isScoreboardEntrypoint(name: string): boolean {
  if (/-browser\.(?:mjs|ts)$/.test(name)) return false;
  return families.some((family) => family.test(name));
}
export function discoverScoreboardTests(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const selected = entries.filter((entry) => isScoreboardEntrypoint(entry.name));
  assert.ok(
    selected.every((entry) => entry.isFile()),
    "scoreboard entrypoints must be regular files",
  );
  for (const family of families)
    assert.ok(
      selected.some((entry) => family.test(entry.name)),
      `empty scoreboard family ${family}`,
    );
  return selected.map((entry) => resolve(directory, entry.name)).sort();
}
export function runScoreboardTests(directory: string) {
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  // CI splits the files across runners, e.g. SCOREBOARD_TEST_SHARD=2/3.
  const shard = process.env.SCOREBOARD_TEST_SHARD;
  assert.ok(
    shard === undefined || /^[1-9]\d*\/[1-9]\d*$/.test(shard),
    "invalid SCOREBOARD_TEST_SHARD",
  );
  const flags = ["--test", "--test-concurrency=2"].concat(shard ? [`--test-shard=${shard}`] : []);
  return spawnSync(process.execPath, flags.concat(discoverScoreboardTests(directory)), {
    stdio: "inherit",
    env: environment,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = runScoreboardTests(resolve(import.meta.dirname));
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}
