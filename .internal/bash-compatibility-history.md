# Bash compatibility: history

Working notes, not user documentation. Split out of `docs/bash-compatibility.md`: the Brush/Bashkit/just-bash comparison from the `brush-web` prototype, the dated steps of the own-shell score, the replay-instrument transition and the output-stream recording correction. Links into `evidence/` here are relative to `docs/`.

## Historical study: Brush, Bashkit and just-bash

**Historical.** The sections from here through [Caveats](#caveats) preserve the original comparison of Brush, Bashkit, just-bash, and native Brush, measured in brush-web. They are evidence of the field at that time, not bash-web gates or fresh measurements. Raw results are in [bash-compatibility.json](evidence/bash-compatibility.json).

## Method

- **Oracle:** GNU bash 5.3.15(1)-release, run as `bash -c` with empty stdin. Oils' own expected-output annotations are ignored.
- **Pass:** stdout bytes and exit status identical to bash. Each engine's `$TMP` and `$HOME` paths are normalized first. stderr is recorded but not scored, because error messages legitimately differ. Bash and the engines produced stderr in the same cases (both empty or both non-empty) for 97–99% of passing Oils cases.
- **Fresh shell per case,** 10-second timeout. Crashes and timeouts count as failures.
- **Interpreter score versus commands:** bash runs each case once with the full `PATH` and once with only the two test helpers on `PATH`. A case is _builtins-only_ when both runs agree. Only builtins-only cases form the interpreter score. Other cases need external commands or start `$SH`. They are reported separately, and a failure is labeled _missing command_ when the engine lacks a command bash needed.
- **Determinism:** bash runs each case twice, and cases with differing results are dropped (8 in total).
- **Helpers:** Oils cases call `argv.py` and `printenv.py`. Bash gets Python 3 equivalents of Oils' Python 2 scripts. The other engines get identical builtins.

| Engine          | How it ran                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Brush (browser) | Pinned Brush plus `patches/brush-browser.patch`, built for `wasm32-wasip1`. A second binary in `rust/brush-browser` (`brush-compat`) builds the same shell as the browser binary, with the same `brush-core`, Bash-mode builtins and browser utilities, but runs a script instead of the interactive editor. It runs under `node:wasi` with an in-memory-like root directory. |
| Bashkit source  | WASM from `npm run build:bashkit` (the `bashkit-terminal` engine), through `Bash.execute` with the workbench options. A thrown parse error counts as status 2.                                                                                                                                                                                                                |
| Bashkit 0.18.2  | Published `@everruns/bashkit-wasm`, same options.                                                                                                                                                                                                                                                                                                                             |
| just-bash 3.6.0 | `Bash.exec` with `rawScript` and the workbench's execution limits, all bundled commands.                                                                                                                                                                                                                                                                                      |
| Brush native    | Reference only: the same pinned source built natively, run as `brush -c` with host commands. It separates Brush's interpreter from its browser port.                                                                                                                                                                                                                          |

## Corpora and bias

| Corpus                                                                                                                                     | Written by   | Used how                                                                  | Bias                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Oils spec tests](https://github.com/oils-for-unix/oils/tree/bdc8364c253ce921e033bbc2399ea2ce0be41825/spec), pinned in `sources.lock.json` | Oils project | **Primary.** 120 files that compare against bash, 2,492 cases             | **Not neutral.** just-bash vendors these files in its test suite. Bashkit runs this suite against real bash as a tracked metric (`just oils-spec`; nine result snapshots on 2026-10-08 and 09 alone). Only Brush is untuned. |
| Brush `brush-shell/tests/cases/compat`                                                                                                     | Brush        | Secondary. Cases defined only by a script (2,228 of 2,894)                | Home suite for Brush, held out for the others. 601 cases are marked as known Brush failures.                                                                                                                                 |
| Bashkit `tests/spec_cases/bash`                                                                                                            | Bashkit      | Secondary. Files ported from Oils or just-bash are dropped (3,825 scored) | Home suite for Bashkit, held out for the others.                                                                                                                                                                             |

Excluded Oils files cover interactive editing, history, completion, prompts and bind; job control, cross-process signals, ulimit, umask and times; shell executable flags (`sh-usage`); xtrace, whose output is stderr only; and files with no bash comparison. The JSON lists each file and its reason. Also excluded: 30 Oils cases that read files from the Oils repository, and the Brush harness cases that need arguments, fixture files, a terminal or environment setup.

## Results: builtins-only (interpreter)

| Oils category                                   |     Cases | Brush (browser) | Bashkit source | Bashkit 0.18.2 | just-bash | Brush native |
| ----------------------------------------------- | --------: | --------------: | -------------: | -------------: | --------: | -----------: |
| Quoting and word splitting                      |        73 |           91.8% |          97.3% |            63% |     93.2% |        93.2% |
| Parameter expansion                             |       173 |           69.9% |          92.5% |          53.2% |     86.1% |        69.9% |
| Brace expansion                                 |        53 |           96.2% |          94.3% |          56.6% |     96.2% |        98.1% |
| Arithmetic                                      |       116 |           83.6% |          96.6% |          59.5% |     93.1% |        83.6% |
| Arrays and assoc arrays                         |       127 |           66.9% |          95.3% |          29.1% |     87.4% |        67.7% |
| Assignment, scope and special vars              |       109 |           77.1% |          93.6% |            55% |     80.7% |          78% |
| Command substitution and subshells              |        25 |             92% |           100% |            80% |      100% |          92% |
| Globbing and extglob                            |        76 |           92.1% |           100% |          55.3% |     77.6% |        92.1% |
| Conditionals, test, `[[ ]]` and case            |       146 |           89.7% |          99.3% |          60.3% |     97.9% |        91.1% |
| Grammar, functions and control flow             |       180 |           86.1% |            95% |          75.6% |     86.7% |        88.3% |
| Here-docs and redirects                         |        44 |           81.8% |          95.5% |          65.9% |     95.5% |        90.9% |
| Pipelines                                       |        12 |           91.7% |           100% |          83.3% |      100% |        91.7% |
| errexit, options and traps                      |       164 |           61.6% |          93.9% |          44.5% |     57.3% |        67.1% |
| echo, printf, read, mapfile, getopts            |       147 |           82.3% |          95.2% |          60.5% |     93.2% |          83% |
| Other builtins (cd, eval, source, type, alias…) |       155 |           65.2% |          94.8% |          47.7% |     80.6% |        71.6% |
| Real-world idioms (ble.sh, blogs, Nix)          |        82 |             78% |          92.7% |            39% |     81.7% |        79.3% |
| **Oils overall**                                | **1,682** |       **78.4%** |      **95.4%** |      **55.1%** | **85.3%** |    **80.4%** |
| Brush suite (held out except for Brush)         |     1,889 |           70.8% |          84.1% |          55.8% |     68.3% |        76.9% |
| Bashkit suite (held out except for Bashkit)     |     2,223 |           82.1% |          96.2% |          70.8% |     81.3% |        84.6% |

On each engine's held-out corpora, Bashkit source scores 84.1% on the Brush suite, against Brush's own 70.8% (browser) and 76.9% (native). Brush scores 82.1% on the Bashkit suite and just-bash 81.3%. just-bash's lead over Brush on Oils mostly disappears on the two corpora it did not import.

## Results: cases needing external commands

| Corpus        | Cases | Brush (browser) | Bashkit source | Bashkit 0.18.2 | just-bash | Brush native |
| ------------- | ----: | --------------: | -------------: | -------------: | --------: | -----------: |
| Oils          |   779 |           47.8% |          93.2% |          43.9% |     83.3% |        80.9% |
| Brush suite   |   339 |           33.3% |            72% |          40.1% |     54.6% |        83.2% |
| Bashkit suite | 1,602 |           12.6% |          94.5% |          61.7% |     59.9% |        94.4% |

Most Brush failures here are missing commands (1,623 of its failures across the three corpora). This measures the browser command set, not the interpreter.

Of the 60 common commands probed with `command -v`, the browser Brush build has 12: `cat ls mkdir rm touch seq printf echo test true false sleep`. Bashkit source has 59 (no `python3`), Bashkit 0.18.2 has 57 (no `bash`, `sh` or `python3`), and just-bash has 55 (no `realpath hexdump df curl python3`). The table also includes 23 option-level spot checks of `grep`, `sed`, `awk`, `sort`, `uniq`, `cut`, `tr`, `head`, `tail`, `wc`, `find`, `xargs` and `jq` against GNU output. Bashkit source passes 21, Bashkit 0.18.2 passes 21, just-bash passes 20, and Brush passes 0 because it has none of those commands. `grep -r --include` and `wc -l -w` padding failed in all three. `uniq -c` failed only in just-bash.

## Most consequential failures

**Brush (browser).** Namerefs (`declare -n`) are unimplemented: 24 of 29 Oils cases fail, and Brush marks 190 of its own nameref cases as known failures. Alias expansion applies to quoted words and to aliases defined on the same line (`alias`: 20 failures). `trap ERR` and `trap DEBUG` do not follow bash (46 failures across the three trap files). Several `printf` format corners fail (17), and so do `command`/`builtin` forwarding of declaration builtins and arrays with odd subscripts. Some failures come from the browser port rather than the interpreter. In this run any `$$` panicked the WASM module (`std::process::id()` is unsupported on WASI): 52 crashes across corpora. `$$` and `$BASHPID` now report PID 1, as Bashkit does. A Brush-only rerun after that fix leaves 2 crashes, in a brace sequence with a huge increment and an alias inside `PS4` (both also fail natively), and raises the builtins-only pass rates to 78.5% (Oils), 71.2% (Brush suite) and 82.3% (Bashkit suite). The tables above predate the fix. `exec` and `kill` are missing. Brush native passes 2–6 points more, which bounds this port cost.

**Bashkit source.** Few and scattered: `printf` integer overflow and `%(...)T`, nounset inside arithmetic (status 1 instead of bash's 127), tilde expansion in `[k]=v`, some `${!ref}` corners, and `trap ERR` with pipelines. Its API rejects unparsable scripts with an exception instead of a status. Its largest deficit is on the Brush suite (84%), which shows real gaps beyond its tuned corpus, in areas including nameref corners, `set -u` cases, `extdebug`/`functrace` DEBUG traps, `getopts`, and backtick escaping. It is a sandbox with resource budgets, and the mapfile bug shows that a budget failure can corrupt state silently.

**just-bash.** Traps are mostly missing or wrong (55 failures in the three Oils trap files). Glob results are wrong after variable or `$@` expansion (12), and so are alias expansion corners (13), `errexit` inside command substitution, `local`/`readonly` corners, and `type -a`. Output is UTF-16 text rather than bytes, so `printf '\xff'` does not produce byte 0xFF.

**Bashkit 0.18.2** fails broadly (arrays 29%) because the large compatibility work landed after that release.

## mapfile triage (Bashkit)

The earlier "empty after about ten 10,000-line `mapfile` runs" result is a real interpreter bug, not the 32 MiB `maxMemory` setting. Raising `maxMemory` to 256 MiB or leaving it unset changes nothing.

```bash
seq 50000 > /tmp/s
for i in 1 2 3; do mapfile -t a < /tmp/s; echo "mapfile=$? n=${#a[@]}"; done
b=(x y z); echo "b=${#b[@]}"
```

Bash prints `n=50000` three times and `b=3`. Bashkit source and 0.18.2 print `n=50000`, `n=50000`, `n=0`, `b=0`, all with status 0 and no stderr. The effect persists in later `execute()` calls on the same instance; a new instance is clean.

Cause: `mapfile` replaces the array through builtin side effects that remove the old array without releasing its entries from the memory budget. Each call therefore adds its full line count to `array_entries`. At 100,000 entries (`DEFAULT_MAX_ARRAY_ENTRIES`, which the WASM options do not expose), `insert_array_checked` refuses the insert, and callers ignore that refusal. From then on, every array assignment in the session silently produces an empty array. Ten 10,000-line reads hit exactly that threshold. The probe output is under `mapfile` in the evidence JSON. A ready-to-file upstream report, with source locations and a suggested fix, is in the owner's upstream-bug list. A fork must fix both the leak and the ignored refusal.

## Caveats

- Brush runs on `node:wasi`, not the browser's WASI shim. The interpreter is identical, but filesystem edge cases may differ slightly.
- `bash -c` differs from Oils' practice of feeding code on stdin, for example in `read` without a redirect. Every engine runs the same way.
- Category labels group Oils files by subject. Cases inside a file can touch other features.
- Bashkit and just-bash were tuned against Oils. Treat their Oils numbers as upper bounds, and use the held-out rows for the comparison.


## Own-shell fixed scoreboard and its history

**Method first, history after.** The replay command and the rules that hold the score are in the paragraphs and code blocks below. The tables of passes (288, 291, 951, 948, 524, 527 and so on) are dated steps on the way to the current score above, not the current score. For the committed baseline, see [Current score](#current-score).

`own-shell` is the package's only default engine. Since 2026-10-18 its frozen
replay runs the production `shell-runtime` guest on Waffle's Node runtime (see
[the replay instrument transition](#replay-instrument-transition)); earlier
measurements below came from the original standalone `shell-engine` CLI. The first measured baseline, now superseded, was
**288/1,682 Oils, 295/1,888 Brush-suite and 445/2,222 Bashkit-suite**. The
historical engine tables above keep their original case sets and are not a
comparison under this fixed identity.

| Corpus        | Previously classified builtins-only cases | Fresh scored cases | Own-shell passes |
| ------------- | ----------------------------------------: | -----------------: | ---------------: |
| Oils          |                                     1,682 |              1,682 |              288 |
| Brush suite   |                                     1,889 |              1,888 |              295 |
| Bashkit suite |                                     2,223 |              2,222 |              445 |

The first word-field expansion slice raises the committed baseline without
changing the fixed identity, eligibility or oracle observations:

| Corpus        | Initial passes | Word-field passes | Gained | Lost |
| ------------- | -------------: | ----------------: | -----: | ---: |
| Oils          |            288 |               291 |      3 |    0 |
| Brush suite   |            295 |               304 |      9 |    0 |
| Bashkit suite |            445 |               452 |      7 |    0 |

The [measured replay](https://github.com/ShaulLavo/brush-web/actions/runs/38886633355)
at `1149096` supplies these outcomes. CI also checks fresh pass membership against
the committed baseline, so later fixes cannot silently lose one of these gains.
This slice covers quoting, empty arguments, IFS, positional/PIPESTATUS field
boundaries and declaration syntax. Parameter operators, globbing, tilde and
brace expansion remain later slices. Declaration syntax deliberately diverges
from Bashkit where escaped names or `=` wrongly suppress splitting (upstream
bug report #26 in the owner's ready-to-file list); the engine uses retained raw
word spelling and leaves the parser byte-identical. Cold-start measurement
continues to wait for real-browser integration.

Two fresh GNU bash runs disagreed on `brush-suite:options/set-e:145` and
`bashkit-suite:background:11`. Both retain the explicit exclusion
`fresh bash oracle output is not deterministic`. These account for the two
smaller denominators. Oils remains at 1,682. No existing engine was rescored on
this changed set, so the earlier percentages must not be treated as fixed-set
pass-count targets without rerunning those engines under the same identity.

The [oracle capture](https://github.com/ShaulLavo/brush-web/actions/runs/38882400825)
used source `2b27d77`, GNU bash 5.3.15 inside bubblewrap and Node v26.7.0. The
[baseline measurement](https://github.com/ShaulLavo/brush-web/actions/runs/38882791088)
used source `5489846`. Initial metadata was refined from `nodeMajor: 26` to the
exact `nodeVersion: "v26.7.0"` used by setup-node. GNU bash observations, case
classifications and source-file hashes did not change. The baseline identity
was resealed to match this metadata; no shell was rerun for that refinement.

[The committed baseline](evidence/own-shell-baseline.json) records exact counts
for all 16 Oils subject categories, 120 Brush file categories and 261 Bashkit
file categories, including categories whose cases are all skipped. Its `counts`
are recomputed from per-case outcomes when validated. Oils' first scored counts:

| Oils category                                     | Scored cases | Passes |
| ------------------------------------------------- | -----------: | -----: |
| Quoting and word splitting                        |           73 |     38 |
| Parameter expansion                               |          173 |      6 |
| Brace expansion                                   |           53 |      5 |
| Arithmetic                                        |          116 |      1 |
| Arrays and assoc arrays                           |          127 |      5 |
| Assignment, scope and special vars                |          109 |      9 |
| Command substitution and subshells                |           25 |      2 |
| Globbing and extglob                              |           76 |     24 |
| Conditionals, test, [[ ]] and case                |          146 |     21 |
| Grammar, functions and control flow               |          180 |     82 |
| Here-docs and redirects                           |           44 |     26 |
| Pipelines                                         |           12 |      9 |
| errexit, options and traps                        |          164 |     19 |
| echo, printf, read, mapfile, getopts              |          147 |     14 |
| Other builtins (cd, eval, source, type, alias...) |          155 |     16 |
| Real-world idioms                                 |           82 |     11 |


### Replay instrument transition

On 2026-10-18 the frozen replay moved from the standalone `node:wasi` CLI, with its
in-memory filesystem and in-process fixture host, to the Waffle Node harness. GNU
Bash observations, the case set, sources and schema are unchanged; only the oracle's
replay `environment` record (which describes our runner) and its identity digest
changed. Main `9f0bf6a` scored **951 / 955 / 1,341** (Oils / Brush suite / Bashkit
suite) on the old runner and **948 / 956 / 1,339** on the real runtime, with 10
cases lost and 6 gained. Every changed case is classified in
[the receipt](evidence/own-shell-instrument-migration.json) with Bash's output, the
old runner's and the real runtime's: **10** are real-runtime differences from Bash,
each an approved item recorded in that receipt,
and **6** were fake-host artifacts.

| Case | Change | Class | Reason |
| --- | --- | --- | --- |
| `bashkit-suite:proc-self:57` | lost | a | No /proc/self exists on the runtime filesystem, so writing /proc/self/comm fails; the old pass came only from the in-memory filesystem creating files without parent directories. |
| `bashkit-suite:script-exec:132` | lost | a | Same writable-/usr difference (126 instead of 127). |
| `bashkit-suite:script-exec:95` | lost | a | The oracle's sandbox mounts /usr read-only; Waffle's filesystem has no read-only mount, so the script is created and fails as non-executable (126) instead of not found (127). |
| `bashkit-suite:subprocess-isolation:126` | lost | a | Same writable-/usr difference (126 instead of 127). |
| `bashkit-suite:test-operators:32` | lost | a | test -r is unsupported on the runtime filesystem (no access metadata through preview1). |
| `bashkit-suite:test-operators:40` | lost | a | test -w is unsupported on the runtime filesystem (no access metadata through preview1). |
| `oils:builtin-bracket:280` | lost | a | The runtime filesystem exposes no Unix mode bits, so test -k is an unsupported predicate (status 2); the old in-memory filesystem answered it. |
| `oils:builtin-read:794` | lost | a | read from a directory reports status 2 on the runtime filesystem instead of Bash's status 1 (EISDIR mapping). |
| `oils:shell-grammar:17` | lost | a | shell-runtime's -c exit cancels a still-running background job, truncating its output; Bash leaves it to finish. |
| `oils:shell-grammar:23` | lost | a | Same background-job cancellation at -c exit: the last job's newline is lost. |
| `bashkit-suite:bashbox-filesystem-backends-integration:5` | gained | b | Fake-host artifact: the in-memory filesystem created ro/new without a parent directory; the real filesystem fails like Bash. |
| `bashkit-suite:bashbox-interpreter-builtins:281` | gained | b | Fake-host artifact: /no/such/dir/f was created without parents in memory; the real filesystem fails like Bash. |
| `bashkit-suite:pipes-redirects:411` | gained | b | Fake-host artifact: &> /no/such/dir/f was created without parents in memory; the real filesystem fails like Bash. |
| `bashkit-suite:stderr-redirect-fidelity:132` | gained | b | Fake-host artifact: /proc/naopode was created without parents in memory; the real filesystem fails like Bash. |
| `brush-suite:ifs:26` | gained | b | Fake-host artifact: the standalone CLI's environment setup replaced the shell's default IFS, so $IFS printed empty; the runtime entry keeps Bash's default IFS. |
| `oils:var-sub:24` | gained | b | Fake-host artifact: the in-memory filesystem created _tmp/var-sub1 without its parent, so the redirect succeeded; on a real filesystem it fails with status 1 like Bash (Bash's reason is an ambiguous redirect; see R6). |

The committed baseline is now the real runtime's per-case result and the ratchet
continues against it. Comparing a candidate with a target recorded on the old
runner is allowed only for this one transition: `shell-scoreboard-base.mjs` names
the target commit and the old and new environment digests, and the receipt must
match them. The target's own shell is then rebuilt and scored by the new instrument,
and it must differ from the target's old baseline by exactly the receipt's cases.
Any other environment change, or any change to Bash observations, case set,
sources or schema alongside it, is incomparable and fails.

### Output-stream recording correction

The [2026-10-17 transport audit](evidence/oracle-pipe-audit.json) covers all **5,792**
eligible cases: two independent pipe captures and one legacy socket capture per
case. All three captures completed; the repeated pipe observations agreed in both
scored output and diagnostic bytes. The **3,429** existing skips and all case,
source and environment identities remain unchanged.

Seven cases have corrected stdout or status, and one has a stderr-only correction:

| Case                                             | Recording error                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `oils:redirect:521`                              | Reopening `/dev/stdout` failed instead of printing each command's arguments. |
| `oils:redirect:543`                              | The same failure suppressed output and descriptor-allocation updates.        |
| `bashkit-suite:dev-fd-paths:10`                  | Reopening merged `/dev/stderr` failed instead of printing `err`.             |
| `bashkit-suite:dev-fd-paths:16`                  | Appending to merged `/dev/stderr` failed instead of printing two lines.      |
| `bashkit-suite:dev-fd-paths:23`                  | Reopening `/dev/stdout` for stderr failed instead of printing `e`.           |
| `bashkit-suite:dev-fd-paths:29`                  | Reopening `/dev/fd/1` failed instead of printing `two`.                      |
| `bashkit-suite:dev-fd-paths:45`                  | A variable naming merged `/dev/stderr` failed instead of printing `warn`.    |
| `bashkit-suite:bashbox-interpreter-builtins:274` | Stderr-only: reopening `/dev/stderr` now prints `x`, not the socket error.   |

For each correction, the legacy socket observation reproduces the original
frozen answer exactly for the affected streams, and both pipe captures reproduce
the corrected answer. Each script was inspected to establish that the difference
comes from reopening an output descriptor, not merely from correlated captures.
The initial recorder metadata is preserved; `oracle.transportCorrection` records
the separate audit capture and its different Bash executable hash.

Other host-dependent differences are **not** refreshed. Frozen observations for
host names, dates, user IDs, resource limits and locally unavailable commands stay
as recorded. In particular, `bashkit-suite:time:78` happened to have repeatable
pipe timing diagnostics different from the socket capture; its script does not
reopen an output descriptor, so those diagnostic bytes remain frozen too. The
evidence lists every observed scored difference and the retained unrelated ones.
The archived target's old passing-case membership is proven before the same
binary is rescored; this is a recording correction, not an engine improvement.
The exact `9b371d4` engine reproduced **525 / 394 / 785** original passes
(Oils / brush-suite / bashkit-suite), then scored **524 / 394 / 785** against the
corrected oracle. Only `oils:redirect:543` changed from pass to fail: the old
socket error had accidentally matched the engine's missing output. The engine
binary is unchanged, and the evidence records its SHA-256 and both measurements.


### Runtime integration utility and prefix slice

The [CI replay at `7d1f730`](https://github.com/ShaulLavo/brush-web/actions/runs/39027801280)
measured **527 Oils, 394 Brush-suite, and 792 Bashkit-suite passes** against the
corrected pipe oracle. Ordinary builtin prefix assignments and bounded `grep` /
filesystem `mkdir` support gain three Oils and seven Bashkit cases, with no lost
passes compared with the corrected target baseline (**524 / 394 / 785**). The
committed baseline records this exact pass membership; the same replay failed
only because that membership had not yet been refreshed. This score is separate
from the browser, native-test, and Safari gates.

