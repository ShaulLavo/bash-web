# Frozen evidence (not user documentation)

JSON records that scripts read and check by digest. Do not edit or regenerate them in ordinary work.

- `own-shell-oracle.json`: GNU Bash 5.3.15 observations for the fixed compatibility cases.
- `own-shell-baseline.json`: per-case pass, fail and skip results the CI score may not fall below.
- `own-shell-instrument-migration.json`, `own-shell-runtime-migration.json`, `oracle-pipe-audit.json`: receipts and audit output for changes to the scoring instrument.
- `engine-layers.json`: the layer-gate record that `npm run check:layers` rewrites with `--record`.
- `licenses/`: license texts that `scripts/notices.mjs` copies into the distribution notices.
- Every other file is a measurement receipt for one feature unit, linked from that unit's page in `docs/`.

The scripts name these paths, so the folder cannot move. See [Bash compatibility](../bash-compatibility.md) for how the score is produced.
