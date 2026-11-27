import { createRoot, on, ref } from "remix/component";
import type { Handle } from "remix/component";
import { Terminal, TERMINAL_READ_LINES_MAX_ROWS, WebGpuTerminalRenderer } from "ghostty-webgpu";
import type {
  GhosttyWebGpuTerminalOptions,
  GhosttyWebGpuTerminalSubscription,
  TerminalOutputTiming,
} from "ghostty-webgpu";
import terminalWasmUrl from "ghostty-webgpu/ghostty-vt.wasm?url";
import terminalBridgeUrl from "ghostty-webgpu/bridge.wasm?url";
import { BrowserSession } from "bash-web/session";
import { registerShell } from "../runtime/shell-host";
import {
  createStartupDiagnostics,
  markStartup,
  type StartupObserver,
  type StartupSnapshot,
} from "../runtime/startup-diagnostics";
import { VfsError, type Runtime, type SharedFilesystemState } from "waffle";
import { createStorageStartup, waitForStorage } from "../runtime/storage";
import { acquireBrowserRuntime, type BrowserHostOptions } from "./runtime";
import { START_FRESH_MESSAGES, startFresh, unreadableWorkspace } from "./start-fresh";
export type { BrowserHostOptions, BrowserRuntimeLease } from "./runtime";
import filesystemWorkerUrl from "../../.build/browser/fs-worker.js?url";
import "./style.css";

interface BrowserTestAccess {
  readonly terminal: Terminal | undefined;
  readLines(): string[];
  visibleLines(): readonly string[];
  snapshot(): {
    engine: "own-shell";
    state: string;
    error: string | undefined;
    storage: SharedFilesystemState | undefined;
    renderer: string | undefined;
    presentation: "frame" | "immediate";
    desynchronized: boolean;
    cols: number;
    rows: number;
    firstFrameMs: number | undefined;
    startup: StartupSnapshot;
  };
  metrics(): BrowserSession["metrics"] | undefined;
  outputTimings(): readonly TerminalOutputTiming[];
  runtimeSnapshot(): ReturnType<BrowserSession["runtimeSnapshot"]>;
  submit(command: string): Promise<void>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
  crash(): void;
}

declare global {
  interface Window {
    bashWeb?: BrowserTestAccess;
  }
}

const query = new URLSearchParams(location.search);
const encoder = new TextEncoder();
const cursorControls = [
  { code: "ArrowUp", label: "Previous command", text: "↑" },
  { code: "ArrowDown", label: "Next command", text: "↓" },
  { code: "ArrowLeft", label: "Move cursor left", text: "←" },
  { code: "ArrowRight", label: "Move cursor right", text: "→" },
];

function preserveInputFocus(event: Event) {
  // Cancel the compatibility mousedown, not pointerdown, so iOS still delivers click.
  event.preventDefault();
}

function awaitStartupReady(
  storageAndLease: Promise<void>,
  terminalReady: Promise<Terminal | undefined>,
  onStorageWaiting: (listener: () => void) => void,
): Promise<Terminal | undefined> {
  const terminalFailedWhileWaiting = new Promise<never>((_, reject) => {
    void terminalReady.catch((terminalError) => onStorageWaiting(() => reject(terminalError)));
  });
  return Promise.race([storageAndLease, terminalFailedWhileWaiting]).then(() => terminalReady);
}

function followViewport(node: Element, signal: AbortSignal) {
  const viewport = window.visualViewport;
  if (!(node instanceof HTMLElement) || !viewport) return;
  const resize = () => {
    // Tolerate fractional mobile scale drift around 1 when unzoomed.
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    node.style.setProperty("--workbench-height", `${viewport.height}px`);
    node.toggleAttribute("data-compact", viewport.height <= 540);
  };
  viewport.addEventListener("resize", resize, { signal });
  window.addEventListener("orientationchange", resize, { signal });
  resize();
}

