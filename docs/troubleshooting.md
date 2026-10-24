# Troubleshooting

Find your symptom. Each entry gives the cause and the fix.

## A command prints `command not found` and exits 127

The shell core has no external commands. `cat`, `grep`, `mkdir`, and `seq` are separate programs, and any other program must be registered with the runtime.

```text
$ shell-engine -c 'seq 3'
/usr/bin/bash: seq: command not found
```

In a page, install the utility on the same runtime you pass to `createShell`: [Install utilities](guides/install-utilities.md). For another program, register it at an absolute path such as `/bin/tool`, and create its marker file first: [Browser integration](browser-runtime.md#optional-external-programs). The shell searches `PATH`, which defaults to `/bin` in the page.

## `[[ value =~ pattern ]]` exits 2 and prints nothing

The regular-expression matcher supports ASCII patterns and input in the `C`, `POSIX`, `C.UTF-8`, and `C.utf8` locales. In any other locale the test returns status 2. `LANG=en_US.UTF-8` is enough to trigger it.

```sh
LC_ALL=C.UTF-8 shell-engine -c '[[ abc =~ ^a.c$ ]] && echo match'
```

The browser host sets `LANG=C.UTF-8`. If you pass `env`, keep that setting. See [Regex groups](regex-groups.md).

## `SharedArrayBuffer is not defined`, or the shell never starts

The terminal bridge is a `SharedArrayBuffer`, and browsers expose it only to cross-origin isolated pages. Serve the page, the workers, and the WASM files with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Check `self.crossOriginIsolated` in the console. It must be `true`. Any cross-origin asset on the page needs a matching `Cross-Origin-Resource-Policy` header or CORS. `npm run serve` sets the three headers for the demo. See [Browser integration](browser-runtime.md#serve-the-assets).

## `Shell executable fetch failed (404)`, or a compile error that mentions the magic word

`createShell` fetches `/programs/shell-engine.wasm` from the origin root. Two failures look alike. The file is missing and the server returns 404, or the server answers with an HTML fallback page, which the WASM compiler rejects. Serve the file at that URL, or pass `wasmUrl`. Serve it as `application/wasm`, and make a missing path return 404, not your app's index page.

The same applies to `workerUrl` (`dist/shell-worker.js`) and, for the filesystem, `filesystem.workerURL` in `createRuntime`. Those are two different options.

## `Shell adapters on one Runtime must use the same worker and guest URLs`

Every `createShell` call on one runtime has to pass the same `wasmUrl` and `workerUrl` (or none). The first call registers the program. Use one pair per runtime.

## `UtilityConflictError`

Either the utility is already installed on this runtime, or another file or directory already exists at `/bin/<name>`. Dispose the first installation, or remove the other entry. A file holding this utility's own unchanged marker does not conflict. See [Install utilities](guides/install-utilities.md#handle-conflicts).

## A script that prints a lot stops making progress

The shell writes to a 256 KiB output ring, and the page has to drain it. When the ring is full, the shell waits. If your page stopped calling `shell.terminal.drain()`, the script blocks until you call it again. Drain on a timer, as in [Embed a shell in a page](guides/embed-in-a-page.md#run-a-script).

## The page shows "Waiting for another tab to release storage"

Another tab owns the same browser storage. The runtime waits instead of failing, and recovery continues without a reload once the other tab releases. In the demo, the initial open gives up after 60 seconds, and recovery after a grant gets a fresh 60 seconds. A different storage mode avoids the wait: the demo accepts `?mode=memory` for storage that does not persist. See [Storage ownership](browser-runtime.md#storage-ownership-waiting-and-disposal).

## `Runtime is disposed`

Something called `createShell` or an `install*` function after `runtime.dispose()`. Dispose the runtime last, after every shell and installation has stopped.

## The WASI build cannot find wasi-sdk

`scripts/wasi-build.ts` reads `WASI_SDK_PATH`. Its fallback, `/work/cache/wasi-sdk-34.0-x86_64-linux`, exists only on the maintainer's machine, so set the variable to your wasi-sdk 34.0 directory before `npm run build:shell` or `npm run build:browser`. See [Development](development.md#prerequisites).

## Still stuck

Open an issue at [github.com/ShaulLavo/bash-web/issues](https://github.com/ShaulLavo/bash-web/issues) with the exact error, the browser, and the output of `shell.diagnostics()`.
