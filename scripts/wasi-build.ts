// All Rust WASI guests use the scanner owned by the pinned Waffle dependency.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wasiBuildConfiguration as waffleBuildConfiguration,
  wasiBuildEnvironment as waffleBuildEnvironment,
  wasiCargoEnvironment as waffleCargoEnvironment,
  wasiTarget,
  type WasiBuildRecipe,
} from "waffle/program-build-tools";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { prepareWaffleBuildInputs } from "./waffle-release-inputs.ts";

type Environment = NodeJS.ProcessEnv;
const helper = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, "..");
export { wasiTarget };

function shellBuildRecipe(root: string, env: Environment): WasiBuildRecipe {
  const { builder } = prepareWaffleBuildInputs(root);
  return { root, waffle: dirname(dirname(builder)), env };
}

export function wasiBuildConfiguration(root: string, env: Environment = process.env) {
  return waffleBuildConfiguration(shellBuildRecipe(root, env));
}

// Keep pinned-input preparation inside the migration runner's owned process group.
export function wasiSysrootCommand(root = repositoryRoot): [string, string[]] {
  return [process.execPath, [helper, "--prepare", root]];
}

export function wasiBuildEnvironment(
  root = repositoryRoot,
  targetDirectory = resolve(root, ".build/shell"),
  env: Environment = process.env,
): Environment {
  return waffleBuildEnvironment(shellBuildRecipe(root, env), targetDirectory);
}

export function wasiCargoEnvironment(
  root = repositoryRoot,
  targetDirectory = resolve(root, ".build/shell"),
  env: Environment = process.env,
): Environment {
  return waffleCargoEnvironment(shellBuildRecipe(root, env), targetDirectory);
}

/** One core shell target. Utility programs are separately linked binaries in it. */
export function shellTargetDirectory(root: string, env: Environment = process.env): string {
  return resolve(root, env.CARGO_TARGET_DIR ?? ".build/shell");
}

const workspaceGuests: readonly string[] = [
  "shell-engine",
  "shell-runtime",
  "argv-py",
  "printenv-py",
];

export function buildWasiShell(args: readonly string[] = ["--workspace"]) {
  const target = shellTargetDirectory(repositoryRoot);
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      wasiTarget,
      "--manifest-path",
      "shell/Cargo.toml",
      "-j2",
    ].concat(args),
    {
      cwd: repositoryRoot,
      env: wasiBuildEnvironment(repositoryRoot, target),
      stdio: "inherit",
    },
  );
  const binIndex = args.indexOf("--bin");
  const binaries = binIndex >= 0 ? [args[binIndex + 1]] : workspaceGuests;
  for (const binary of binaries) {
    verifyWasiGuest(
      resolve(target, wasiTarget, "release", `${binary}.wasm`),
      undefined,
      ["shell-runtime", "argv-py", "printenv-py"].includes(binary)
        ? "waffle_program_support::runtime::wasi"
        : undefined,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === helper) {
  if (process.argv[2] !== "--prepare" || !process.argv[3])
    throw new Error("Internal sysroot builder arguments missing");
  wasiBuildEnvironment(resolve(process.argv[3]));
}
