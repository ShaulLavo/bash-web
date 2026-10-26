import type { Runtime } from "waffle";
import { installUtility, type UtilityInstallation, type WasiUtilityOptions } from "./install";
export type { UtilityInstallation, UtilitySource, WasiUtilityOptions } from "./install";
export { UtilityConflictError } from "./install";

/** Install upstream ripgrep as `/bin/rg` on the caller's Runtime. */
export function installRg(
  runtime: Runtime,
  options?: WasiUtilityOptions,
): Promise<UtilityInstallation> {
  const defaultUrl = new URL("../../dist/rg.wasm", import.meta.url);
  return installUtility(
    runtime,
    { name: "rg", path: "/bin/rg", defaultUrl, execution: "wasi" },
    options,
  );
}
