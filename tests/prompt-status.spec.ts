import { build } from "esbuild";
import { test, expect } from "./helpers/browser-test";

test("public API retains completed builtin status in the real browser", async ({ page }) => {
  await page.route("**/prompt-status-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
      body: "<!doctype html><title>Prompt API</title>",
    }),
  );
  await page.goto("/prompt-status-fixture");
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import { createRuntime } from "waffle";
import { createShell, control } from "./src/index";
const runtime = createRuntime({filesystem:{workerURL:"/fs-worker.js",mode:"memory"}});
const shell = await createShell({runtime,workerUrl:"/shell-worker.js"});
const drain = setInterval(() => shell.terminal.drain(), 1);
window.promptStatusProof = (async () => {
  try {
    let receipt = await shell.waitForPrompt();
    const receipts = [{generation:String(receipt.generation),status:receipt.status}];
    for(const source of ["false", "true", "cd /missing"]) {
      const input = new TextEncoder().encode(source + "\\r");
      let offset = 0;
      while(offset < input.length) {
        const wake = Atomics.load(shell.terminal.state,control.wake);
        offset += shell.terminal.send(input.subarray(offset));
        if(offset < input.length) await Atomics.waitAsync(shell.terminal.state,control.wake,wake).value;
      }
      const after = receipt.generation;
      const first = await shell.waitForPrompt({after});
      receipt = await shell.waitForPrompt({after});
      if(first.generation !== receipt.generation || first.status !== receipt.status)
        throw new Error("late subscriber lost the prompt receipt");
      receipts.push({generation:String(receipt.generation),status:receipt.status});
    }
    return receipts;
  } finally {
    clearInterval(drain);
    await shell.dispose();
    await runtime.dispose();
  }
})();`,
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  await page.addScriptTag({ type: "module", content: compiled.outputFiles[0].text });
  await page.waitForFunction(() => "promptStatusProof" in window);
  const receipts = await page.evaluate(async () => {
    const proof: unknown = Reflect.get(window, "promptStatusProof");
    return await proof;
  });
  expect(receipts).toEqual([
    { generation: "1", status: 0 },
    { generation: "2", status: 1 },
    { generation: "3", status: 0 },
    { generation: "4", status: 1 },
  ]);
});
