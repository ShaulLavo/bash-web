# 003. Ship one core shell and make each external command its own program

Status: accepted
Date: 2026-10-18

## Context

As compatibility grew, two problems appeared in the engine. Its modules imported each other freely: state code imported expansion code, and expansion imported arithmetic and back. Shared machinery such as storage budgets, resource status, and async result types lived inside feature modules. And `cat`, `grep`, `mkdir`, and `seq` were acceptance stand-ins compiled into the engine, so `grep` pulled the `regex` crate into every build.

## Decision

Enforce a module layering and split the commands out.

- **Layers.** Lower layers never import higher ones: `executor`, then `exec`, then `state` and `parse`, then `commands`, then the features (`expand`, `arithmetic`, `builtins`, `interpreter`). The features may import each other where the graph lists it. `npm run check:layers` scans every engine source and fails when a violation count rises. The graph is `allowedGraph` in `scripts/check-layers.ts`.
- **One core build.** The core keeps every shell-language feature, including the `[[ =~ ]]` matcher, arrays, and all builtins. There are no Full and Lite presets. That idea was retired.
- **Utilities as programs.** `cat`, `grep`, `mkdir`, and `seq` move, with unchanged behavior, to `shell/utilities`. Each is a separately linked WASM program with its own install entry, `bash-web/utilities/<name>`. A command that is not installed fails with status 127.

New external commands follow the same rule. They are their own program with their own install entry, never a stand-in in the engine. New language features join the core.

## Alternatives considered

- **Keep the stand-ins in the core.** It needs no installer. It loses because every embedding pays for `grep` and `regex`, and the core cannot prove that it works without them.
- **Full and Lite build presets.** One could ship a smaller core by dropping features. It loses because a feature set that varies by preset multiplies the matrix of builds to test, and the compatibility score would have to be tracked per preset.

## Consequences

- A page installs only the commands it needs, on the same runtime as the shell. [Install utilities](../guides/install-utilities.md) covers it.
- The core has its own dependency proof. `npm run check:capabilities` checks that the `regex` crate is not in the core's dependency closure.
- All the parts together cost more than the old combined shell. At the 2026-10-19 qualification, the core plus all four utilities measured 3,749,772 bytes raw and 828,526 bytes after brotli-11, against 2,830,433 raw and 598,893 brotli for the former combined build. The browser core alone was 1,762,231 raw and 394,743 brotli. These are recorded measurements from the step qualification, not re-measured when this page was written. `npm run test:shell:wasi` prints current sizes. The split saves bytes only when you install fewer than all four.
- The frozen compatibility score runs the core with the utilities installed. It must not lose a case, and it did not.
- A change that adds a layer violation fails CI before the shell, compatibility, and browser jobs matter.
