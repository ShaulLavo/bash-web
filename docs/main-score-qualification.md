# Qualify an exact main source

An explicit main qualification dispatch measures an unchanged main checkout and publishes its cumulative compatibility floor. Ordinary branch dispatches only qualify their branch against main. PR observations remain excluded from main evidence.

The `main_source` input is a full commit SHA. Preparation requires it to equal authenticated current main and selects its actual first parent as the predecessor. The executor workflow and controller can come from a separate immutable commit so a reviewed repair branch can qualify a main commit whose historical workflow cannot do so.

The binding records both commits and the executor ref. Admission requires the executor's workflow, controller imports and dependency manifests to match the consuming resolver's immutable Git blobs. The measured checkout supplies its own unchanged build scripts, Waffle harness, source pins and oracle. Controller files are never copied into it.

Preparation resolves the predecessor. Folding preserves its passes, every earlier admitted observation of this source and the fresh observation. A successful producer and upload alone do not admit a dispatch result: the entire dispatch workflow must complete successfully. Repository, workflow, branch, source, predecessor, run, attempt, producer, upload logs and archive digests remain mandatory.

This protocol does not allow arbitrary branch dispatches, PR scores, source substitutions, static baselines or skipped main edges. It cannot qualify a source with an unresolved predecessor.

## Dependency merge token

Configure the repository secret `DEPENDENCY_MERGE_TOKEN` before enabling the dependency publisher. Use a repository-scoped fine-grained personal access token or GitHub App installation token with **Contents: write** and **Pull requests: write**, plus the implicit metadata read permission. No branch-protection bypass is needed. The identity must be allowed to merge the reviewed PR under the repository's normal rules.

Only the final auto-merge command uses this token. Branch publication, status reporting and dispatch use `github.token`. The publisher fails with a configuration error when the dedicated token is absent. It never falls back to `GITHUB_TOKEN`, whose merges suppress the required push workflows.
