# WASI utility processes

`shell-wasi-process` is the Rust process consumer for WASI utilities on the caller's Waffle runtime. It creates no runtime, host process or OS adapter. Env uses it for ordinary command execution; find and xargs retain their own integration scope.

## Launch data

`Request` supplies an executable path, argv including argv0, the exact environment, absolute cwd, and descriptor bindings. Empty arguments and empty environments stay empty. Strings must be UTF-8 without NUL; environment names cannot contain `=`. Encoded spawn JSON is limited to 1 MiB. Each request starts a new foreground job with `jobLifetime: "caller-fatal"`, so Waffle cancels and collects it when its caller dies from a signal.

`DescriptorBinding { child, parent }` borrows a descriptor. Spawn retains its own binding before returning, without closing the parent's descriptor. Sparse and remapped bindings are supported. `inherited_stdio()` includes open descriptors 0, 1 and 2. `inherited_shell_descriptors()` uses the Shell worker's `shell_terminal.inherited_fd` import to enumerate all actual launch bindings, excluding private preopens. Generic Waffle workers must supply their own explicit binding list.

`resolve_executable(program, path, cwd)` uses Waffle executable-access queries without loading candidates. Missing PATH uses `/bin:/usr/bin`; empty components mean cwd. Slash paths bypass PATH. EACCES takes precedence over missing and non-directory candidates. Other host errors stop lookup. Spawn checks admission again.

## Completion and cancellation

`run` spawns and blocks for completion. `spawn` returns a `Child` with `pid`, `try_wait`, `wait`, and `cancel`. Blocking `wait` and `cancel` use Waffle's `wait_job(job, 2, out)` to collect the job after descriptor, filesystem and physical worker retirement. This wait leaves pending handled signals untouched and still honors fatal outcomes.

`wait` consumes the first handled pending signal, cancels the job with SIGKILL, then returns `Error::Interrupted(signal)` after collection. `cancel` kills and collects without consuming handled signals. Completed calls return their cached outcome. Drop attempts cancellation; callers that need cleanup errors use `cancel` explicitly. Fatal caller termination cannot run Drop, so Waffle owns cancellation and retirement of the caller's independent child jobs.

`try_wait` is nonblocking and collects the descriptor/filesystem completion fence. It does not provide the stronger blocking physical-retirement guarantee. Callers that require that guarantee use `wait` directly.

`Outcome` distinguishes real exits, signals and startup failures. `shell_status()` preserves actual exits, maps signals to 128 plus the signal, maps ENOENT startup failure to 127, and maps other startup failures to 126. Host-call failures remain errors rather than fabricated child outcomes. Native builds expose codecs and status types only.

## Checks

Run `cargo test --locked --manifest-path shell/Cargo.toml -p shell-wasi-process` for codec tests. `npm run test:env:command` exercises an ordinary admitted env guest, real WASI child argv/environment/status, lookup and fatal-owner cleanup on the installed Waffle pin. No test substitutes native host command execution for the guest.

The older standalone process fixture is built with `node shell/wasi-process/tests/build-fixture.mjs` and driven by `shell/wasi-process/tests/browser.mjs`. Its focused cancellation controls use a test-owned delayed quiescence promise and count cleanup-wait entry before release. The rendezvous belongs to the test, not the process ABI.
