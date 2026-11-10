import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { PreparationContext } from "waffle/testing/page-runner";

export interface StartupDemo {
  entry: string;
  styles: string[];
  body: string;
}

export async function startupDemo(root = resolve("dist")): Promise<StartupDemo> {
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const entry = /<script type="module" crossorigin src="\.([^"<>]+)"/.exec(html)?.[1];
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)?.[1];
  if (!entry?.startsWith("/assets/") || !body || /<script\b/i.test(body))
    throw new Error("Expected the normal emitted demo entry and script-free body");
  const styles = Array.from(
    html.matchAll(/<link rel="stylesheet" crossorigin href="\.([^"<>]+)"/g),
    (match) => match[1],
  );
  if (!styles.length || styles.some((path) => !path?.startsWith("/assets/")))
    throw new Error("Expected the normal emitted demo styles");
  return { entry, styles, body };
}

function contentType(path: string): string {
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  throw new Error(`Unknown normal demo asset type: ${path}`);
}

async function directoryAssets(directory: string): Promise<[string, Blob][]> {
  const names = await readdir(directory);
  return Promise.all(
    names.map(async (name): Promise<[string, Blob]> => [
      `/assets/${name}`,
      new Blob([await readFile(resolve(directory, name))], { type: contentType(name) }),
    ]),
  );
}

export async function startupAssets({ signal }: PreparationContext, labels: readonly string[]) {
  signal.throwIfAborted();
  const page = await build({
    entryPoints: [resolve("tests/ios/startup-diagnostics-page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    define: { __startupLabels: JSON.stringify(labels) },
  });
  const entries: [string, Blob | string][] = await directoryAssets(resolve("dist/assets"));
  for (const name of ["shell-engine", "test-guest", "test-spin"])
    entries.push([
      `/programs/${name}.wasm`,
      new Blob([await readFile(resolve("public/programs", `${name}.wasm`))], {
        type: "application/wasm",
      }),
    ]);
  entries.push(["/startup-diagnostics-page.js", page.outputFiles[0].text]);
  signal.throwIfAborted();
  return Object.fromEntries(entries);
}

export function demoTask(demo: StartupDemo): string {
  return `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(demo.body)});
for (const href of ${JSON.stringify(demo.styles)}) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
await import(${JSON.stringify(demo.entry)});`;
}
