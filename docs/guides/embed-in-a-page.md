# Embed a shell in a page

Run a bash script, or an interactive shell, inside a web page. You need the [built browser assets](../development.md#build-and-test) and a page served with cross-origin isolation. Examples are TypeScript for a bundler that handles `new URL(..., import.meta.url)`.

bash-web is not on npm. Use it from a checkout of the repository, or as a Git dependency.

## Serve the assets

1. Build the assets: `npm run build:browser`. It emits `dist/shell-worker.js`, `dist/fs-worker.js`, and the shell guest `public/programs/shell-engine.wasm`.
2. Serve the page, both workers, and the WASM files with these headers, because the terminal uses `SharedArrayBuffer`:

   ```http
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

3. Serve WASM as `application/wasm`. Make sure a missing program URL returns 404, not your HTML fallback page.
4. Serve `/programs/shell-engine.wasm` from the origin root, or pass `wasmUrl` to `createShell`.

`npm run serve` serves the demo build with these headers. See [Browser integration](../browser-runtime.md#serve-the-assets) for the full asset contract.

## Install the Waffle peer

Waffle is a required peer dependency, pinned to an exact Git commit. Install the commit that `peerDependencies.waffle` names in `package.json`. A different Waffle revision is not supported.

## Run a script

Create one runtime for the page, then pass it to `createShell`. A script runs and exits. Its output goes to `shell.terminal`, a bounded byte ring that your page drains.

```ts
import { createRuntime } from "waffle";
import { createShell } from "bash-web";

const runtime = createRuntime({
  // Serve dist/fs-worker.js at this URL.
  filesystem: { workerURL: new URL("/fs-worker.js", location.href) },
});
try {
  const shell = await createShell({ runtime, script: "echo hello; exit 3" });
  try {
    const decoder = new TextDecoder();
    const drain = () => {
      const bytes = shell.terminal.drain();
      if (bytes.length) output.textContent += decoder.decode(bytes, { stream: true });
    };
    const timer = setInterval(drain, 16);
    const result = await shell.done;
    clearInterval(timer);
    drain();
    console.log(result.code); // 3
  } finally {
    await shell.dispose();
  }
} finally {
  await runtime.dispose();
}
```

The shell starts in `/home/guest` with `HOME`, `USER`, `PATH=/bin`, `TERM=xterm-256color`, and `LANG=C.UTF-8`. Pass `cwd` or `env` to change them.

Dispose in this order. `shell.dispose()` stops that shell and never touches the runtime or other shells. `runtime.dispose()` is yours to call after the last shell stops.

## Run an interactive shell

Omit `script`. The shell guest then runs its own line editor, with history, cursor movement, and Ctrl+C. Your page connects `shell.terminal` to a terminal emulator.

```ts
import { createShell, control, TerminalNewlines } from "bash-web";

const shell = await createShell({ runtime });
const newlines = new TerminalNewlines();

// Output: drain on a timer and give the bytes to your terminal.
setInterval(() => {
  const bytes = shell.terminal.drain();
  if (bytes.length) newlines.write(bytes, (chunk) => terminal.write(chunk));
}, 16);

// Input: send raw key bytes. send() returns false when the 64 KiB input ring is full.
shell.terminal.send(new TextEncoder().encode("echo hi\n"));

// Resize: store the size, bump the counter, wake the shell.
Atomics.store(shell.terminal.state, control.cols, 80);
Atomics.store(shell.terminal.state, control.rows, 24);
Atomics.add(shell.terminal.state, control.resize, 1);
shell.terminal.signal();

// Ctrl+C: stops the foreground job, not background jobs or other shells.
shell.interrupt();
```

Forward raw input without local echo. The shell echoes. `TerminalNewlines` turns bare `\n` into `\r\n` for the terminal, and only for display. Do not apply it to bytes you capture as data. `src/browser/session.ts` is a complete working host.

## Handle startup and storage

- Pass `signal` to cancel a pending startup. After `createShell` resolves, stop with `dispose()`.
- A second tab on the same storage waits for the first tab to release it, and the runtime does not fail while it waits. Read `runtime.filesystem.state` (`opening`, `waiting`, ready) to show a waiting message. See [Browser integration](../browser-runtime.md#storage-ownership-waiting-and-disposal).
- Pass `onStartupStage` to log startup timing. The callback must not start or stop the shell.

## Related

- Add `cat`, `grep`, `mkdir`, and `seq`: [Install utilities](install-utilities.md).
- Every option and return value: [API reference](../reference/api.md).
- Something does not work: [Troubleshooting](../troubleshooting.md).
