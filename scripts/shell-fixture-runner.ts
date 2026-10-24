import { resolve } from "node:path";
import { createWaffleRunner } from "./waffle-compat.ts";

export function createShellFixtureRunner({ utilities = true }: { utilities?: boolean } = {}) {
  const directory = resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release",
  );
  return createWaffleRunner({
    modulePath: resolve(directory, "shell-runtime.wasm"),
    fixtureDirectory: directory,
    ...(utilities ? { utilityDirectory: directory } : {}),
    tmp: "/tmp/spec",
    env: { PATH: "/usr/bin:/bin", HOME: "/home/user", TMP: "/tmp/spec", LC_ALL: "C.UTF-8" },
  });
}
