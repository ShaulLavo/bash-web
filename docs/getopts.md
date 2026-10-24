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
Arithmetic syntax errors for integer OPTIND destinations wait for that
attribute contract. Empty or unset OPTERR enables ordinary diagnostics; nonempty
values use a C-style numeric prefix, including vertical-tab whitespace.

## Verification

The frozen production-Waffle replay of all 9,221 records (5,792 scored) records 1051 Oils, 1057 Brush and 1443 Bashkit passes. Against a baseline of 1023, 1014 and 1420, that is 28 Oils, 43 Brush and 23 Bashkit gained cases (94 in all), with no losses and no gains from resource events. Identities, exclusions and classification are unchanged, and the three inherited timeout failures remain. The runner exits 1 until the baseline includes the 94 gained memberships. Replay with the command in [Bash compatibility](bash-compatibility.md); it runs one case worker under Node's 384 MiB heap cap, because four parallel jobs exceed the memory limit of a small host. Exact IDs and observations are in `docs/evidence/`.

Of the 87 scored getopts cases, 86 passed after the change and the remaining Brush case needs an indexed nameref. A set of 74 scripts compared against Bash 5.3.15 and production Waffle gives 61 exact status, stdout and stderr matches. The rest differ in source-line diagnostics, integer attributes, temporary-assignment write-through and non-ASCII option bytes.

Focused controls cover publication failure preserving every binding and the active cluster, successful 360448-byte attached arguments, and cancellation with recovery. The merged source passes 1338 native and 1318 WASI tests, the Rust and JS quality checks, the duplicate gates, the layer controls, and the file-substitution and CI-workflow controls.

Exact binding and own-option line prefixes are not implemented, and neither is a constant line or lexical fallback. Six whole-output checks wait on a source-provenance contract the wrapper does not yet provide. Ordinary option diagnostics are prefix-free.
