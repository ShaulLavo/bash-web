// Original installer: exposes this package's shell guest as ordinary executables so other
// programs on the same Waffle Runtime (for example Bun's package scripts) can run `sh -c`.
import type { Runtime } from "waffle";
import { registerShell } from "./runtime/shell-host";
import { installUtility, type UtilityInstallation } from "./utilities/install";
export { UtilityConflictError } from "./utilities/install";

export interface ShellCommandOptions {
  /** Must match the URLs any createShell call on this Runtime uses. */
  wasmUrl?: string | URL;
  workerUrl?: string | URL;
  /** Canonical absolute paths. Defaults to `/bin/sh` and `/bin/bash`. */
  executables?: readonly string[];
}

export interface ShellCommandsInstallation {
  readonly executables: readonly string[];
  /** Releases these registrations and removes unchanged markers this installation created. */
  dispose(): Promise<void>;
}

/** Register the shell guest at `/bin/sh` and `/bin/bash`, sharing createShell's module. */
export async function installShellCommands(
  runtime: Runtime,
  options: ShellCommandOptions = {},
): Promise<ShellCommandsInstallation> {
  const registration = registerShell(runtime, { ...options, runtime });
  const executables = options.executables ?? ["/bin/sh", "/bin/bash"];
  const module = () => registration.module().then((loaded) => loaded.module);
  const installed: UtilityInstallation[] = [];
  try {
    for (const path of executables) {
      // Keyed by the full path: /bin/sh and /usr/bin/sh, or a shell at /opt/cat beside the
      // cat utility, are distinct registrations.
      const program = { name: `shell:${path}`, path, defaultUrl: new URL(registration.wasmUrl) };
      installed.push(
        await installUtility(runtime, program, { workerUrl: registration.workerUrl, module }),
      );
    }
  } catch (error) {
    await Promise.all(installed.map((installation) => installation.dispose()));
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return {
    executables: installed.map((installation) => installation.executable),
    dispose() {
      disposal ??= Promise.all(installed.map((installation) => installation.dispose())).then(
        () => {},
      );
      return disposal;
    },
  };
}
