# `mapfile` and `readarray`

`mapfile` and its `readarray` alias read delimiter-terminated records from a
file descriptor into a sparse indexed array. The implementation publishes each
completed record immediately, so records already read remain visible when
later input, cancellation, or storage work fails.

## Supported

- `-d delim`: use the first byte of `delim`; an empty value uses NUL.
- `-n count`: store at most `count` records; zero means no limit.
- `-O origin`: overlay records starting at `origin`, including origin zero.
- `-s count`: skip that many records before publishing.
- `-t`: remove the delimiter from stored values.
- `-u fd`: read from an existing descriptor.
- `-c quantum`: validate a positive callback quantum. Callback execution is not
  implemented, so the option otherwise has no effect.
- `MAPFILE` is the default target when no array name is supplied.

Records are streamed through a bounded scratch buffer. A positive `-n` uses
single-byte reads, leaving trailing input available to a later command. NUL
bytes truncate the stored UTF-8 value, and bytes after the first NUL are not
validated. A record that exceeds the line limit or contains invalid UTF-8
before its first NUL returns status 2; earlier records remain published.

`-C callback` is deliberately unsupported. It returns status 2 before reading
input or changing the target array. Invalid names, readonly targets, indexed
nameref targets, projected call-stack arrays, and `PIPESTATUS` are rejected
before input. Ordinary namerefs, local arrays, case attributes, and temporary
builtin prefixes use the shared state model.

Without `-O`, the target becomes an empty indexed array before input, even if
there are no records. Any explicit `-O` preserves elements outside the written
indices. `-n`, `-s`, and `-O` accept decimal values from 0 through 4294967295,
including one optional sign and surrounding ASCII whitespace. Nonzero negative
values fail with status 1. `-c` also rejects every converted zero, including `-0`.

EOF and input errors other than cancellation return status 0 and publish a
nonempty partial tail. Cancellation returns status 130 and discards the current
partial record. Completed records remain visible in both cases.

## Deliberate gaps

The engine stores UTF-8 strings rather than arbitrary bytes, so raw bytes in a
stored value are outside this feature. `PIPESTATUS` follows the engine's
separate pipeline-status producer policy and is rejected, unlike GNU Bash.
`IFS` refreshes the engine's existing views. An array-valued `IFS` disables field
splitting and joins `"$*"` with element zero. GNU Bash instead splits on element
zero and keeps `"$*"` space-joined for this operation. `OPTIND` publication does
not reset the hidden getopts cursor, matching GNU Bash 5.3.15.

Create an indexed local with `local a; a=(...)`. The declaration layer does not
yet support `local a=(...)`. Nameref cycles and chains beyond eight links return
status 1 rather than Bash's warning and success. The five projected stack arrays
reject with status 1. After `unset FUNCNAME`, that name becomes an ordinary target.

INT trap actions do not run in this engine. Tests inspect the completed prefix
before interruption and read it again in the same session after interruption.

## Verification

The native and production-Waffle tests cover records, empty lines, tails,
NULs, delimiters, skip/count/origin combinations, aliases, target validation,
case attributes, cancellation and incremental publication. New compatibility
controls are recorded against GNU Bash 5.3.15.
