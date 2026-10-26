import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Register upstream `ls` on the caller's Runtime; load its bytes on first spawn. */
export function installLs(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/ls.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "ls", path: "/bin/ls", defaultUrl, execution: "wasi" },
    options,
  );
}
