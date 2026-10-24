# Embed a shell in a page

Run a bash script, or an interactive shell, inside a web page. You need the [built browser assets](../development.md#build-and-test) and a page served with cross-origin isolation. Examples are TypeScript for a bundler that handles `new URL(..., import.meta.url)`.

bash-web is not on npm. Use it from a checkout of the repository.

## Serve the assets

1. Build the assets from a checkout with `npm ci` first. You need Node `>=26.12.1` ([install it](../development.md#prerequisites)), Waffle ([install it](#install-the-waffle-peer)), and wasi-sdk 34.0 ([why](../development.md#prerequisites)). Then run `npm run build:browser`. It emits `dist/shell-worker.js`, `dist/fs-worker.js`, and the shell guest `public/programs/shell-engine.wasm`.
2. Serve the page, both workers, and the WASM files with these headers, because the terminal uses `SharedArrayBuffer`:

   ```http
   Cross-Origin-Opener-Policy: same-origin
   Cross-Origin-Embedder-Policy: require-corp
   ```

3. Serve WASM as `application/wasm`. Make sure a missing program URL returns 404, not your HTML fallback page.
4. Serve `/programs/shell-engine.wasm` from the origin root, or pass `wasmUrl` to `createShell`.

`npm run serve` serves the demo build with these headers. See [Browser integration](../browser-runtime.md#serve-the-assets) for the full asset contract.

## Install the Waffle peer

Waffle is not on npm. bash-web needs this exact commit of [ShaulLavo/waffle](https://github.com/ShaulLavo/waffle), the one `peerDependencies.waffle` names in `package.json`:

```text
250967060c0268950266fc5afb85be2170fb8ed3
```

It is Waffle `0.0.90`. A different revision is not supported. Waffle's own docs install it as a Git dependency and trust its build step, because its `prepare` script builds the Node entry points and runs on Bun. In your app's `package.json`:

```json
{
  "dependencies": {
    "waffle": "github:ShaulLavo/waffle#250967060c0268950266fc5afb85be2170fb8ed3"
  },
  "trustedDependencies": ["waffle"]
}
```

Then run `bun install`. You need [Bun](https://bun.sh) on your `PATH`, because Waffle's `prepare` runs `bun prepare.ts`. Without Bun, npm fails with `bun: command not found`. Waffle's [README](https://github.com/ShaulLavo/waffle#readme) has the full browser setup.

In a bash-web checkout, `npm ci` already installs this commit. It leaves `node_modules/waffle/dist` unbuilt, and the browser build does not need it. The Node-side checks (`npm run compat:shell`, `npm run test:installed-waffle`) load that `dist`. To build it, install Bun (CI uses 1.4.4) and run `bun prepare.ts` inside `node_modules/waffle`.

Waffle is pre-1.0, and its API is early. It can change between commits, which is why bash-web pins one.

## What the snippets need

The script example below runs only when all of these hold:

- Waffle is installed at the pinned commit, as above.
- `bash-web` resolves. It is not on npm, so import it from a checkout or point your bundler at `src/index.ts`.
- Your server serves `dist/fs-worker.js` at `/fs-worker.js`. `npm run build:browser` writes it. It is Waffle's filesystem worker, bundled.
- Your server serves `/programs/shell-engine.wasm` and `dist/shell-worker.js`, with the cross-origin isolation headers above.

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
