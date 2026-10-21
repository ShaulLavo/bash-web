# Printf option boundaries

`printf -- FORMAT ARG...` consumes one initial `--`. The next argument is the
format, even when it is another `--`, `-v`, or another hyphen-prefixed string.
Without the terminator, a lone `-` is a format but a longer hyphen-prefixed first
argument is an option. Empty formats succeed. All arguments after the format
remain data, including `--`, `-x`, `-v` and `--help`.

Missing formats and unknown options return status 2. Unknown-option diagnostics
name the first raw option byte; bare `-v` reports its missing operand before
usage. Closed diagnostic descriptors retain usage status 2. Cancellation returns
130, and a broken diagnostic pipe returns 141. Admission covers diagnostics as
well as formatted output before any writes. Existing byte formatting, format
reuse, partial writes, bounded buffering and `%b` stop-output behavior are unchanged.

Successful `-v` assignment and help rendering are not implemented. Supplied `-v`
operands and exact `--help` return explicit unsupported diagnostics rather than
printing those options as successful formats. This includes variable-name
validation, attached names, and missing formats after supplied `-v`; they are
not claimed Bash-compatible by this unit. `%q`, floats, parser and runtime work
are also outside this change.

Observations compare raw stdout and status independently of stderr. Diagnostic
comparison removes only Bash's source-line annotation; merged streams retain
that raw difference and have a separately labeled normalized comparison.
See [the measurement receipt](evidence/printf-options.json).

A direct OS-pipe probe still differs from Bash. An outer Bash wrapper waits
on stdin before exec, so closing its stderr reader before the trigger starts
`printf -x` with no diagnostic reader. The standalone CLI keeps status 2, while
Bash dies with SIGPIPE. The standalone adapter drains internal pipes after
driving the job and interrupts on host write failure; that can happen after the
job has finished. The focused
engine test covers a closed logical pipe, not this adapter limitation. No adapter
or runtime change is included.
