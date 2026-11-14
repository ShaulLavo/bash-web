import { Editor } from "@singapore-editor/core/editor";
import "@singapore-editor/core/style.css";
import { Terminal } from "ghostty-public";
import terminalWasm from "ghostty-public/ghostty-vt.wasm?url";
import terminalBridge from "ghostty-public/bridge.wasm?url";
import { BrowserSession } from "bash-web-public/session";
import { createShell } from "bash-web-public";
import { createRuntime } from "waffle";
import shellWorker from "../../node_modules/bash-web-public/dist/shell-worker.js?url";
import filesystemWorker from "../../node_modules/bash-web-public/dist/fs-worker.js?url";

declare global {
  interface Window {
    productShell: ReturnType<typeof mount>;
  }
}

function element(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing fixture element ${id}`);
  return node;
}

function mount() {
  const status = element("status");
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: filesystemWorker },
  });
  const editor = new Editor(element("editor"), {
    defaultText: "",
    fontFamily: "monospace",
    fontSize: 16,
    lineHeight: 24,
    inputRoute: "textarea",
  });
  let terminal: Terminal | undefined;
  let session: BrowserSession | undefined;
  let saved = "";
  let savedReadback = "";
  let disposal: Promise<void> | undefined;
  let probeExit: number | undefined;
  let borrowedReadback = "";
  const subscriptions: { dispose(): void }[] = [];
  const shellOptions = {
    runtime,
    cwd: "/workspace",
    wasmUrl: "/product-shell/shell-engine.wasm",
    workerUrl: shellWorker,
    env: { PS1: "integration$ ", TERM: "xterm-256color" },
  };

  async function initialize() {
    terminal = await Terminal.create({
      rendererMode: "canvas2d-fill-text",
      accessibility: { label: "Integration terminal" },
      runtime: { kind: "owned", options: { wasm: terminalWasm, bridge: terminalBridge } },
    });
    await terminal.open(element("terminal"));
    const view = terminal;
    const geometry = view.geometry();
    await runtime.filesystem.mkdirp("/workspace");
    session = await BrowserSession.create({
      ...shellOptions,
      cols: geometry.columns,
      rows: geometry.rows,
      onOutput: (bytes) => {
        view.write(bytes);
      },
      onState: (state) => {
        status.textContent = state;
      },
    });
    subscriptions.push(
      view.onData((event) => session?.input(event.bytes)),
      view.onResize(({ cols, rows }) => session?.resize(cols, rows)),
      view.onFrame(() => session?.markRendered()),
    );
    status.textContent = "ready";
  }

  async function save() {
    saved = editor.materializeFullText();
    await runtime.filesystem.writeFile("/workspace/smoke.sh", new TextEncoder().encode(saved));
    savedReadback = new TextDecoder().decode(
      await runtime.filesystem.readFile("/workspace/smoke.sh"),
    );
    status.textContent = "saved";
  }

  function disposeViews() {
    disposal ??= (async () => {
      for (const subscription of subscriptions) subscription.dispose();
      await session?.dispose();
      terminal?.dispose();
      terminal = undefined;
      editor.dispose();
    })();
    return disposal;
  }

  async function proveBorrowedRuntime() {
    await disposeViews();
    await runtime.filesystem.writeFile(
      "/workspace/after-dispose",
      new TextEncoder().encode("owner-alive"),
    );
    borrowedReadback = new TextDecoder().decode(
      await runtime.filesystem.readFile("/workspace/after-dispose"),
    );
    const probe = await createShell({ ...shellOptions, script: "test -r /workspace/smoke.sh" });
    try {
      probeExit = (await probe.done).code;
    } finally {
      await probe.dispose();
    }
    status.textContent = "views disposed";
  }

  async function disposeOwner() {
    await disposeViews();
    await runtime.dispose();
    status.textContent = "runtime disposed";
  }

  function action(id: string, run: () => Promise<void>) {
    element(id).onclick = () => {
      void run().catch(fail);
    };
  }

  function fail(error: unknown) {
    status.textContent = String(error);
    void disposeViews().then(() => runtime.dispose());
  }

  action("save", save);
  action("dispose-views", proveBorrowedRuntime);
  action("dispose-runtime", disposeOwner);
  window.addEventListener(
    "pagehide",
    () => {
      void disposeOwner();
    },
    { once: true },
  );
  void initialize().catch(fail);
  return {
    snapshot: () => ({
      text: editor.materializeFullText(),
      saved,
      savedReadback,
      lines: terminal?.visibleLines().map((line) => line.trimEnd()) ?? [],
      state: session?.state,
      prompt: session?.lastPrompt,
      inputBytes: session?.metrics.inputBytes ?? 0,
      runtimeDisposed: runtime.disposed,
      borrowedReadback,
      probeExit,
    }),
  };
}

window.productShell = mount();
