import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wasiBuildEnvironment } from "./wasi-build.ts";

export const wasiTestTargets = [
  [
    "-p",
    "shell-parser",
    "--lib",
    "--test",
    "api",
    "--test",
    "conditional",
    "--test",
    "command_print",
  ],
  [
    "-p",
    "shell-engine",
    "--lib",
    "--test",
    "streaming",
    "--test",
    "terminal_display",
    "--test",
    "words",
  ],
];

export function testExecutables(messages: string): string[] {
  const executables: string[] = [];
  for (const line of messages.split("\n").filter(Boolean)) {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("reason" in value)) continue;
    if (value.reason !== "compiler-artifact" || !("executable" in value) || !value.executable)
      continue;
    if (!("profile" in value) || !value.profile || typeof value.profile !== "object") continue;
    if (!("test" in value.profile) || value.profile.test !== true) continue;
    if (typeof value.executable !== "string") throw new Error("Expected a test executable");
    assert.ok(value.executable.endsWith(".wasm"));
    executables.push(value.executable);
  }
  assert.equal(
    executables.length,
    4,
    "Each WASI package must produce its four existing test targets",
  );
  return executables;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "Pass the directory for compiled WASI tests");
  const root = resolve(import.meta.dirname, "..");
  const directory = resolve(process.argv[2]);
  mkdirSync(directory, { recursive: true });
  const env = wasiBuildEnvironment(root, process.env.CARGO_TARGET_DIR ?? ".build/shell");
  for (const targets of wasiTestTargets) {
    const messages = execFileSync(
      "cargo",
      [
        "test",
        "--locked",
        "--manifest-path",
        "shell/Cargo.toml",
        "--target",
        "wasm32-wasip1",
        "--no-run",
        "--message-format=json",
        "-j2",
      ].concat(targets),
      {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    for (const executable of testExecutables(messages))
      copyFileSync(executable, resolve(directory, basename(executable)));
  }
}
