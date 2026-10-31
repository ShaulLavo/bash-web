# API reference

The TypeScript surface of bash-web, from `src/index.ts`, `src/shell.ts`, and `src/bridge.ts`. The package is private and not published. Import it from a checkout. For tasks, see [Embed a shell in a page](../guides/embed-in-a-page.md).

## Entry points

`package.json` `exports`:

| Specifier | File |
| --------- | ---- |
| `bash-web` | `src/index.ts` |
| `bash-web/shell` | `src/shell.ts` |

`bash-web` re-exports: `createShell`; the types `RuntimeExit`, `RuntimeProcess`, `Shell`, `ShellOptions`, `ShellPrompt`, `PromptWaitOptions`; `installShellCommands`, `UtilityConflictError` and the types `ShellCommandOptions`, `ShellCommandsInstallation`; `SharedBridge`, `control`, `INPUT_CAPACITY`, `OUTPUT_CAPACITY`; `TerminalNewlines`; `runtimeSnapshot`; and the types `StartupObserver`, `StartupStage`, `StartupSnapshot`. `bash-web/shell` exports `createShell` and its types. The core entries import no utility.

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
| `lineEditor` | `{ mode: "bash" \| "zsh" }` | `{ mode: "bash" }` | Interactive editing only. [Zsh mode](../zsh-line-editor.md) uses hard-line navigation. Ignored with `script`. |
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
| `waitForPrompt(options?)` | `Promise<ShellPrompt>` | Wait for startup or a later prompt generation and its actual shell status. |
| `interrupt()` | `void` | Send SIGINT to the foreground job. Handled programs choose their result or keep running; background jobs and other shells keep running. |
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

## `installShellCommands(runtime, options?)`

```ts
function installShellCommands(
  runtime: Runtime,
  options?: ShellCommandOptions,
): Promise<ShellCommandsInstallation>;
```

Registers the shell guest at `/bin/sh` and `/bin/bash`, so other programs on the same runtime can run `sh -c SCRIPT` or find `bash` on `PATH`. Bun's package scripts and `Bun.$` use this. Each path gets an executable marker under the shell registration rules: an existing foreign entry throws `UtilityConflictError` and is left alone, and a failed install rolls back the paths it already created. The guest loads on first spawn and shares its compiled module with `createShell`.

| Option | Type | Default | Meaning |
| ------ | ---- | ------- | ------- |
| `wasmUrl` | `string \| URL` | `/programs/shell-engine.wasm` | Must match `createShell` on this runtime. |
| `workerUrl` | `string \| URL` | `dist/shell-worker.js` next to the package | Must match `createShell` on this runtime. |
| `executables` | `readonly string[]` | `["/bin/sh", "/bin/bash"]` | Canonical absolute paths to register. |

The result has `executables` (the registered paths) and `dispose()`. `dispose()` releases these registrations and removes unchanged markers it created. It leaves `/programs/shell-engine.wasm` and running shells alone.

## `SharedBridge`

A `SharedArrayBuffer` with a control block, an input ring, and an output ring. The page sends input and drains output. The shell worker does the opposite. The constructor takes an optional existing `SharedArrayBuffer`.

Constants: `INPUT_CAPACITY = 65536` bytes, `OUTPUT_CAPACITY = 262144` bytes. The control block is 72 bytes, including one atomic 64-bit prompt receipt.

| Member | Meaning |
| ------ | ------- |
| `state: Int32Array` | The control block. Index it with `control`. |
| `readPrompt(): ShellPrompt \| undefined` | Latest atomic prompt receipt, or undefined before the first prompt. |
| `input`, `output` | Standalone input storage and the output ring, as `Uint8Array`. A running shell routes input to its public Waffle `TerminalInput`. |
| `send(bytes): number` | Accept a prefix of keyboard bytes. Retain and retry `bytes.subarray(accepted)`; zero means backpressure or an interrupt barrier. |
| `receive(limit): Uint8Array` | Read standalone bridge input; running shell input is consumed only by its admitted terminal endpoints. |
| `drain(limit = 32768): Uint8Array` | Take up to `limit` output bytes. |
| `availableInput(): number` | Unread input bytes. |
| `signal()` | Wake the other side. |
| `interrupt()` | Set the cancel flag and wake. |
| `cancelled()`, `closed()` | Read the cancel and closed flags. |
| `close()` | Set the closed flag and wake. |
| `discardInput(): boolean` | Request queued-input discard without touching output. A running shell returns `false` until its public-lease drain and editor barrier complete. |
| `resumeInput()` | Resume standalone input; an active shell retains its barrier until discard is acknowledged. |
| `resize(columns, rows)` | Publish bridge dimensions and the Waffle terminal geometry. |
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

### `waitForPrompt(options?)`

```ts
interface ShellPrompt {
  readonly generation: bigint;
  readonly status: number;
}
interface PromptWaitOptions {
  after?: bigint; // default 0n, before the first prompt
  signal?: AbortSignal;
}
```

An interactive shell publishes a new receipt after writing each ready prompt.
The first has generation `1n` and status 0. Later generations increase by one,
including after empty input and cancelled editing. Status is the shell's actual
`$?`, including builtins, functions, pipelines, parse/runtime errors and foreground
interrupts. Cancelling prompt input publishes 130; empty input preserves status.
Background child exits do not replace the prompt result.

For Bun's public shell host, wait for startup, then serialize command submissions
against the last returned generation. No terminal options, OSC parsing, hidden
commands or child-exit observation are needed:

```ts
let prompt = await shell.waitForPrompt({ signal });
// Send the command and Enter through shell.terminal.send(bytes).
// Retain and retry any unaccepted suffix as with ordinary keyboard input.
prompt = await shell.waitForPrompt({ after: prompt.generation, signal });
lastExit = prompt.status;
```

`waitForPrompt` returns the latest receipt whose generation is greater than
`after`. It also returns when that receipt was published before the call, even
if phase 2 has already begun again. It sleeps on bridge notifications rather
than polling phase or input-ring occupancy. Continue normal output draining
while waiting so guest output can make progress. `createShell()` resolving is
startup admission, not prompt readiness.

The embedding must own input while submitting a command and waiting for its next
prompt. A concurrent human submission or cancellation also advances the prompt
generation. This is a latest-state receipt, not a queue or a per-command ID:
submitting several commands before waiting can skip intermediate receipts.
`terminal.readPrompt()` reads the same atomic generation/status pair without
waiting. It remains the last published receipt while another command runs.

Aborting `signal` rejects with `signal.reason` and leaves the shell running.
A closed bridge, shell exit, disposal or terminal failure rejects pending and
future waits with `Error("Shell closed before the next prompt")`, even if an
older receipt remains stored. `shell.interrupt()` keeps the shell alive. Default SIGINT termination and
interrupted shell code report 130. A program that handles SIGINT reports its
actual normal exit, including 0, 7 or 130, and may keep running instead of
producing a prompt. Each call delivers a new interrupt. A noninteractive `script` has no prompt;
use `shell.done` for its result. Negative `after` rejects with `RangeError`.

The guest import is `shell_terminal.phase(value: i32, status: i32)`. Only the
interactive root owns publication. A ready call stores the legacy `control.status`
and phase 1, then atomically publishes a 64-bit receipt at byte offset 64 and
signals the bridge. Its low eight bits hold status and the remaining bits hold
generation. Use the public methods to read receipts. The header is 72 bytes;
ship the rebuilt guest and worker together. Other phase calls retain the last
prompt status. Phase 3 still carries final process status and phase 4 terminal
failure in `control.status`.

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
