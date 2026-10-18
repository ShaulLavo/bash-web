import { resolve } from "node:path";

export type ShellBuild = "full" | "lite";

export function shellBuild(env: NodeJS.ProcessEnv = process.env): ShellBuild {
  const build = env.BASH_WEB_BUILD ?? "full";
  if (build === "full" || build === "lite") return build;
  throw new Error(`BASH_WEB_BUILD must be full or lite, received ${JSON.stringify(build)}`);
}

export function shellFeatures(build: ShellBuild): string[] {
  return ["--no-default-features", "--features", build];
}

export function shellTargetDirectory(
  root: string,
  build: ShellBuild,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = resolve(root, env.CARGO_TARGET_DIR ?? ".build/shell");
  return build === "full" ? base : resolve(base, "lite");
}
