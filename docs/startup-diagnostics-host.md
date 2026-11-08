# Startup diagnostics on the page host

The startup adapter runs every body from `tests/startup-diagnostics.spec.ts` through Waffle's page host. The original file, assertions, held-request callbacks, and restart promise remain unchanged. This input-free adapter does not replace the demo's fetches or runtime.

Build the normal browser demo first. Then run the local host qualification:

```sh
npm run build:browser
TMPDIR=/work/tmp npm run test:startup:local -- /absolute/path/startup-result.json
```

The local runner uses Chromium, not an iPhone. `scripts/test-startup-diagnostics-ios.ts` is the native entry. Native execution and adoption of a supported Waffle release remain separate gates. The draft requires the development SDK's query, mutable timeout, and ordinary-asset hold contracts. The committed Waffle dependency does not yet provide those contracts. There is no old-package fallback.

Each case binds `test=1`, `renderer=canvas`, and a distinct workspace before the demo loads. The adapter waits for the exact workspace allocation acknowledgement before importing the normal emitted demo module. It serves the complete emitted asset directory and the original shell and test guests with their ordinary types and bytes. Finish deletes only the four acknowledged databases.

Readiness uses the existing storage-credit policy. Each storage interval temporarily extends the original 60-second body deadline, then reduces it to credit only elapsed storage waiting. The two intervals in the restart and pending-registration cases accumulate. The shell poll stays at five seconds and teardown at 60 seconds. A case document allows 270 seconds: 180 seconds for the maximum body, 20 seconds for admission, 60 seconds for teardown, and 10 seconds for report drain. The run allows 1,440 seconds for all four documents, list, finish, preparation, and margin.

Every original page evaluation is an owned host task. Its actual promise remains awaited inside that task. The restart evaluation starts before the second readiness call and settles only when the original restart promise settles. Results include actual snapshots, deadline mutations, and evaluation ordering. Failure diagnostics use the existing attachment sink before demo disposal.
