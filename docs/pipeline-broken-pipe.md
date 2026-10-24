# Echo and printf broken pipes

At base `77b3963d904599932c2cd59fe46409f0ab7a6c9a`, an early reader could leave an
endless echo producer running. The write returned a real broken-pipe error, but
conversion to an ordinary status let the producer execute its next iteration.

The original local `PrintFailure` adapter keeps `Status(i32)` separate from
`Io(IoError)` through Printer-dependent formatting. `Printer::write_endpoint`
uses the existing descriptor table and `Endpoint::write_all`. The Echo/Printf
`output_outcome` boundary converts only `Io(BrokenPipe)` into existing
`Flow::Abort` with code 141. `Status(141)` remains ordinary, as do all other I/O
status conversions. There is no errno or exit-code inference.

## Diagnostic and storage policy

Stdout writes preserve their error type. Diagnostic emission still flushes
pending stdout after a non-cancellation diagnostic failure. Usage diagnostics
propagate cancellation and broken pipe while suppressing other I/O failures.
Numeric and readonly warnings propagate cancellation but suppress other I/O
failures, including broken pipe. The existing ordinary 130/141 diagnostic
policies remain status policies, not I/O classification.

Admission, cancellation, short writes, chunking and printf-v capture are
unchanged. Tests cover their existing behavior, storage refund after abort,
unavailable stderr, descriptor aliases, pipefail/lastpipe, ordinary 141 and an
external command that handles EPIPE and returns 23.

## Evidence and limits

The production regression strictly replays committed Bash `5.3.15(1)-release`
recordings on real Waffle with the existing ten-second deadline. Two assigned
Bashkit cases and six finite EPIPE discriminators fail before the change.
The five ordinary-141 controls and existing PIPESTATUS control already pass.
CI uses the recordings, never its host Bash as a new oracle.

The separate `shell-pipeline-broken-pipe-pending.json` retains two strict known
mismatches, not skipped tests: the missing closed-stdout diagnostic and Bash's
`line 1` prefix on an aliased escape warning. Run it explicitly with
`PIPELINE_FIXTURE=scripts/fixtures/shell-pipeline-broken-pipe-pending.json node
--test scripts/test-own-shell-pipeline-broken-pipe.ts`. Neither mismatch is a
broken-pipe classification error; the original scripts and recorded bytes stay
unchanged.

Other builtin printers keep their status-only helpers. No generic builtin,
interpreter, pipeline, session, runtime, state or PIPESTATUS migration is part of
this patch. It does not implement PIPE traps or dispositions. Targeted results
are potential gains only; frozen scored membership requires the parent's full
integrated replay and independent review.
