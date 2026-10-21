# Getopts

`getopts optstring name [arg ...]` scans positional parameters, or the explicit
arguments when supplied. It supports clustered ASCII options, required attached
or separate arguments, leading-colon silent errors, `OPTERR`, `OPTARG`, `--`,
end-of-options and ordinary scalar nameref destinations. It does not change `$@`.
`OPTIND` and `OPTERR` start at 1 without becoming exported by default.

The cursor belongs to shell state, not a user-visible helper variable. Setting
`OPTIND=0` or `OPTIND=1` restarts scanning. A changed larger index starts a new
argument; assigning the current larger index preserves its cluster position.
A local `OPTIND` saves/restores the caller's cursor. Snapshots isolate subshells.
Readonly destinations preserve their values while scanning still advances.

The scanner adapts Bashkit at the revision and source hashes in
`sources.lock.json` under `shellGetopts`. State ownership, diagnostic policy,
argument snapshots and resource controls are original. Only the current and
required next argument are copied, after cooperative scanning and command plus
execution-memory admission. Their execution tickets drop on success, error or
cancellation. The optstring is borrowed and checked cooperatively. No whole
argument-vector copy or option-character collection is made.

Array/subscript destinations stay with the variables family. Non-ASCII option
bytes remain unsupported because the engine's UTF-8 scalar strings cannot store
Bash's individual invalid UTF-8 bytes. Required argument values retain UTF-8.
The `--help` response is concise, not a copy of GNU Bash's help prose.

## Verification

The frozen baseline control at `361992834804c5d9325022ddc3580f5e9899bcee`
reproduced 1015 Oils, 1008 Brush and 1413 Bashkit passes on the production Waffle
runner, with zero gains or losses. The initial four-job replay was killed by the
host's memory limit and is not a score result. The completed control uses one
case worker and Node's 384 MiB heap cap without changing the instrument.

The selected 87 scored getopts cases initially reproduced 86 failures and one
pass. The first production candidate passes 86 cases, gains 28 Oils, 43 Brush
and 14 Bashkit cases, and keeps the existing pass. The remaining Brush case
needs an indexed nameref. This selected replay is not the full zero-loss proof.

Focused native controls cover clusters, errors, local restoration, reset,
subshell isolation, aliases, readonly bindings, temporary assignments, resource
rejection and cancellation/recovery. Full candidate verification and exact
source-line binding diagnostics are pending integration. Reports, commands,
raw streams and the resource-kill history are retained under
`/work/reports/bash-web/hill-climb/builtins/getopts/`.
