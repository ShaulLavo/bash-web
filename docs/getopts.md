# Getopts

`getopts optstring name [arg ...]` scans positional parameters, or the explicit
arguments when supplied. It supports clustered ASCII options, required attached
or separate arguments, leading-colon silent errors, `OPTERR`, `OPTARG`, `--`,
end-of-options and ordinary scalar nameref destinations. It does not change `$@`.
`OPTIND` and `OPTERR` start at 1 without becoming exported by default.

The cursor belongs to shell state, not a user-visible helper variable. Setting
`OPTIND=0` or `OPTIND=1` restarts scanning. A larger assignment changes the
visible index while preserving the active cluster's argument position.
A local `OPTIND` saves/restores the caller's cursor. Unsetting a caller's local
instead derives the cursor from the revealed binding. Snapshots isolate subshells.
Readonly assignments preserve their values while scanning still advances.
End-of-options and non-silent errors remove the nearest `OPTARG` binding itself,
including readonly or nameref bindings, without changing a nameref's target.

The scanner adapts Bashkit at the revision and source hashes in
`sources.lock.json` under `shellGetopts`. State ownership, diagnostic policy,
argument snapshots and resource controls are original. Only the current and
required next argument are copied, after cooperative scanning and command plus
execution-memory admission. An attached argument reuses the current argument's
owned buffer. Publication moves that buffer into the binding rather than copying
it twice. A saved prefix binding can require a separate copy, which is admitted.
All name scans, publication admission and local binding growth are checked before
the cursor or any binding changes. Execution tickets stay with the prepared
values until publication finishes, or drop on error or cancellation.
The optstring is borrowed and checked cooperatively. No whole argument-vector
copy or option-character collection is made.

Array/subscript destinations stay with the variables family. Non-ASCII option
bytes remain unsupported because the engine's UTF-8 scalar strings cannot store
Bash's individual invalid UTF-8 bytes. Required argument values retain UTF-8.
The `--help` response is concise, not a copy of GNU Bash's help prose.
Integer attributes and builtin temporary-assignment write-through remain with the
variables family. The default OPTIND destination retains the existing numeric
approximation; unset and local OPTIND destinations store option text literally.
Arithmetic syntax errors for integer OPTIND destinations remain pending that
attribute contract. Empty or unset OPTERR enables ordinary diagnostics; nonempty
values use a C-style numeric prefix, including vertical-tab whitespace.

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

A complete replay at the superseded `e00819b` checkpoint recorded gains of
28 Oils, 43 Brush and 23 Bashkit cases, with no losses. Its runner exited 1 because
the committed baseline lacked those 94 gained memberships. The complete JSON
comparison confirmed unchanged case membership and identities. That checkpoint
is not acceptance evidence for the subsequent review repairs.

The independent source review found eight scanner/state defects. Its 74 scripts
were rerun against Bash and production Waffle before repairs, recording 47 exact
status/stdout/stderr matches. The first repair increased this to 61, with no lost
exact matches. Remaining mismatches belong to pending source-line diagnostics,
integer attributes, temporary-assignment write-through and non-ASCII option bytes.
The complete frozen replay at `339a5b9` also gained 28 Oils, 43 Brush and
23 Bashkit cases with zero losses across all 9,221 records and 5,792 scored
cases. Its exit 1 reported exactly 94 stale gained baseline memberships; the
complete result comparison confirmed the unchanged identities and membership.
The previous complete replay at normal-main merge `0c50cc5`, based on `753c00c`,
records 1051 Oils, 1055 Brush and 1438 Bashkit passes. It gains the same 94
cases relative to that main and loses none. Its evidence remains separately
retained under `integration/`.

The current complete replay at normal-main merge `38ebb98`, based on `2f0bf11`,
records 1051 Oils, 1057 Brush and 1443 Bashkit passes. It gains the same 94
cases against 1023/1014/1420 main passes and loses none. The committed baseline
is the whole merged-source result, not selected hunks. The runner exited 1 only
for those gained memberships before refresh. All 9,221 records and 5,792 scored
cases retain their frozen identities, exclusions and classification. The three
inherited timeout failures remain unchanged, with no new abnormal outcomes or
gains from resource events. Exact IDs and observations are retained in
`integration-2f0/abnormal-outcomes.json` beside the complete proof.

Focused controls include publication failure preserving every binding and the
active cluster, successful 360448-byte attached arguments, and cancellation with
recovery. The current merged source passes 1338 native and 1318 WASI tests, Rust and
JS quality checks, exact/structural duplicate gates, layer controls and the
impacted file-substitution and CI-workflow controls. All 74 probes retain 61
exact matches with no losses. Scanner, state and shared writer source remain
identical to independently approved repair checkpoint `339a5b9`; that approval
is bounded to the repairs and later small deltas, not full-family or merge
approval.

Exact binding and own-option line prefixes remain unimplemented. Six
whole-output checks are deferred by a missing shared source-provenance contract;
the wrapper PR does not provide it. No competing tracker, constant line or
lexical fallback is added. Ordinary option diagnostics remain prefix-free. Reports, commands, raw streams and the resource-kill history
are retained under
`/work/reports/bash-web/hill-climb/builtins/getopts/`.
