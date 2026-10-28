import { resolve } from "node:path";
import { createWaffleRunner, type WaffleCaseOptions } from "./waffle-compat.ts";

/** The release shell-runtime guest and its fixtures on Waffle's process path, C locale by default. */
export function releaseShellRunner(
  env: WaffleCaseOptions["env"] & { readonly TMP: string } = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    TMP: "/tmp/spec",
    LC_ALL: "C",
    LANG: "C",
  },
) {
  const directory = resolve(
    process.env.CARGO_TARGET_DIR ?? ".build/shell",
    "wasm32-wasip1/release",
  );
  return createWaffleRunner({
    modulePath: resolve(directory, "shell-runtime.wasm"),
    fixtureDirectory: directory,
    tmp: env.TMP,
    env,
  });
}
