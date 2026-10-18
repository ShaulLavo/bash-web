// Original acceptance composition. Test guests use the same adapter and Runtime as the shell.
import type { Runtime } from "waffle";
import { registerShell } from "../../src/runtime/shell-host";

export async function registerTestPrograms(runtime: Runtime, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  // Register the existing shell adapter without starting another shell, worker, or Runtime.
  registerShell(runtime, { runtime });
  const load = async (name: string) => {
    const url = new URL(`programs/${name}.wasm`, document.baseURI);
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw new Error(`Test guest fetch failed: ${url.pathname} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const [guestBytes, spinBytes] = await Promise.all([load("test-guest"), load("test-spin")]);
  signal?.throwIfAborted();
  const guest = await WebAssembly.compile(guestBytes);
  signal?.throwIfAborted();
  await runtime.filesystem.mkdirp("/bin");
  signal?.throwIfAborted();
  await runtime.filesystem.mkdirp("/programs");
  // Filesystem visibility belongs to this caller, not registration. Bare commands
  // reach /bin through the shell's PATH search, never a registry-only name alias.
  for (const name of ["/bin/test-guest", "/programs/test-guest.wasm"]) {
    signal?.throwIfAborted();
    await runtime.filesystem.writeFile(name, new Uint8Array());
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
    await runtime.filesystem.writeFile(name, new Uint8Array());
    signal?.throwIfAborted();
    runtime.registerProgram(name, { adapter: "bash-web:preview1", source: spinBytes });
  }
  signal?.throwIfAborted();
  await runtime.filesystem.drain();
}
