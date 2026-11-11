# Process startup errors

When Waffle cannot start an external command, bash-web prints the WASI errno message followed by Waffle's original diagnostic, when present. For example:

```text
/usr/bin/bash: fork: Input/output error: ProcessError: worker failed: original cause
```

The shell copies at most 4,096 UTF-8 bytes through `runtime_proc.spawn_error`. Synchronous failures use PID zero. Child startup failures use the child's PID and are cached before any consuming wait, including waits without an earlier `wait_start` call. Concurrent waiters receive the same copied diagnostic after collection. If Waffle has selected a startup error but is still publishing its diagnostic, the shell yields and retries before caching or collecting the child.

Errno still determines exit status and whether the error is reported as a fork or command failure. Fork failures use the caller's stderr. Other startup failures use the command's redirected stderr. A missing diagnostic or a failed diagnostic query leaves the errno message intact. Successful starts and later command failures do not query spawn diagnostics.

The diagnostic is bounded text, which can include nested causes and a stack. It is not a structured error API. This feature adds no retries and makes no browser-specific startup changes.

Native runtime tests cover synchronous and child-startup messages, collection ordering, concurrent waits, query failures, and the UTF-8 byte bound. Existing errno, redirection, cancellation, and cleanup tests remain required.
