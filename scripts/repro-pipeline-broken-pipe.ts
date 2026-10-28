import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWaffleRunner } from "./waffle-compat.ts";
import { liveNodeWorkers, stopNodeWorkers } from "./node-worker-host.ts";

const input: unknown = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cases = Array.isArray(input)
  ? input
  : input && typeof input === "object" && "cases" in input
    ? input.cases
    : undefined;
if (!Array.isArray(cases)) throw new Error("Case array required");
const entry: unknown = cases.find(
  (item: unknown) =>
    item && typeof item === "object" && "id" in item && item.id === process.argv[3],
);
if (
  !entry ||
  typeof entry !== "object" ||
  !("id" in entry) ||
  !("script" in entry) ||
  typeof entry.script !== "string"
)
  throw new Error("Unknown reproduction case");
const directory =
  process.env.PIPELINE_GUEST_DIRECTORY ??
  resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const tmp = "/tmp/spec";
const runner = await createWaffleRunner({
  env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: tmp, LC_ALL: "C.UTF-8" },
  tmp,
  fixtureDirectory: directory,
  modulePath: resolve(directory, "shell-runtime.wasm"),
});
try {
  const result = await runner(entry.script);
  console.log(
    JSON.stringify({
      id: entry.id,
      ...result,
      stdout: result.stdout.toString("base64"),
      stderr: result.stderr.toString("base64"),
      liveWorkers: liveNodeWorkers(),
    }),
  );
} finally {
  await stopNodeWorkers();
}
