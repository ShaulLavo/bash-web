# Browser sessions

`bash-web/session` connects a terminal view to one interactive shell. It borrows the page's Waffle runtime and owns only the shell, input queue, output pump, and display newline conversion.

```ts
import { BrowserSession } from "bash-web/session";

const session = await BrowserSession.create({
	runtime,
	cwd: "/home/user",
	env: { PS1: "$ " },
	lineEditor: { mode: "zsh" },
	cols: 80,
	rows: 24,
	onOutput: (bytes) => terminal.write(bytes),
	onState: (state, detail) => showState(state, detail),
});

session.input("echo hello\r");
await session.submit("false");
console.log(session.lastExit); // 1
await session.dispose();
```

## Options and lifetime

`SessionOptions` derives from `ShellOptions`, excluding `terminal` and `script`. It forwards those shell options directly to `createShell`, including asset URLs, working directory, environment, line-editor mode, and `prompt`. The session always owns its terminal bridge and starts an interactive shell.

`create` resolves after the first atomic prompt receipt, not merely worker admission. `onState` receives `starting`, `ready`, `running`, `exited`, or `failed`. A failure includes a second message argument. `state` holds the latest reported state. `running` also includes queued programmatic submissions.

`signal` cancels both startup and a resolved session. `dispose()` aborts pending submissions, closes the bridge, stops the pump, and awaits shell disposal. Repeated calls return the same promise and never dispose the shell twice. Neither path disposes the borrowed runtime.

Storage readiness precedes shell admission. `onStorageState` reports filesystem transitions separately from shell states. `storageStartup` can supply the page's existing lock-acquisition observation. `startupTimeoutMs` bounds shell admission and the first prompt after storage is ready; it defaults to 60 seconds.

## Input and output

`input` accepts a string or `Uint8Array`. It copies accepted bytes, queues at most 256 KiB outside the bridge, and sends chunks of at most 64 KiB as space becomes available. An oversized call throws `RangeError` without accepting any of that call. The bridge's own input capacity is separate from the page queue.

`interrupt()` and a single Ctrl+C byte discard typed-ahead input before signalling the foreground command. New input waits for the bounded discard to finish. `resize(cols, rows)` forwards terminal geometry through the bridge.

`onOutput` receives final display bytes. Bare LF becomes CRLF, existing CRLF remains unchanged even across drains, and non-text bytes remain intact. Do not apply `TerminalNewlines` again. This conversion never touches pipes or files.

## Programmatic submission and prompt receipts

`submit(command)` serializes programmatic submissions. It refuses to write into a running foreground command. Before the command, it sends Ctrl+E, Ctrl+U, and Ctrl+K, replacing the entire edited draft in both Bash and zsh editing modes. The Ctrl+E is required when the cursor is inside a multiline zsh draft.

The promise resolves after the next prompt receipt and queued output handoff. A terminal view may still parse those writes asynchronously. `lastPrompt` exposes the latest atomic generation and status, and `lastExit` exposes its status, initially zero. Neither property parses output text to find prompts.

## Prompt-provider integration

`SessionOptions.prompt` is the same `PromptProvider` accepted by `createShell`. The session passes it unchanged. `PromptProvider`, `PromptContext`, `PromptLive`, and `PromptStart` come from `bash-web` or `bash-web/shell`; this entry defines no second provider contract. The provider remains borrowed and session disposal does not dispose it. See [Prompt hook](prompt-hook.md) for rendering and live updates.

## Limits and checks

This is a display session, not a script runner, terminal renderer, runtime owner, or prompt provider. It requires cross-origin isolation, `SharedArrayBuffer`, and `Atomics.waitAsync`. `markRendered`, `metrics`, and `runtimeSnapshot` retain the demo's optional diagnostics; `crash()` exercises its failure path.

`npm run test:session` checks lifecycle, input bounds, newline conversion, receipts, submission, resize, cancellation, and disposal with real shared bridges and a controlled shell-admission fixture. `tests/session-submit.spec.ts` exercises multiline replacement through the demo's public session in both editing modes. `tests/session-drain.spec.ts` checks worker wakeups and bounded drains. These tests make no claim about bun-wasm's consumer browser suite.
