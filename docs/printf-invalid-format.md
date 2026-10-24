# printf invalid formats

Malformed directives return builtin status 1. An unfinished directive reports
its original spelling, including flags, width, precision, and trailing length
modifier bytes. A complete directive with an unknown conversion reports that
conversion byte. For example, `%z` and `%-z` report a missing format character,
while `%z\n` reports the backslash as an invalid format character.

The existing field parser gets the first chance to print a directive. The
rejection path only recognizes modifier syntax to locate the error; it does not
implement length-modified output. Valid but unimplemented conversions still
return the existing unsupported status 2. This includes unsupported numeric,
time, grouping, and destination behavior.

Both admission and delivery use the same rejection path. Diagnostics retain
work admission, cancellation, partial-write handling, and broken-pipe status.
Closed stderr keeps status 1. Ordinary output retains the real prefix, and
scalar `-v` assigns the captured prefix without writing stdout. A preceding
`%b` stop escape prevents later format validation, as before.

The 70 recorded controls in
`scripts/fixtures/shell-printf-invalid-format.json` contain the exact version,
stdout, stderr, and status from GNU Bash 5.3.15. Native and WASI tests exercise
status, output, diagnostic ordering, admission, cancellation, and pipe failure.
Run `node --test scripts/test-own-shell-printf-invalid-format.ts` after the normal
WASI guest and Node harness builds to check production Waffle. That test compares
raw stdout and status, retains raw diagnostics, and removes only Bash's source-line
annotation when comparing stderr. It never calls the host's Bash.
