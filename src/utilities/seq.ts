import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type UtilityOptions } from "./install";
export type { UtilityInstallation, UtilityModule, UtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Provision and register `/bin/seq`, its own WASM program, on the caller's Runtime. */
export function installSeq(
  runtime: Runtime,
  options?: UtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/seq.wasm", import.meta.url);
  return installUtility(runtime, { name: "seq", path: "/bin/seq", defaultUrl }, options);
}
