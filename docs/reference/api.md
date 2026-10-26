# API reference

The TypeScript surface of bash-web, from `src/index.ts`, `src/shell.ts`, `src/bridge.ts`, and `src/utilities/`. The package is private and not published. Import it from a checkout. For tasks, see [Embed a shell in a page](../guides/embed-in-a-page.md).

## Entry points

`package.json` `exports`:

| Specifier | File |
| --------- | ---- |
| `bash-web` | `src/index.ts` |
| `bash-web/shell` | `src/shell.ts` |
| `bash-web/utilities/cat` | `src/utilities/cat.ts` |
| `bash-web/utilities/grep` | `src/utilities/grep.ts` |
| `bash-web/utilities/mkdir` | `src/utilities/mkdir.ts` |
| `bash-web/utilities/seq` | `src/utilities/seq.ts` |

`bash-web` re-exports: `createShell`; the types `RuntimeExit`, `RuntimeProcess`, `Shell`, `ShellOptions`; `SharedBridge`, `control`, `INPUT_CAPACITY`, `OUTPUT_CAPACITY`; `TerminalNewlines`; `runtimeSnapshot`; and the types `StartupObserver`, `StartupStage`, `StartupSnapshot`. `bash-web/shell` exports `createShell` and its types. The core entries import no utility.

The package has a required peer dependency on `waffle`, pinned to one Git commit (`peerDependencies.waffle`). `Runtime` and the other Waffle types named below come from there.

## `createShell(options)`

```ts
function createShell(options: ShellOptions): Promise<Shell>;
```

Starts a shell process on `options.runtime`. It never creates a runtime and never disposes the one it is given. It throws if `options.signal` is already aborted or the runtime is disposed. On first use it creates `/home/guest`, `/tmp`, `/bin`, and `/programs` in the runtime's filesystem and writes an empty marker file for the shell guest at `/programs/shell-engine.wasm`.

All shells on one `Runtime` must use the same `wasmUrl` and `workerUrl`. A different pair throws `Shell adapters on one Runtime must use the same worker and guest URLs`.

A failed asset fetch does not poison later calls. A later `createShell` retries the load. There is no automatic retry.

### `ShellOptions`

| Option | Type | Default | Meaning |
| ------ | ---- | ------- | ------- |
| `runtime` | `Runtime` | required | The page's one Waffle runtime. Waffle's `Runtime` only; a structural stand-in is rejected. |
| `script` | `string` | none | Run this script and exit. When omitted, start the interactive shell (`shell-engine -i`). |
| `cwd` | `string` | `/home/guest` | Starting directory. Sets `PWD`. |
| `env` | `Record<string, string>` | see below | Merged over the default environment. `PWD` always comes from `cwd`. |
| `terminal` | `SharedBridge` | a new bridge | Terminal byte transport. |
| `wasmUrl` | `string \| URL` | `/programs/shell-engine.wasm` | Shell guest. Resolved against `document.baseURI`. |
| `workerUrl` | `string \| URL` | `dist/shell-worker.js` next to the package | Bundled shell worker. A raw `.ts` worker is not supported. |
| `signal` | `AbortSignal` | none | Cancels pending startup only. Stop a running shell with `dispose()`. |
| `onStartupStage` | `StartupObserver` | none | Passive startup timing. The callback must not start or stop the shell or runtime. |

Default environment: `HOME=/home/guest`, `USER=guest`, `PATH=/bin`, `TERM=xterm-256color`, `LANG=C.UTF-8`.

### `Shell`

| Member | Type | Meaning |
| ------ | ---- | ------- |
| `terminal` | `SharedBridge` | The bridge passed in, or the one `createShell` made. |
| `process` | `RuntimeProcess` | The shell's process handle. |
| `done` | `Promise<RuntimeExit>` | Settles when the shell exits. |
| `interrupt()` | `void` | Send SIGINT to the shell. It stops the foreground job and leaves background jobs and other shells running. |
| `dispose()` | `Promise<void>` | Stop this shell and join its locally observed worker cleanup. Does not dispose the runtime. |
| `diagnostics()` | `ReturnType<typeof runtimeSnapshot>` | `runtimeSnapshot(runtime)` for this shell's runtime. |

