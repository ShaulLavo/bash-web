// Original acceptance composition. Test guests use the same adapter and Runtime as the shell.
import type { Runtime } from "waffle";
import { markStartup, type StartupObserver } from "../../src/runtime/startup-diagnostics";
import { registerShell } from "../../src/runtime/shell-host";

export async function registerTestPrograms(
  runtime: Runtime,
  signal?: AbortSignal,
  onStartupStage?: StartupObserver,
): Promise<void> {
  signal?.throwIfAborted();
  // Register the existing shell adapter without starting another shell, worker, or Runtime.
  registerShell(runtime, { runtime, onStartupStage });
  const load = async (name: "test-guest" | "test-spin") => {
    const url = new URL(`programs/${name}.wasm`, document.baseURI);
    markStartup(onStartupStage, `${name}-fetch-requested`);
    const response = await fetch(url, { signal });
    markStartup(onStartupStage, `${name}-fetch-resolved`);
    if (!response.ok)
      throw new Error(`Test guest fetch failed: ${url.pathname} (${response.status})`);
    markStartup(onStartupStage, `${name}-body-requested`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    markStartup(onStartupStage, `${name}-body-resolved`);
    return bytes;
  };
  markStartup(onStartupStage, "test-guests-fetch-requested");
  const [guestBytes, spinBytes] = await Promise.all([load("test-guest"), load("test-spin")]);
  markStartup(onStartupStage, "test-guests-fetch-resolved");
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-guest-compile-requested");
  const guest = await WebAssembly.compile(guestBytes);
  markStartup(onStartupStage, "test-guest-compile-resolved");
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-bin-mkdir-requested");
  await runtime.filesystem.mkdirp("/bin");
  markStartup(onStartupStage, "test-bin-mkdir-resolved");
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-programs-mkdir-requested");
  await runtime.filesystem.mkdirp("/programs");
  markStartup(onStartupStage, "test-programs-mkdir-resolved");
  // Filesystem visibility belongs to this caller, not registration. Bare commands
  // reach /bin through the shell's PATH search, never a registry-only name alias.
  for (const name of ["/bin/test-guest", "/programs/test-guest.wasm"]) {
    signal?.throwIfAborted();
    const stage = name.startsWith("/bin/") ? "test-guest-bin-write" : "test-guest-program-write";
    markStartup(onStartupStage, `${stage}-requested`);
    await runtime.filesystem.writeFile(name, new Uint8Array());
    markStartup(onStartupStage, `${stage}-resolved`);
    signal?.throwIfAborted();
    runtime.registerProgram(name, {
      adapter: "bash-web:preview1",
      module: guest,
      cooperative: true,
    });
  }
  // The separate spin guest intentionally has no cooperative/runtime_proc imports.
  // Waffle admits and instruments its source bytes; no hand-built interrupt shim is used.
  for (const name of ["/bin/test-spin", "/programs/test-spin.wasm"]) {
    signal?.throwIfAborted();
    const stage = name.startsWith("/bin/") ? "test-spin-bin-write" : "test-spin-program-write";
    markStartup(onStartupStage, `${stage}-requested`);
    await runtime.filesystem.writeFile(name, new Uint8Array());
    markStartup(onStartupStage, `${stage}-resolved`);
    signal?.throwIfAborted();
    runtime.registerProgram(name, { adapter: "bash-web:preview1", source: spinBytes });
  }
  signal?.throwIfAborted();
  markStartup(onStartupStage, "test-filesystem-drain-requested");
  await runtime.filesystem.drain();
  markStartup(onStartupStage, "test-filesystem-drain-resolved");
}
