import { createRuntime } from "waffle";
import { createShell } from "../../src/shell.ts";
import { installGrep } from "../../src/utilities/grep.ts";

async function qualify(scripts: string[]) {
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: "/fs-worker.js" },
  });
  let installation: Awaited<ReturnType<typeof installGrep>> | undefined;
  let active: Awaited<ReturnType<typeof createShell>> | undefined;
  let loads = 0;
  async function run(script: string) {
    const shell = await createShell({
      runtime,
      workerUrl: "/shell-worker.js",
      wasmUrl: "/shell-runtime.wasm",
      cwd: "/tmp/spec",
      env: { PATH: "/bin", LC_ALL: "C", HOME: "/tmp/spec" },
      script: `{ ${script}; } >/tmp/output 2>/tmp/diagnostic`,
    });
    active = shell;
    try {
      const result = await shell.done;
      return {
        status: result.code,
        stdout: new TextDecoder().decode(await runtime.filesystem.readFile("/tmp/output")),
        stderrPresent: ((await runtime.filesystem.readFile("/tmp/diagnostic"))?.length ?? 0) > 0,
      };
    } finally {
      await shell.dispose();
      active = undefined;
    }
  }
  try {
    await runtime.filesystem.mkdirp("/tmp/spec");
    installation = await installGrep(runtime, {
      workerUrl: "/shell-worker.js",
      module: async () => {
        loads++;
        const response = await fetch("/grep.wasm");
        if (!response.ok) throw new Error(`grep fetch failed: ${response.status}`);
        return WebAssembly.compile(await response.arrayBuffer());
      },
    });
    const before = loads;
    const results = [];
    for (const script of scripts) results.push(await run(script));
    const after = loads;
    await installation.dispose();
    const missing = await run("grep -e hit");
    await runtime.filesystem.writeFile("/tmp/owner-alive", "alive");
    return {
      before,
      after,
      results,
      missing: missing.status,
      ownerAlive: new TextDecoder().decode(await runtime.filesystem.readFile("/tmp/owner-alive")),
    };
  } finally {
    await active?.dispose();
    await installation?.dispose();
    await runtime.dispose();
  }
}

declare global {
  interface Window {
    grepUsage: typeof qualify;
  }
}
window.grepUsage = qualify;