`dispose()` does not guarantee physical cleanup of descendants started through foreign adapters. See [Browser integration](../browser-runtime.md#embedding-contract).

### `RuntimeExit`

```ts
interface RuntimeExit {
  code: number;
  error?: string;
}
```

`code` is the shell's exit status. `error` carries a launch or runtime diagnostic, for example `Shell worker failed: ...`, in which case `code` is 1.

### `RuntimeProcess`

| Member | Type | Meaning |
| ------ | ---- | ------- |
| `pid` | `number` | Process id in the runtime. |
| `wasmBytes` | `number` | Size of the loaded shell guest. |
| `done` | `Promise<RuntimeExit>` | Same promise as `Shell.done`. |
| `signal(signal)` | `(2 \| 9) => void` | 2 is SIGINT, 9 is SIGKILL. |
| `dispose()` | `Promise<void>` | Same as `Shell.dispose()`. |

## `SharedBridge`

A `SharedArrayBuffer` with a control block, an input ring, and an output ring. The page sends input and drains output. The shell worker does the opposite. The constructor takes an optional existing `SharedArrayBuffer`.

Constants: `INPUT_CAPACITY = 65536` bytes, `OUTPUT_CAPACITY = 262144` bytes. The control block is 64 bytes.

| Member | Meaning |
| ------ | ------- |
| `state: Int32Array` | The control block. Index it with `control`. |
| `input`, `output` | The two rings, as `Uint8Array`. |
| `send(bytes): boolean` | Append to the input ring. Returns `false` and writes nothing when the ring cannot hold all of `bytes`. |
| `receive(limit): Uint8Array` | Take up to `limit` input bytes. |
| `drain(limit = 32768): Uint8Array` | Take up to `limit` output bytes. |
| `availableInput(): number` | Unread input bytes. |
| `signal()` | Wake the other side. |
| `interrupt()` | Set the cancel flag and wake. |
| `cancelled()`, `closed()` | Read the cancel and closed flags. |
| `close()` | Set the closed flag and wake. |
| `discardInput(): boolean` | Drop queued input without touching output. `false` when the input lock is held. |
| `resumeInput()` | Clear the cancel flag. |
| `write(bytes): number` | Blocking write for the shell worker only. Returns the bytes written. |
| `tryRead(chunks)`, `tryWrite(chunks)` | Non-blocking endpoint calls for guest processes. They return a negative errno on contention or closure. |

### `control`

Indexes into `SharedBridge.state`:

| Name | Index | Name | Index |
| ---- | ----- | ---- | ----- |
| `inputWrite` | 0 | `resize` | 9 |
| `inputRead` | 1 | `raw` | 10 |
| `outputWrite` | 2 | `phase` | 11 |
| `outputRead` | 3 | `status` | 12 |
| `wake` | 4 | `memory` | 13 |
| `cancel` | 5 | `inputLock` | 14 |
| `closed` | 6 | `outputLock` | 15 |
| `cols` | 7 | | |
| `rows` | 8 | | |

To resize, store `cols` and `rows`, add 1 to `resize`, then call `signal()`. The demo host (`src/browser/session.ts`) reads `phase` as 0 starting, 1 ready, 2 running, 3 exited, and 4 shared terminal failed.

## `TerminalNewlines`

```ts
class TerminalNewlines {
  write(bytes: Uint8Array, output: (bytes: Uint8Array) => void): void;
}
```

Turns each `\n` that does not follow a `\r` into `\r\n`, for display in a terminal. It keeps the previous byte between calls, so a `\r\n` split across two chunks stays one newline. It never decodes the bytes.

## `runtimeSnapshot(runtime)`

```ts
function runtimeSnapshot(runtime: Runtime): {
  filesystemWorkers: number;
  droppedTerminalBytes: number;
  processDirectoryCapacity: number; // 1024
  roots: Array<{
    pid: number; worker: string; directoryBytes: number; memoryBytes: number;
    droppedTerminalBytes: number; workers: number; processes: number;
    liveProcesses: number; liveJobs: number; retainedSlots: number;
    pipes: number; pipeCapacity: number; pipeMaxReaders: number; pipeMaxWriters: number;
    guests: Array<{ pid: number; memoryBytes: number }>;
    records: Array<{ pid: number; parentPid: number; job: number; state: unknown; result: unknown }>;
  }>;
};
```

A synchronous, metadata-only view. It creates no filesystem and no process service. `pipes` counts pipe requests the shell root made, not every descendant's pipes. A zero does not prove the process tree holds no live pipe. Closed pipes leave the count on a 100 ms sweep.

## Startup observation

```ts
type StartupObserver = (stage: StartupStage, timestamp: number) => void | PromiseLike<void>;
```

`StartupStage` is either a Waffle runtime stage or `<operation>-requested` and `<operation>-resolved` pairs. The operations `createShell` reports are `shell-wasm-fetch`, `shell-wasm-body`, `shell-wasm-compile`, `shell-home-mkdir`, `shell-tmp-mkdir`, `shell-bin-mkdir`, `shell-programs-mkdir`, `shell-executable-lookup`, `shell-executable-write`, `shell-filesystem-drain`, `shell-registration`, `shell-module`, `shell-processes`, `shell-root-adopt`, `shell-supervisor`, and `shell-worker-start`. `timestamp` is `performance.timeOrigin + performance.now()`.

The runtime stages are `filesystem-worker-created`, `filesystem-connect-requested`, `filesystem-connected`, `indexeddb-open-requested`, `indexeddb-open-resolved`, `filesystem-lock-requested`, `filesystem-lock-acquired`, `filesystem-epoch-requested`, `filesystem-epoch-resolved`, and `filesystem-ready`. Pass the same observer to `createRuntime({ onStartupStage })` to see them.

Observers are never awaited, and a throw or rejection is ignored. An absent stage means unobserved, not pending. A runtime that was created before `createShell` does not replay its earlier stages.

`StartupSnapshot` is `{ generation, stages, pending, last }`. The demo host exposes it as `window.bashWeb.snapshot().startup`.

## Utility entries

Each `bash-web/utilities/<name>` entry exports one install function, shown here for `cat`:

```ts
function installCat(runtime: Runtime, options?: UtilityOptions): Promise<UtilityInstallation>;
```

`installGrep`, `installMkdir`, and `installSeq` use the same options. `installHead`, `installSort`, and `installUniq` use `WasiUtilityOptions` below. Each registers `/bin/<name>`.

```ts
type UtilityOptions = { workerUrl?: string | URL } & (
  | { wasmUrl?: string | URL; module?: never }
  | { module: WebAssembly.Module | (() => WebAssembly.Module | Promise<WebAssembly.Module>); wasmUrl?: never }
);

type UtilitySource = Uint8Array | (() => Uint8Array | Promise<Uint8Array>);
type WasiUtilityOptions = { workerUrl?: string | URL } & (
  | { wasmUrl?: string | URL; source?: never }
  | { source: UtilitySource; wasmUrl?: never }
);

interface UtilityInstallation {
  readonly executable: string; // "/bin/<name>"
  dispose(): Promise<void>;
}

class UtilityConflictError extends Error {
  readonly path: string;
}
```

Default `wasmUrl`: `dist/<name>.wasm` next to the package. Default `workerUrl`: `dist/shell-worker.js`. Cooperative entries export `UtilityInstallation`, `UtilityModule`, and `UtilityOptions`. The `head`, `sort`, and `uniq` entries export `UtilityInstallation`, `UtilitySource`, and `WasiUtilityOptions`. Ordinary WASI guests take raw source bytes so Waffle can add interrupt checks. `UtilityConflictError` carries the conflicting `path`, and its message reads `Cannot install utility at <path>: <reason>`.

`install*` throws `Runtime is disposed` for a disposed runtime. It loads nothing until the first spawn.