function errorText(cause: unknown): string {
  if (cause instanceof VfsError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "The browser session stopped unexpectedly. Restart the session to continue.";
}

// Slow-network measurements may extend the startup guard; normal pages keep 60 seconds.
function startupTimeoutMs(): number | undefined {
  const value = Number(query.get("startupTimeout"));
  return query.get("test") === "1" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function checkCapabilities(): void {
  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      "This page needs cross-origin isolation. Serve it with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp, then reload.",
    );
  }
  if (
    typeof SharedArrayBuffer === "undefined" ||
    typeof Atomics.wait !== "function" ||
    typeof Atomics.waitAsync !== "function"
  ) {
    throw new Error(
      "This browser cannot provide shared worker I/O. Open the demo in a current Chrome, Edge, Firefox, or Safari browser on HTTPS or localhost.",
    );
  }
}

async function openTerminal(host: HTMLElement): Promise<Terminal> {
  const options: GhosttyWebGpuTerminalOptions = {
    accessibility: { label: "Browser shell terminal" },
    appearance: {
      font: { family: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace', size: 14 },
      cursor: { blink: true },
      scrollbackLimit: 5000,
      scrollbackByteLimit: 16 * 1024 * 1024,
    },
    padding: 16,
    presentation: query.get("presentation") === "immediate" ? "immediate" : "frame",
    runtime: {
      kind: "owned",
      options: {
        wasm: new URL(terminalWasmUrl, location.href),
        bridge: new URL(terminalBridgeUrl, location.href),
      },
    },
  };
  if (query.get("renderer") === "canvas") {
    const terminal = await Terminal.create({ ...options, rendererMode: "canvas2d-fill-text" });
    await terminal.open(host);
    return terminal;
  }
  if (!navigator.gpu) {
    const terminal = await Terminal.create(options);
    await terminal.open(host);
    return terminal;
  }
  const terminal = await Terminal.create({
    ...options,
    rendererFactory: (rendererOptions) => WebGpuTerminalRenderer.create(rendererOptions),
  });
  try {
    await terminal.open(host);
    return terminal;
  } catch (cause) {
    terminal.dispose();
    if (!(cause instanceof Error) || cause.name !== "WebGpuUnavailableError") throw cause;
    const fallback = await Terminal.create({ ...options, rendererMode: "canvas2d-fill-text" });
    await fallback.open(host);
    return fallback;
  }
}

/** An app-supplied runtime is borrowed; a factory lease keeps cleanup with its owner. */
export function mountBrowser(options: BrowserHostOptions = {}): void {
  function Workbench(handle: Handle) {
    const engine = "own-shell";
    let disposeRuntime: (() => Promise<void>) | undefined;
    let stopping: Promise<void> = Promise.resolve();
    let state = "starting";
    let storage: SharedFilesystemState | undefined;
    let error: string | undefined;
    let warning: string | undefined;
    // Start fresh: the saved workspace this page opened, and whether startup could not read it.
    let workspace: string | undefined;
    let leasedRuntime: Runtime | undefined;
    let unreadable = false;
    let startingFresh = false;
    let recovery: string | undefined;
    let busy = true;
    let host: HTMLElement | undefined;
    let terminal: Terminal | undefined;
    let pendingTerminal: Promise<Terminal | undefined> | undefined;
    let session: BrowserSession | undefined;
    let pendingSession: Promise<BrowserSession> | undefined;
    let startup: AbortController | undefined;
    let subscriptions: GhosttyWebGpuTerminalSubscription[] = [];
    let outputTimings: TerminalOutputTiming[] = [];
    let generation = 0;
    let diagnostics = createStartupDiagnostics(generation);
    let firstFrameMs: number | undefined;
    let startedAt = 0;
    let hasOutput = false;
    let readyMarked = false;
    let promptShown = false;
    let clipboardNotice: string | undefined;
    let pasting = false;
    let clipboardNoticeTimer: ReturnType<typeof setTimeout> | undefined;

    const render = () => {
      if (!handle.signal.aborted) void handle.update();
    };

    function enqueueDisposal(
      previousTerminal: Promise<Terminal | undefined> | undefined,
      previousPending: Promise<BrowserSession> | undefined,
      previousSession: BrowserSession | undefined,
      previousDispose: (() => Promise<void>) | undefined,
    ) {
      stopping = stopping
        .catch(() => {})
        .then(async () => {
          try {
            await previousTerminal?.catch(() => undefined);
            await previousPending?.catch(() => undefined);
            await previousSession?.dispose();
          } finally {
            await previousDispose?.();
          }
        });
      return stopping;
    }

    function stop() {
      diagnostics.stop();
      generation++;
      clearTimeout(clipboardNoticeTimer);
      clipboardNotice = undefined;
      pasting = false;
      subscriptions.forEach((subscription) => subscription.dispose());
      subscriptions = [];
      outputTimings = [];
      const previousTerminal = pendingTerminal;
      pendingTerminal = undefined;
      const previousSession = session;
      const previousPending = pendingSession;
      startup?.abort(new Error("Shell startup was cancelled."));
      startup = undefined;
      pendingSession = undefined;
      const previousDispose = disposeRuntime;
      disposeRuntime = undefined;
      session = undefined;
      terminal?.dispose();
      terminal = undefined;
      return enqueueDisposal(previousTerminal, previousPending, previousSession, previousDispose);
    }

    function fail(cause: unknown, expectedGeneration: number) {
      if (generation !== expectedGeneration || handle.signal.aborted) return;
      error = errorText(cause);
      unreadable =
        workspace !== undefined && unreadableWorkspace(cause, leasedRuntime?.filesystem.state);
      state = "failed";
      busy = false;
      const failedTerminal = pendingTerminal;
      pendingTerminal = undefined;
      const failedSession = session;
      const failedPending = pendingSession;
      startup?.abort(new Error(error));
      startup = undefined;
      pendingSession = undefined;
      const failedDispose = disposeRuntime;
      disposeRuntime = undefined;
      session = undefined;
      void enqueueDisposal(failedTerminal, failedPending, failedSession, failedDispose).catch(
        (cleanupError: unknown) => console.error("Shell cleanup failed", cleanupError),
      );
      if (terminal?.textarea) terminal.textarea.disabled = true;
      render();
    }

    function receiveState(nextState: string, expectedGeneration: number) {
      if (generation !== expectedGeneration || handle.signal.aborted) return;
      if (nextState.startsWith("warning:")) {
        warning = nextState.slice("warning:".length).trim();
        render();
        return;
      }
      if (
        !["starting", "waiting", "ready", "running", "interrupting", "exited"].includes(nextState)
      ) {
        const message = nextState.replace(/^(?:error|failed):\s*/, "");
        fail(message, expectedGeneration);
        return;
      }
      if (nextState === "ready" && !readyMarked) {
        readyMarked = true;
        performance.mark("bash:ready");
      }
      state = nextState;
      busy = nextState === "starting" || nextState === "waiting";
      if (terminal?.textarea) terminal.textarea.disabled = busy || nextState === "exited";
      render();
    }

    function wireTerminal(current: Terminal, expectedGeneration: number) {
      subscriptions = [
        current.onData((bytes) => {
          try {
            session?.input(bytes);
          } catch (cause) {
            receiveState(`warning: ${errorText(cause)}`, expectedGeneration);
          }
        }),
        current.onResize(({ cols, rows }) => {
          session?.resize(cols, rows);
          render();
        }),
        current.on("error", ({ cause }) => fail(cause, expectedGeneration)),
        current.onFrame(() => {
          session?.markRendered();
          if (readyMarked && !promptShown) {
            promptShown = true;
            performance.mark("bash:prompt-frame");
          }
          if (!hasOutput || firstFrameMs !== undefined) return;
          firstFrameMs = performance.now() - startedAt;
          render();
        }),
      ];
      if (query.get("trace") === "1")
        subscriptions.push(
          current.on("outputTiming", (timing) => {
            if (outputTimings.length === 512) outputTimings.shift();
            outputTimings.push(timing);
          }),
        );
    }

    function adoptTerminal(
      opened: Terminal,
      expectedGeneration: number,
      onStartupStage: StartupObserver,
    ): Terminal | undefined {
      markStartup(onStartupStage, "terminal-open-resolved");
      if (generation !== expectedGeneration || handle.signal.aborted || state === "failed") {
        opened.dispose();
        return undefined;
      }
      terminal = opened;
      performance.mark("bash:terminal-opened");
      if (opened.textarea) opened.textarea.disabled = true;
      wireTerminal(opened, expectedGeneration);
      return opened;
    }

    function prewarmShell(pageRuntime: Runtime, onStartupStage: StartupObserver) {
      try {
        void registerShell(pageRuntime, { runtime: pageRuntime, onStartupStage })
          .module(onStartupStage)
          .catch(() => {});
      } catch {}
    }

    async function start() {
      if (!host || handle.signal.aborted || startingFresh) return;
      const stopped = stop();
      const expectedGeneration = generation;
      const currentDiagnostics = (diagnostics = createStartupDiagnostics(expectedGeneration));
      const storageStartup = options.storageStartup ?? createStorageStartup();
      const onStartupStage: StartupObserver = (stage, timestamp) => {
        storageStartup.observe(stage, timestamp);
        currentDiagnostics.observe(stage, timestamp);
      };
      state = "starting";
      storage = undefined;
      error = undefined;
      warning = undefined;
      workspace = undefined;
      leasedRuntime = undefined;
      unreadable = false;
      recovery = undefined;
      busy = true;
      firstFrameMs = undefined;
      hasOutput = false;
      readyMarked = false;
      promptShown = false;
      startedAt = performance.now();
      render();
      try {
        markStartup(onStartupStage, "previous-stop-requested");
        await stopped;
        markStartup(onStartupStage, "previous-stop-resolved");
        if (generation !== expectedGeneration || handle.signal.aborted) return;
        checkCapabilities();
        markStartup(onStartupStage, "terminal-open-requested");
        const terminalReady = openTerminal(host).then((opened) => {
          if (pendingTerminal === terminalReady) pendingTerminal = undefined;
          return adoptTerminal(opened, expectedGeneration, onStartupStage);
        });
        pendingTerminal = terminalReady;
        void terminalReady.catch(() => {
          if (pendingTerminal === terminalReady) pendingTerminal = undefined;
        });
        markStartup(onStartupStage, "runtime-lease-requested");
        const lease = acquireBrowserRuntime(options, {
          workerURL: filesystemWorkerUrl,
          search: location.search,
          onStartupStage,
        });
        // The owner must make lease disposal idempotent, including during preparation.
        disposeRuntime = () => lease.dispose();
        workspace = lease.workspace;
        leasedRuntime = lease.runtime;
        const controller = new AbortController();
        startup = controller;
        let storageIsWaiting = false;
        let notifyStorageWaiting: (() => void) | undefined;
        const onStorageWaiting = (listener: () => void) => {
          if (storageIsWaiting) listener();
          else notifyStorageWaiting = listener;
        };
        const storageAndLease = Promise.all([
          lease.ready,
          waitForStorage(lease.runtime, controller.signal, {
            startup: storageStartup,
            onStartupStage,
            onState(nextStorage) {
              if (generation !== expectedGeneration || handle.signal.aborted) return;
              storage = nextStorage;
              storageIsWaiting = nextStorage.status === "waiting";
              if (storageIsWaiting) notifyStorageWaiting?.();
              if (nextStorage.status === "opening" || nextStorage.status === "waiting")
                receiveState(
                  nextStorage.status === "waiting" ? "waiting" : "starting",
                  expectedGeneration,
                );
              else if (nextStorage.status === "ready") receiveState("starting", expectedGeneration);
              render();
            },
          }),
        ]).then(() => {
          markStartup(onStartupStage, "runtime-lease-resolved");
        });
        // Pre-warm shell WASM fetch and compilation alongside terminal and storage startup.
        prewarmShell(lease.runtime, onStartupStage);
        // Surface INVALID_VFS_FORMAT recovery first, unless storage is waiting on another tab's lock.
        const current = await awaitStartupReady(storageAndLease, terminalReady, onStorageWaiting);
        if (!current || generation !== expectedGeneration || handle.signal.aborted) return;
        markStartup(onStartupStage, "session-create-requested");
        await createSession(current, lease.runtime, expectedGeneration, controller, onStartupStage);
        markStartup(onStartupStage, "session-create-resolved");
      } catch (cause) {
        fail(cause, expectedGeneration);
      }
    }

    async function createSession(
      current: Terminal,
      pageRuntime: Runtime,
      expectedGeneration: number,
      controller: AbortController,
      onStartupStage: StartupObserver,
    ) {
      const grid = current.appearance.grid;
      performance.mark("bash:session-start");
      const pending = BrowserSession.create({
        runtime: pageRuntime,
        lineEditor: query.get("lineEditor") === "zsh" ? { mode: "zsh" } : undefined,
        onStartupStage,
        signal: controller.signal,
        trace: query.get("trace") === "1",
        startupTimeoutMs: startupTimeoutMs(),
        cols: grid.columns,
        rows: grid.rows,
        onOutput(bytes) {
          if (generation !== expectedGeneration || handle.signal.aborted) return;
          try {
            hasOutput = true;
            current.write(bytes);
          } catch (cause) {
            fail(cause, expectedGeneration);
          }
        },
        onState: (nextState, detail) =>
          receiveState(detail ? `${nextState}: ${detail}` : nextState, expectedGeneration),
        onStorageState: (nextState) =>
          receiveState(nextState.status === "waiting" ? "waiting" : "starting", expectedGeneration),
      });
      pendingSession = pending;
      let created: BrowserSession;
      try {
        created = await pending;
      } finally {
        if (pendingSession === pending) pendingSession = undefined;
        if (startup === controller) startup = undefined;
      }
      if (generation !== expectedGeneration || handle.signal.aborted || state === "failed") {
        await created.dispose();
        return;
      }
      session = created;
      const fitted = current.appearance.grid;
      created.resize(fitted.columns, fitted.rows);
      busy = false;
      if (current.textarea) current.textarea.disabled = state === "exited" || state === "failed";
      current.focus();
      render();
    }

    /** Deletes a saved workspace that cannot be opened, then reloads into a fresh one. */
    async function startFreshWorkspace() {
      if (!unreadable || workspace === undefined || startingFresh) return;
      if (
        !window.confirm(
          "Delete this browser's saved workspace and start a new one? Its files cannot be opened and will be lost.",
        )
      )
        return;
      startingFresh = true;
      recovery = undefined;
      render();
      try {
        // stop() disposes the failed runtime, so it holds no connection when the workspace is claimed.
        const result = await startFresh(stop, workspace);
        if (result === "deleted") {
          location.reload();
          return;
        }
        // Reloading when nothing was deleted could loop on the same error.
        recovery = START_FRESH_MESSAGES[result];
      } catch (cause) {
        recovery = `Start fresh failed. ${errorText(cause)}`;
      }
      startingFresh = false;
      render();
    }

    function interrupt() {
      session?.input(encoder.encode("\x03"));
      terminal?.focus();
    }

    function inputTerminal() {
      if (busy || !session || state === "failed" || state === "exited") return;
      return terminal;
    }

    function moveCursor(code: string) {
      const current = inputTerminal();
      if (!current) return;
      current.focus();
      current.key({ action: "press", code, composing: false, text: "" });
    }

    function showClipboardNotice(message: string | undefined) {
      clearTimeout(clipboardNoticeTimer);
      clipboardNotice = message;
      if (message) clipboardNoticeTimer = setTimeout(() => showClipboardNotice(undefined), 5000);
      render();
    }

    async function pasteClipboard() {
      const current = inputTerminal();
      if (!current || pasting) return;
      current.focus();
      if (!navigator.clipboard?.readText) {
        showClipboardNotice(
          "Clipboard access is unavailable. Use your keyboard or system Paste menu.",
        );
        return;
      }
      const expectedGeneration = generation;
      pasting = true;
      showClipboardNotice(undefined);
      try {
        const text = await navigator.clipboard.readText();
        if (expectedGeneration !== generation || current !== inputTerminal()) return;
        if (text) current.paste(text);
        else showClipboardNotice("The clipboard is empty.");
      } catch {
        if (expectedGeneration === generation && current === inputTerminal())
          showClipboardNotice(
            "Could not read the clipboard. Allow access or use the system Paste menu.",
          );
      } finally {
        if (expectedGeneration === generation) {
          pasting = false;
          render();
        }
      }
    }

    function readLines() {
      if (!terminal) return [];
      let result: string[] = [];
      const count = terminal.lineCount();
      for (let start = 0; start < count; start += TERMINAL_READ_LINES_MAX_ROWS) {
        result = result.concat(
          terminal
            .readLines(start, Math.min(count, start + TERMINAL_READ_LINES_MAX_ROWS))
            .map((line) => line.text),
        );
      }
      return result;
    }

    function exposeTests() {
      if (query.get("test") !== "1") return;
      window.bashWeb = {
        get terminal() {
          return terminal;
        },
        readLines,
        visibleLines: () => terminal?.visibleLines() ?? [],
        snapshot: () => ({
          engine,
          state,
          error,
          storage,
          renderer: terminal?.diagnostics.rendererBackend,
          presentation: query.get("presentation") === "immediate" ? "immediate" : "frame",
          desynchronized: terminal?.diagnostics.desynchronized ?? false,
          cols: terminal?.appearance.grid.columns ?? 0,
          rows: terminal?.appearance.grid.rows ?? 0,
          firstFrameMs,
          startup: diagnostics.snapshot(),
        }),
        submit: (command) =>
          session ? session.submit(command) : Promise.reject(new Error("Shell is closed")),
        metrics: () => session?.metrics,
        runtimeSnapshot: () => session?.runtimeSnapshot(),
        outputTimings: () => outputTimings,
        restart: start,
        dispose: stop,
        crash: () => session?.crash(),
      };
    }

    const mount = (node: Element, signal: AbortSignal) => {
      if (!(node instanceof HTMLElement)) return;
      host = node;
      exposeTests();
      signal.addEventListener(
        "abort",
        () => {
          void stop();
        },
        { once: true },
      );
      void start();
    };

    handle.signal.addEventListener(
      "abort",
      () => {
        void stop();
        delete window.bashWeb;
      },
      { once: true },
    );

    return () => (
      <main class="workbench" mix={ref(followViewport)}>
        <header class="topbar">
          <a
            class="brand"
            href="https://github.com/ShaulLavo/bash-web"
            target="_blank"
            rel="noreferrer"
          >
            <span class="brand-symbol" aria-hidden="true">
              &gt;_
            </span>
            <span>
              bash<span class="brand-muted">-web</span>
            </span>
          </a>
          <span class="tagline">A shell in your browser.</span>
          <span class="browser-badge">Runs locally</span>
        </header>
        <section class="shell-panel" aria-label="Shell workbench">
          <div class="shell-toolbar">
            <span>
              Own shell <span class="engine-detail">Rust · WASM</span>
            </span>
            <div class="session-actions">
              <button
                type="button"
                class="quiet-button"
                disabled={busy || !session}
                mix={[
                  on<HTMLButtonElement>("mousedown", preserveInputFocus),
                  on("click", interrupt),
                ]}
              >
                Interrupt <kbd>^C</kbd>
              </button>
              <button
                type="button"
                class="quiet-button"
                disabled={busy || startingFresh}
                title={
                  options.runtime
                    ? "Restart the shell. Application-owned files and runtime are preserved."
                    : "Start a fresh session. Files and shell state are cleared."
                }
                mix={on("click", () => start())}
              >
                Restart
              </button>
            </div>
          </div>
          {error && (
            <div class="error-banner" role="alert">
              <strong>Session stopped</strong>
              <p>{error}</p>
              {unreadable && (
                <p>
                  This browser's saved copy of the workspace cannot be opened. Start fresh deletes
                  it and opens a new one.
                </p>
              )}
              {recovery && <p>{recovery}</p>}
              <div class="error-actions">
                <button type="button" disabled={startingFresh} mix={on("click", () => start())}>
                  Restart session
                </button>
                {unreadable && (
                  <button
                    type="button"
                    data-testid="start-fresh"
                    title="Delete the workspace that cannot be opened and start a new one"
                    disabled={startingFresh}
                    mix={on("click", startFreshWorkspace)}
                  >
                    Start fresh
                  </button>
                )}
              </div>
            </div>
          )}
          {warning && (
            <div class="warning-banner" role="status">
              <span>{warning}</span>
              <button
                type="button"
                aria-label="Dismiss notice"
                mix={on("click", () => {
                  warning = undefined;
                  render();
                })}
              >
                Dismiss
              </button>
            </div>
          )}
          <div class="terminal-container">
            <div class="terminal-host" data-testid="terminal" mix={ref(mount)} />
            {busy && (
              <div class="loading-overlay" role="status">
                <span class="loading-dot" />
                {state === "waiting"
                  ? "Waiting for another tab to release storage…"
                  : "Starting shell…"}
              </div>
            )}
          </div>
          <div class="terminal-controls" role="group" aria-label="Terminal input controls">
            <button
              type="button"
              class="terminal-control paste-control"
              disabled={!inputTerminal() || pasting}
              mix={[
                on<HTMLButtonElement>("mousedown", preserveInputFocus),
                on("click", pasteClipboard),
              ]}
            >
              Paste
            </button>
            {cursorControls.map(({ code, label, text }) => (
              <button
                type="button"
                class="terminal-control"
                aria-label={label}
                title={label}
                disabled={!inputTerminal()}
                mix={[
                  on<HTMLButtonElement>("mousedown", preserveInputFocus),
                  on("click", () => moveCursor(code)),
                ]}
              >
                {text}
              </button>
            ))}
          </div>
          <div class="clipboard-notice" role="status" aria-label="Clipboard notice">
            {clipboardNotice}
          </div>
          <footer class="terminal-status" aria-label="Session status">
            <span class={`state-indicator ${state === "failed" ? "state-failed" : ""}`}>
              <span aria-hidden="true" />
              <span data-testid="session-state">{state}</span>
            </span>
            <span class="renderer-label" data-testid="renderer">
              {terminal?.diagnostics.rendererBackend === "webgpu"
                ? "WebGPU"
                : `${terminal?.diagnostics.rendererBackend ?? "Ghostty"}${terminal ? " · fallback renderer" : ""}`}
            </span>
            <span class="terminal-dimensions">
              {terminal
                ? `${terminal.appearance.grid.columns} × ${terminal.appearance.grid.rows}`
                : ""}
            </span>
          </footer>
        </section>
        <div class="below-terminal">
          <p class="keyboard-hint">
            <kbd>↑</kbd> history <span>·</span> <kbd>Ctrl C</kbd> interrupt <span>·</span>{" "}
            <kbd>Ctrl D</kbd> EOF
          </p>
          <details class="help">
            <summary>Try a few things</summary>
            <div class="help-content">
              <p>
                {options.runtime
                  ? "The application owns this runtime and its files. Restarting replaces only the shell."
                  : "Shell state and files stay in this session. Restarting starts fresh."}
              </p>
              <dl>
                <div>
                  <dt>
                    <code>export NAME=world; echo "hello $NAME"</code>
                  </dt>
                  <dd>Persistent environment</dd>
                </div>
                <div>
                  <dt>
                    <code>printf 'one\ntwo\n' &gt; notes; cat notes</code>
                  </dt>
                  <dd>Files and redirection</dd>
                </div>
                <div>
                  <dt>
                    <code>printf 'one\ntwo\n' | cat</code>
                  </dt>
                  <dd>Stream through a pipeline</dd>
                </div>
              </dl>
            </div>
          </details>
        </div>
      </main>
    );
  }

  const rootElement = document.getElementById("app");
  if (!rootElement) throw new Error("Missing browser workbench mount");
  const root = createRoot(rootElement);
  root.render(<Workbench />);
  window.addEventListener("pagehide", () => root.dispose(), { once: true });
}
