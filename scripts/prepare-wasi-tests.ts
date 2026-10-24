import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { wasiBuildEnvironment } from "./wasi-build.ts";

export const wasiTestTargets = [
  { package: "shell-parser", names: ["shell_parser", "api", "conditional", "command_print"] },
  {
    package: "shell-engine",
    names: ["shell_engine", "streaming", "terminal_display", "words", "capabilities"],
  },
  { package: "shell-utilities", names: ["streaming"] },
];

export function wasiTestArguments(target: (typeof wasiTestTargets)[number]): string[] {
  return ["-p", target.package].concat(
    target.names.flatMap((name) =>
      name === target.package.replaceAll("-", "_") ? ["--lib"] : ["--test", name],
    ),
  );
}

export const wasiTestFiles = wasiTestTargets.flatMap((target) =>
  target.names.map((name) => `${target.package}-${name}.wasm`),
);

export function testExecutables(messages: string, names: readonly string[]): string[] {
  const executables = new Map<string, string>();
  for (const line of messages.split("\n").filter(Boolean)) {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("reason" in value)) continue;
    if (value.reason !== "compiler-artifact" || !("executable" in value) || !value.executable)
      continue;
    if (!("profile" in value) || !value.profile || typeof value.profile !== "object") continue;
    if (!("test" in value.profile) || value.profile.test !== true) continue;
    assert.ok("target" in value && value.target && typeof value.target === "object");
    assert.ok("name" in value.target && typeof value.target.name === "string");
    assert.equal(typeof value.executable, "string");
    assert.ok(typeof value.executable === "string" && value.executable.endsWith(".wasm"));
    assert.ok(!executables.has(value.target.name), "Duplicate WASI test executable");
    executables.set(value.target.name, value.executable);
  }
  assert.deepEqual(Array.from(executables.keys()).sort(), names.toSorted(), "WASI test selection");
  return names.map((name) => {
    const executable = executables.get(name);
    assert.ok(executable);
    return executable;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "Pass the directory for compiled WASI tests");
  const root = resolve(import.meta.dirname, "..");
  const directory = resolve(process.argv[2]);
  mkdirSync(directory, { recursive: true });
  const env = wasiBuildEnvironment(root, process.env.CARGO_TARGET_DIR ?? ".build/shell");
  for (const target of wasiTestTargets) {
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
      ].concat(wasiTestArguments(target)),
      {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const executables = testExecutables(messages, target.names);
    executables.forEach((executable, index) =>
      copyFileSync(executable, resolve(directory, `${target.package}-${target.names[index]}.wasm`)),
    );
  }
}
