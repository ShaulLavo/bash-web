# Stopping a busy shell

On iOS Safari, `Worker.terminate()` does not stop a worker that is running
WebAssembly. A killed shell that never returned to the host would keep a CPU
core busy until the tab closed. So the shell stops itself: its long-running work
asks Waffle whether the process was stopped, and Waffle unwinds the guest when
the answer is yes.

## What polls

- Foreground work (loops, expansions, builtins, pattern matching, parsing) goes
  through the job's cancellation checks. Every 16th check calls
  `runtime_proc.interrupted`, which takes a pending `SIGINT` and unwinds the
  guest once the runtime has selected a fatal outcome.
- Background jobs (`command &`), including their subshells and pipeline stages,
  have no interrupt of their own. Once every 4096 cancellation checks they call
  `runtime_proc.signal(0, 4)`, Waffle's stop check. It never takes a pending
  signal, so `Ctrl+C` still reaches the foreground job.
- `read`, `wait` and other blocking calls wait in Waffle, which checks the
  process outcome when it wakes.

## Signals keep their meaning

`SIGINT` still interrupts the foreground job with status 130 in an interactive
shell. `kill -KILL`, `kill -TERM` and `kill -INT` against a noninteractive child
shell end it with 137, 143 and 130. `trap` registers actions but does not run
them on signals (see [trap registration](trap-registration.md)).

## Tests

`tests/stop-without-terminate.spec.ts` replaces `Worker.terminate()` with a
no-op. It then kills child shells busy in loops, substitutions, pipelines,
builtins and `read`, and disposes interactive shells busy in foreground and
background loops. Each stopped worker must become free to run a task (proof
that no guest code is on its thread) and then send no further messages. It
runs on Chromium and WebKit.

The background check costs one host call per 4096 checks. A check on every
16th call made a tight background loop about 22% slower; at 4096 the
difference is within measurement noise.
