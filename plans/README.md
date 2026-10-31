# Plans (internal)

Working plans and implementation journals, not user documentation. For what the project does and why it is shaped this way, read [the README](../README.md) and [docs/adr/](../docs/adr/).

This folder stays at `plans/` because the frozen scoreboard evidence (`docs/evidence/own-shell-instrument-migration.json`) and `sources.lock.json` name these paths, and those files are digest-checked. A plan leaves when its decision is an ADR and its journal is deleted.

| Plan | Subject | Status field |
| ---- | ------- | ------------ |
| `004-own-shell.md` | The Rust shell engine, the compatibility score, and a dated journal of each feature unit | Approved |
| `005-bash-web-packaging.md` | Package boundary with Waffle and the browser integration | Approved |
| `006-engine-boundaries.md` | Layer gate, shared execution types, utilities as separate programs | Approved |
| `009-read-timeouts-and-mapfile.md` | Streaming `read` timeouts and `mapfile` publication | Approved |
