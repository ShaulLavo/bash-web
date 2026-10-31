// All Rust WASI guests use the scanner owned by the pinned Waffle dependency.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWasiGuest } from "./verify-wasi-guests.ts";
import { prepareWaffleBuildInputs } from "./waffle-release-inputs.ts";

type Environment = NodeJS.ProcessEnv;
const helper = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, "..");
export const wasiTarget = "wasm32-wasip1";

export function wasiBuildConfiguration(root: string, env: Environment = process.env) {
  const sdk = resolve(env.WASI_SDK_PATH ?? "/work/cache/wasi-sdk-34.0-x86_64-linux");
  const version = readFileSync(resolve(sdk, "VERSION"), "utf8");
  if (!version.split("\n").includes("34.0") || !version.includes("wasi-libc: 2e6fb9d8ee0c\n")) {
    throw new Error("WASI_SDK_PATH must name wasi-sdk 34.0 with wasi-libc 2e6fb9d8ee0c");
  }
  const { builder, patch } = prepareWaffleBuildInputs(root);
  const identity = createHash("sha256")
    .update(sdk)
    .update(version)
    .update(readFileSync(builder))
    .update(readFileSync(patch))
    .digest("hex");
  const directory = resolve(root, ".build/wasi-libc", identity);
  const sysroot = resolve(directory, "sysroot");
  const linker = resolve(sdk, "bin/clang");
  const rustflags = [
    "-C",
    "link-self-contained=no",
    "-C",
    "linker-flavor=gcc",
    "-C",
    `linker=${linker}`,
    "-C",
    `link-arg=--target=${wasiTarget}`,
    "-C",
    `link-arg=--sysroot=${sysroot}`,
    "-C",
    "link-arg=-Wl,--max-memory=268435456",
  ];
  return { sdk, builder, directory, sysroot, linker, rustflags, identity };
}

function prepareSysroot(root: string, env: Environment) {
  const config = wasiBuildConfiguration(root, env);
  const receipt = resolve(config.directory, "recipe.sha256");
  if (existsSync(receipt)) {
    if (
      readFileSync(receipt, "utf8") !== config.identity ||
      !existsSync(resolve(config.sysroot, "lib", wasiTarget, "libc.a"))
    ) {
      throw new Error(`Incomplete patched libc cache: ${config.directory}`);
    }
    return;
  }
  // An output without our success receipt is never silently accepted or deleted.
  if (existsSync(config.sysroot))
    throw new Error(`Unverified patched libc output: ${config.sysroot}`);
  mkdirSync(config.directory, { recursive: true });
  execFileSync("bash", [config.builder, config.sysroot], {
    cwd: root,
    env: { ...env, WASI_SDK_PATH: config.sdk },
    stdio: "inherit",
  });
  if (!existsSync(resolve(config.sysroot, "lib", wasiTarget, "libc.a"))) {
    throw new Error(`Waffle did not produce a WASI libc archive: ${config.sysroot}`);
  }
  writeFileSync(receipt, config.identity);
}

export function wasiSysrootCommand(root = repositoryRoot): [string, string[]] {
  const cache = resolve(root, ".build/wasi-libc");
  mkdirSync(cache, { recursive: true });
  // Waffle requires a fresh output. flock serializes independent Cargo callers too;
  // the kernel releases ownership on interruption, without stale lock recovery.
  return ["flock", [resolve(cache, "build.lock"), process.execPath, helper, "--prepare", root]];
}

export function wasiBuildEnvironment(
  root = repositoryRoot,
  targetDirectory = resolve(root, ".build/shell"),
  env: Environment = process.env,
): Environment {
  const [command, args] = wasiSysrootCommand(root);
  execFileSync(command, args, { cwd: root, env, stdio: "inherit" });
  return wasiCargoEnvironment(root, targetDirectory, env);
}

// Split from preparation so migration's existing async process-group supervisor
// owns the libc build as well as Cargo, including cancellation before Cargo starts.
export function wasiCargoEnvironment(
  root = repositoryRoot,
  targetDirectory = resolve(root, ".build/shell"),
  env: Environment = process.env,
): Environment {
  const config = wasiBuildConfiguration(root, env);
  const result: Environment = {
    ...env,
    WASI_SDK_PATH: config.sdk,
    CARGO_TARGET_DIR: resolve(root, targetDirectory),
    CARGO_TARGET_WASM32_WASIP1_LINKER: config.linker,
    // This takes precedence over RUSTFLAGS and target config. Both native and
    // archived-source callers must receive exactly the same final link recipe.
    CARGO_ENCODED_RUSTFLAGS: config.rustflags.join("\x1f"),
    CC_wasm32_wasip1: config.linker,
    CFLAGS_wasm32_wasip1: `--target=${wasiTarget} --sysroot=${config.sysroot}`,
  };
  delete result.RUSTFLAGS;
  delete result.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS;
  return result;
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
  prepareSysroot(resolve(process.argv[3]), process.env);
}
