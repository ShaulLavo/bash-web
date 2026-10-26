# Install utilities

Give a shell `cat`, `grep`, `head`, `mkdir`, `seq`, and `tail`. The shell core has no external commands. Without an installed program, a command lookup on `PATH` fails with status 127.

Each utility is its own WASM program with its own entry, so you install only what the page needs and pay only for those.

1. Build the browser assets (`npm run build:browser`). The build writes `dist/cat.wasm`, `dist/grep.wasm`, `dist/head.wasm`, `dist/mkdir.wasm`, `dist/seq.wasm`, and `dist/tail.wasm`.
2. Install each utility on the same `Runtime` that you pass to `createShell`:

   ```ts
   import { createShell } from "bash-web";
   import { installCat } from "bash-web/utilities/cat";

   const cat = await installCat(runtime);
   try {
     const shell = await createShell({ runtime, script: "printf hello | cat" });
     try {
       await shell.done;
     } finally {
       await shell.dispose();
     }
   } finally {
     await cat.dispose();
   }
   ```

   The other entries are `bash-web/utilities/grep` (`installGrep`), `bash-web/utilities/head` (`installHead`), `bash-web/utilities/mkdir` (`installMkdir`), `bash-web/utilities/seq` (`installSeq`), and `bash-web/utilities/tail` (`installTail`).

3. If your bundler moves assets, pass the new URLs. `wasmUrl` points at the utility's `.wasm` file. `workerUrl` points at `dist/shell-worker.js`. For cooperative utilities, instead of `wasmUrl`, you can pass `module`, a compiled `WebAssembly.Module` or a function that returns one. Upstream `head` takes `source`, raw `Uint8Array` bytes or a function returning bytes, instead. Waffle needs those bytes to add interrupt checks.

An install call writes a small marker file at `/bin/<name>` and registers the program with the runtime. It does not fetch, compile, or start a worker. The first command that runs the utility loads the guest.

## Dispose an installation

Call `dispose()` after the utility's processes have stopped. It releases the registration and removes the marker file, but only if this installation created the file and the bytes have not changed. `runtime.dispose()` releases everything without it.

## Handle conflicts

- A second install of the same utility on one runtime throws `UtilityConflictError`.
- A different file or directory already at `/bin/<name>` also throws `UtilityConflictError`. A file that holds this utility's own unchanged marker is accepted, for example from persisted storage.
- If an install fails, its path stays reserved until rollback finishes. Concurrent attempts conflict during rollback. After it, a fresh install can retry.

## What each utility supports

The cooperative utilities support small subsets. `head` runs upstream uutils through ordinary WASI admission.

| Utility | Supported | Rejected |
| ------- | --------- | -------- |
| `cat` | File operands, or standard input when there are none | Options. Every argument is a file path, so `cat -n` fails |
| `grep` | `-v -c -q -n -i -F -E`, basic regular expressions by default | Any other option, for example `-P` (status 2) |
| `head` | Upstream lines, bytes, negative counts, NUL records, headers, help, and version. See [Head](../head.md) | Invalid options and counts (status 1). Buffered stdin can discard unread suffixes |
| `mkdir` | `mkdir [-p] [--] dir...` | Any other option (status 2) |
| `seq` | `seq end` and `seq start end`, integers | Step, separator, and other forms (status 2) |
| `tail` | `tail [-n N] [--] [file]`; the last 10 lines by default; `-nN` is also accepted | Multiple files, filename headers, `-c`, `-f`, and other options (status 2). Retained input is capped at 16 MiB. See [tail](../tail.md) |

`grep` is the only program that links the `regex` crate. The core build never does. See [ADR 003](../adr/003-one-core-shell-and-installable-utilities.md) for why the utilities are separate programs.

## Related

- [Embed a shell in a page](embed-in-a-page.md)
- [API reference: utility entries](../reference/api.md#utility-entries)

## Install upstream ls

Import `installLs` from `bash-web/utilities/ls`. It uses the same caller-owned runtime and loads `dist/ls.wasm` on first spawn. This is an ordinary WASI guest. Use `WasiUtilityOptions` with `wasmUrl` or raw `source` bytes, not a compiled module. [ls](../ls.md) lists the qualified flags and the upstream WASI metadata limitations.
