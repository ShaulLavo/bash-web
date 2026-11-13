import type { Runtime } from "waffle";

export async function registerExecSourceShell(runtime: Runtime): Promise<void> {
  const response = await fetch(new URL("programs/shell-engine.wasm", document.baseURI));
  if (!response.ok) throw new Error(`Source shell fetch failed (${response.status})`);
  const source = new Uint8Array(await response.arrayBuffer());
  await runtime.filesystem.mkdirp("/bin");
  await runtime.filesystem.writeFile("/bin/source-sh", new Uint8Array());
  await runtime.filesystem.drain();
  runtime.registerProgram("/bin/source-sh", { adapter: "bash-web:preview1", source });
}
