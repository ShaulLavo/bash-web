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

Waffle is published to npm as `@waffle-os/runtime`. bash-web imports it as `waffle`, so install it under that name with an npm alias, at the version `sources.lock.json` selects (`waffle.version`, currently `0.0.147`):

```sh
npm install waffle@npm:@waffle-os/runtime@0.0.147
# or
bun add waffle@npm:@waffle-os/runtime@0.0.147
```

Install it under the `waffle` name. Installing only `@waffle-os/runtime` leaves bash-web's `waffle` peer unmet, and npm then installs an unrelated package called `waffle` to satisfy it. The npm package ships its built entry points, so no build step or trusted dependency is needed. Waffle's [README](https://github.com/ShaulLavo/waffle#readme) has the full browser setup.

In a bash-web checkout, `npm ci` or `bun install` installs the selected version the same way.

Waffle is pre-1.0, and its API is early. It can change between releases, which is why bash-web pins one.

## What the snippets need

The script example below runs only when all of these hold:

- Waffle is installed at the selected version under the `waffle` alias, as above.
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

// Input: retain the unaccepted tail on backpressure.
const keys = new TextEncoder().encode("echo hi\n");
let accepted = 0;
while (accepted < keys.length) {
  accepted += shell.terminal.send(keys.subarray(accepted));
  if (accepted < keys.length) await new Promise((resolve) => setTimeout(resolve, 0));
}

// Resize: store the size, bump the counter, wake the shell.
shell.terminal.resize(80, 24);

// Ctrl+C: stops the foreground job, not background jobs or other shells.
shell.interrupt();
```

Forward raw input without local echo. The shell echoes. `TerminalNewlines` turns bare `\n` into `\r\n` for the terminal, and only for display. Do not apply it to bytes you capture as data. `src/session.ts` is a complete working host.

## Handle startup and storage

- Pass `signal` to cancel a pending startup. After `createShell` resolves, stop with `dispose()`.
- A second tab on the same storage waits for the first tab to release it, and the runtime does not fail while it waits. Read `runtime.filesystem.state` (`opening`, `waiting`, ready) to show a waiting message. See [Browser integration](../browser-runtime.md#storage-ownership-waiting-and-disposal).
- Pass `onStartupStage` to log startup timing. The callback must not start or stop the shell.

## Related

- Add `cat`, `grep`, `mkdir`, `seq`, and `tail`: [Install utilities](install-utilities.md).
- Every option and return value: [API reference](../reference/api.md).
- Something does not work: [Troubleshooting](../troubleshooting.md).
