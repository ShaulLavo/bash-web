# Complete Python acceptance on the page host

The Python adapter executes both complete bodies from `tests/python.spec.ts`. Their fixture, examples, producer, matchers, payload and output comparisons remain unchanged. The page owns one real memory runtime, shared by the shell and installed Python utility.

The adapter requires Waffle's real browser observation API. Each case declares `workers-and-requests` before navigation. Browser Worker objects keep stable host identity, and request callbacks preserve original URLs, duplicates and order. The fixture's existing Worker ledger remains independent of that browser observation. No constructor wrapper, process counter or Resource Timing query replaces it.

The selected public Waffle 0.0.119 provides these methods. All eight program families use the matching 0.0.21 release and host interface 2. Source or desktop controls do not establish Simulator Safari support.

## Prepared inputs

Restore source-matched JavaScript and native CI inputs, or use the normal owning build. Run browser assets before Python preparation because Vite replaces `dist`:

```sh
npm run build:browser:assets:ci
BASH_WEB_PYTHON_SHELL_WASM=public/programs/shell-engine.wasm npm run prepare:python:browser
```

The source/input/checksum guards must accept the restored native artifact. Its `shell-runtime.wasm` is what stages at that environment-variable path. Preparation reuses it and the released Python payload; it does not rebuild a guest.

All eight original document/module/worker/WASM/manifest roots and all 2,650 payload files are validated. The host supplies its receiver document at the original navigation path, then loads the original fixture module. Every raw Python payload byte remains checked against the complete selected manifest and release hashes.

## Run and inspect

With the prepared public dependency graph:

```sh
bun scripts/test-python-local.ts /absolute/python-result.json chromium
bun scripts/test-python-local.ts /absolute/python-result.json firefox
```

The native entry is `scripts/test-python-ios.ts`. It uses the existing native session owner. Exact Simulator selection, a fresh qualified Inspector-helper receipt and native admission belong to the native lane. No additional driver or native helper is created by Bash.

Both original cases retain a 60-second body and the original five-second polling policy. Readiness checks use immediate evaluation followed by animation frames, without adding the bare browser library's 30-second action timeout. Soft assertions continue through all 12 examples and fail after the original body and finally complete.

The full measurement stays in `RESULT.artifacts/PY01/python-measurement-report.json`, with its actual UTF-8 attachment in `RESULT.attachments.json`. Only file identity and compact completion metadata enter the bounded final verdict. Large output comparisons, resource rows, compile rows and timing data are not truncated. The original fixture closes before the final real zero-Worker assertion; the page remains alive until that assertion has completed.
