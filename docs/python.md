# Python

`bash-web/utilities/python` installs the official CPython 3.15.2 `wasm32-wasip1` interpreter as `/bin/python` on the Waffle runtime the page already owns.

```ts
import { installPython } from "bash-web/utilities/python";

const python = await installPython(runtime, {
  wasmUrl: new URL("/assets/python.wasm", location.href),
  payloadUrl: new URL("/assets/python-stdlib.json", location.href),
});
// Run through your shell: python -c 'import json; print(json.dumps({"ok": True}))'
// Once its processes have stopped:
await python.dispose();
```

Serve `python.wasm`, `python-stdlib.json`, `python-files/**`, and `python.NOTICES.txt` from the qualified [Python build](python-build.md). The manifest's file URLs resolve relative to its URL. Defaults point to the package's `dist/` assets. Keep the manifest and its full unpruned payload together; the interpreter is a separate asset, never a duplicate VFS file.

Installation registers the executable without fetching Python assets, creating payload directories, or starting a process worker. The first spawn shares one interpreter/payload load across concurrent callers. Every payload file's byte count and SHA-256 must match before any file is installed, and filesystem drain completes before the interpreter can launch. Successful later spawns reuse the cached program. A failed attempt rolls back unchanged files it created and lets a later spawn retry.

The supported slice is `--version`, `-c`, script files and arguments, standard-library imports including `json`, `os`, `sys`, and `sysconfig`, ordinary guest file I/O, stdin/stdout/stderr, and exit status. Subprocesses, threads, sockets, pip, dynamic native extensions, and interactive REPL behavior are outside this slice. This is a WASI build, not a promise that every CPython module works in a browser.

## Options and payload ownership

`PythonOptions` accepts the same raw-byte `source` or `wasmUrl` and optional `workerUrl` as other WASI utilities. Supply either `payloadUrl` or `payload`, where `payload` is a `PythonPayloadManifest` or a lazy function returning one. A supplied manifest's relative file URLs resolve against the default manifest URL; use absolute file URLs when relocating a supplied manifest.

The exported manifest types describe format `1`, CPython commit `5e58eaad7c58df58dfa8ea549c87996e01dd1077`, argv0 `/cross-build/wasm32-wasip1/python.wasm`, and regular files with canonical absolute `path`, `url`, nonnegative safe integer `bytes`, and lowercase hexadecimal `sha256`. Empty regular files are included. Allowed paths are `/Lib/**`, `/cross-build/wasm32-wasip1/pybuilddir.txt`, and `/cross-build/wasm32-wasip1/build/lib.wasi-wasm32-3.15/**`. The full library, actual build marker, and generated sysconfig tree are build outputs. The launcher replaces only argv element zero, preserving all user arguments.

Existing identical regular files are borrowed. Different files, directories, and symlinks at payload file paths cause a collision; missing files use exclusive creation. Parent components must be directories. Reserve these payload paths while preparing Python: the shared filesystem does not provide an atomic tree swap against unrelated concurrent edits.

Disposal unregisters Python immediately, joins active loading, and removes only files this installation created whose bytes remain unchanged. It leaves directories, borrowed or changed files, and Python-created caches in the caller's tree. It never removes a whole payload tree or disposes the runtime. Call disposal after Python processes have stopped. If the caller already disposed its runtime, the installer makes no further filesystem calls.

The payload unit tests cover loading, hashes, collisions, rollback, retries, and disposal races; launcher tests cover argv0. The browser acceptance suite separately qualifies the real build artifact and supported command slice on the pinned Waffle runtime.
