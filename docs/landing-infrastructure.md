# Landing checks without shared snapshots

The landing checks compare actual sources and retain accepted passing cases in CI artifacts. Feature PRs do not update a version, layer snapshot, or committed score baseline.

The layer check scans immutable base and candidate Rust files using the base scanner and policy. It rejects new violation edges and count growth. `LAYERS_OUTPUT` selects the full comparison artifact. The historical JSON is not a gate input.

Scoreboard test files are discovered from their existing filename families. Adding a matching `.mjs` or `.ts` test needs no package recipe edit. The runner executes tests with Node concurrency one.

The score floor is the union of the preceding main floor and every admitted observation of the current source, including earlier attempts. A regression fails the gate without deleting old passes. A complete failed timeout is a scored failure, not an incomplete replay.

Main sources have independent concurrency groups. Each run scores once and uploads a complete raw result. A separate blocking job admits the completed producer job and successful upload, then compares and publishes the accumulated floor. It does not wait for the whole workflow to finish. PR results never become main evidence.

The resolver checks exact repository, workflow, main event, source, run, attempt, producer job, upload steps and artifact digest. It proves documentation-only source equivalence per intervening main edge, with a 32-edge limit. Missing or expired non-equivalent evidence is an explicit prerequisite. It never starts historical replays or falls back to a static score.

PR qualification records the head, tested merge, event base and resolved main separately. Later unrelated main changes follow the normal no-retest policy. The post-merge main check uses its actual predecessor.

Compact floor artifacts expire after 90 days. Retained complete scores need only a cheap fold. A genuinely missing non-equivalent score needs an explicit exact-source qualification, and older workflows may make that unavailable. Parent landing reports own retained run and digest references; CI owns uploaded evidence. No evidence writer branch or extra credential is required.

See [Accepted-gain recovery](accepted-gain-recovery.md) for the single landed-PR gap supported by candidate qualification.
