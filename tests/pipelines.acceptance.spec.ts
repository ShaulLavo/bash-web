import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

import { execFileSync } from "node:child_process";
import {
  capturePipelineFailure,
  createPipelineWorkerRetirementBaseline,
  installPipelineWorkerDiagnostics,
  type PipelineWorkerObservation,
  waitForPipelineWorkerRetirement,
} from "./helpers/pipeline-failure-diagnostics.ts";

// Upstream acceptance copied from /work/reports/browser-shell-research.
// Runtime owns a persistent filesystem worker as well as the guest shell.
const baselineWorkers = new WeakMap<Page, number>();

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas&engine=own-shell");
  await startupReady(page);
  expect(await page.evaluate(() => window.bashWeb?.snapshot().engine)).toBe("own-shell");
  baselineWorkers.set(page, page.workers().length);
  await page.locator("textarea").focus();
}
async function command(page: Page, text: string) {
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
}
async function output(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())))
    .toContain(text);
}
async function file(page: Page, path: string, source: string) {
  await command(page, `printf '%s' '${source.replaceAll("'", "'\\''")}' > ${path}`);
  await ready(page);
}

for (const [name, source, expected] of [
  [
    "external command capture preserves child status",
    `value=$(test-guest emit $'captured\\n\\n' 1 7); capture_status=$?; printf 'CAPTURE:<%s>:%s\\n' "$value" "$capture_status"`,
    "CAPTURE:<captured>:7",
  ],
  [
    "external process-substitution reader",
    `printf PROCESS:; test-guest cat < <(printf streamed); echo`,
    "PROCESS:streamed",
  ],
  ["external here-string reader", `test-guest bytes <<< reader`, "BYTES:114,101,97,100,101,114,10"],
]) {
  test(`substitution descriptors cross the real runtime boundary, ${name}`, async ({ page }) => {
    await open(page);
    await command(page, source);
    await output(page, expected);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
    await command(page, "echo SUBSTITUTION_STATUS:$?");
    await output(page, "SUBSTITUTION_STATUS:0");
  });
}

async function interruptResources(page: Page) {
  const runtime = await page.evaluate(() => {
    const snapshot = window.bashWeb!.runtimeSnapshot()!;
    return {
      filesystemWorkers: snapshot.filesystemWorkers,
      droppedTerminalBytes: snapshot.droppedTerminalBytes,
      terminal: snapshot.terminal,
      roots: snapshot.roots.map((root) => ({
        pid: root.pid,
        workers: root.workers,
        processes: root.processes,
        liveProcesses: root.liveProcesses,
        liveJobs: root.liveJobs,
        retainedSlots: root.retainedSlots,
        pipes: root.pipes,
        records: root.records,
      })),
    };
  });
  return { workers: page.workers().length, runtime };
}

async function tickerLines(page: Page) {
  return page.evaluate(() =>
    window.bashWeb!.readLines().filter((line) => /^CTRL_C_TICK \d+$/.test(line.trim())),
  );
}

async function pipelineWorkerObservation(page: Page): Promise<PipelineWorkerObservation> {
  const listedWorkers = page.workers().map((worker) => {
    const url = worker.url();
    const marker = "#bash-web-pipeline-worker=";
    const markerIndex = url.indexOf(marker);
    const name = markerIndex >= 0 ? decodeURIComponent(url.slice(markerIndex + marker.length)) : "";
    return { name, url };
  });
  const diagnostics = await page.evaluate(() => window.pipelineWorkerDiagnostics);
  return { listedWorkers, diagnostics };
}

test("pipeline Ctrl+C stops a real WASI ticker and reuses the shell without leaks or late output", async ({
  page,
}, info) => {
  await open(page);
  const before = await interruptResources(page);
  await command(
    page,
    "export KEEP=retained; test-guest ticker 0 250 CTRL_C_TICK | grep CTRL_C_TICK; echo BAD_AFTER_INTERRUPT",
  );
  await output(page, "CTRL_C_TICK 0");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await output(page, "CTRL_C_TICK 1");
  await output(page, "CTRL_C_TICK 2");
  const running = await interruptResources(page);
  expect(running.workers).toBe(before.workers + 2);
  expect(running.runtime.roots[0].liveProcesses).toBe(before.runtime.roots[0].liveProcesses + 2);
  expect(running.runtime.roots[0].pipes).toBeGreaterThan(before.runtime.roots[0].pipes);
  await page.screenshot({ path: info.outputPath("live-pipeline.png") });
  await page.keyboard.press("Control+c");
  await ready(page);
  const stoppedLines = await tickerLines(page);
  await expect.poll(() => interruptResources(page)).toEqual(before);
  const stopped = await interruptResources(page);
  const sleepStartedAt = performance.now();
  await command(
    page,
    `printf 'INTERRUPT:%s:%s\\n' "$?" "$KEEP"; test-guest sleep 750; echo SLEEP_STATUS:$?`,
  );
  await output(page, "INTERRUPT:130:retained");
  await output(page, "SLEEP_STATUS:0");
  const sleepElapsedMs = performance.now() - sleepStartedAt;
  expect(sleepElapsedMs).toBeGreaterThanOrEqual(750);
  await ready(page);
  expect(await tickerLines(page)).toEqual(stoppedLines);
  await command(page, `test-guest emit $'NEXT_CHILD_OK\\n' | test-guest cat; echo NEXT_STATUS:$?`);
  await output(page, "NEXT_CHILD_OK");
  await output(page, "NEXT_STATUS:0");
  await ready(page);
  await expect.poll(() => interruptResources(page)).toEqual(before);
  expect(await tickerLines(page)).toEqual(stoppedLines);
  expect(
    await page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AFTER_INTERRUPT");
  await info.attach("ctrl-c-runtime-evidence", {
    body: JSON.stringify({
      before,
      running,
      stopped,
      after: await interruptResources(page),
      stoppedLines,
      sleepElapsedMs,
    }),
    contentType: "application/json",
  });
});

for (const [name, producer, consumer, expected] of [
  ["builtin to external WASI guest", "seq 1 400000", "test-guest count", "COUNT:2688895:400001"],
  [
    "external WASI guest to builtin",
    "test-guest repeat-byte 120 2097169",
    "cat > complete; test-guest count complete",
    "COUNT:2097169:1",
  ],
  [
    "external WASI guest to external WASI guest",
    "test-guest pattern 8192 513 251",
    "test-guest check-pattern 8192 251",
    "COUNT:4202496:true",
  ],
  [
    "builtin to builtin",
    "seq 1 400000",
    "cat > complete; test-guest count complete",
    "COUNT:2688895:400001",
  ],
]) {
  test(`pipeline streams complete output above 1 MiB, ${name}`, async ({ page }) => {
    await open(page);
    await command(page, `${producer} | ${consumer}`);
    await output(page, expected);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

test("pipeline Ctrl+C stops every stage and its children", async ({ page }, info) => {
  await page.addInitScript(installPipelineWorkerDiagnostics);
  await capturePipelineFailure(
    async () => {
      await open(page);
      const baselineObservation = await pipelineWorkerObservation(page);
      pipelineWorkerBaselines.set(
        page,
        createPipelineWorkerRetirementBaseline(baselineObservation),
      );
      await command(
        page,
        // Keep concurrent protocol markers on the guest's single-write byte path.
        "export KEEP=kept; { test-guest emit $'PRODUCER_READY\\n' >&2; test-guest yes tick; } | { test-guest emit $'CONSUMER_READY\\n' >&2; test-guest cat; } | grep unmatched; echo BAD_AFTER_INTERRUPT",
      );
      await output(page, "PRODUCER_READY");
      await output(page, "CONSUMER_READY");
      await expect
        .poll(() => page.workers().length)
        .toBeGreaterThanOrEqual(baselineWorkers.get(page)! + 2);
      await page.keyboard.press("Control+c");
      await ready(page);
      await waitForPipelineWorkerRetirement(
        () => pipelineWorkerObservation(page),
        pipelineWorkerBaselines.get(page)!,
      );
      await command(page, "echo STATUS:$?:$KEEP");
      await output(page, "STATUS:130:kept");
    },
    async () => {
      const pageState = await page
        .evaluate(() => ({
          snapshot: window.bashWeb?.snapshot(),
          runtime: window.bashWeb?.runtimeSnapshot(),
          workers: window.pipelineWorkerDiagnostics,
        }))
        .catch((error: unknown) => ({ unavailable: String(error).slice(0, 512) }));
      const workerRetirement = await pipelineWorkerObservation(page).catch((error: unknown) => ({
        unavailable: String(error).slice(0, 512),
      }));
      const workers = page.workers();
      await info.attach("pipeline-failure-diagnostics", {
        body: JSON.stringify({
          baselineWorkers: baselineWorkers.get(page),
          workerRetirementBaseline: pipelineWorkerBaselines.get(page),
          workerRetirement,
          workerCount: workers.length,
          workerUrls: Array.from({ length: Math.min(workers.length, 64) }, (_, index) =>
            workers[index].url().slice(0, 512),
          ),
          page: pageState,
        }),
        contentType: "application/json",
      });
    },
  );
});

const statusCases = [
  "false | true",
  "true | false",
  "false | false | true",
  "set -o pipefail; false | true",
  "set -o pipefail; true | false | true",
  "set -o pipefail; (exit 7) | (exit 3) | true",
  "! false | true",
];
for (const pipeline of statusCases) {
  test(`pipeline status matches bash, ${pipeline}`, async ({ page }) => {
    const text = `${pipeline}; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`;
    const expected = execFileSync("bash", ["--noprofile", "--norc", "-c", text], {
      encoding: "utf8",
    }).trim();
    await open(page);
    await command(page, text);
    await output(page, expected);
    await ready(page);
  });
}

test("early downstream exit finishes a yielding Bun producer with EPIPE status", async ({
  page,
}) => {
  test.skip(
    true,
    "Public bun-wasm installer and worker exports exist; pending verification of an aligned Bun package, shared Waffle commit, and matching receipted guest; copied Bun host code is not shipped.",
  );
  await open(page);
  // Native Bun 1.4.2 and Node 26.7.0 ignore SIGPIPE: a tight write loop
  // never yields to its deferred EPIPE handler. A real ticker yields, then exits
  // 1 for unhandled EPIPE (not 141); the native fake producer covers SIGPIPE.
  await file(page, "endless.ts", 'setInterval(()=>process.stdout.write("first\\n"),1)');
  await command(
    page,
    `set -o pipefail; bun run endless.ts | { IFS= read -r line; echo "$line"; }; printf 'STATUS:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`,
  );
  await output(page, "first");
  await output(page, "STATUS:1:1 0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("pipeline stages inherit functions, unexported variables, cwd and redirections", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    "mkdir nested; cd nested; secret=retained; f() { printf '%s\\n' \"$secret:$PWD:$1\"; }; f value | cat > result; cat result",
  );
  await output(page, "retained:/home/guest/nested:value");
  await ready(page);
});

test("slow downstream applies bounded backpressure", async ({ page }) => {
  await open(page);
  await command(page, "test-guest produce 80 65536 97 | test-guest delayed-count 2000 DRAINED");
  await output(page, "READER_WAITING");
  await output(page, "WRITTEN:0");
  await page.waitForTimeout(200);
  const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  expect(lines).not.toContain("WRITTEN:79");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await output(page, "DRAINED:5242880:1");
  const completedLines = await page.evaluate(() =>
    window.bashWeb?.readLines().map((line) => line.trim()),
  );
  expect(completedLines).toEqual(
    expect.arrayContaining(Array.from({ length: 80 }, (_, index) => `WRITTEN:${index}`)),
  );
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

for (const mode of ["foreground", "background"]) {
  test(`successful startup releases stderr before ${mode} job EOF handshake`, async ({ page }) => {
    await open(page);
    await command(page, `test-guest eof-handshake ${mode}`);
    await output(page, "EOF_PAYLOAD");
    await output(page, "DOWNSTREAM_EOF_ACK");
    await output(page, mode === "foreground" ? "EOF_JOB:0:0 0" : "EOF_JOB:0");
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

for (const [name, code, diagnostic] of [
  ["nosuch", 127, "/usr/bin/bash: nosuch: command not found"],
  ["test-start-failure", 126, "/usr/bin/bash: test-start-failure: Exec format error"],
  ["test-lazy-start-failure", 126, "/usr/bin/bash: test-lazy-start-failure: Exec format error"],
] as const) {
  test(`failed startup delivers redirected diagnostic before pipe EOF, ${name}`, async ({
    page,
  }) => {
    await open(page);
    await command(
      page,
      name +
        ' 2>&1 | test-guest cat >start-pipe; printf \'START_STATUS:%s:%s\\n\' "$?" "${PIPESTATUS[*]}"; printf \'PIPE_DIAGNOSTIC:<%s>\\n\' "$(cat start-pipe)"',
    );
    // Require the complete redirected diagnostic: runtime details or a stack are extra bytes.
    await output(page, `PIPE_DIAGNOSTIC:<${diagnostic}>`);
    await output(page, `START_STATUS:0:${code} 0`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

for (const name of ["test-start-failure", "test-lazy-start-failure"]) {
  test(`asynchronous start failure honors redirected and explicitly closed stderr, ${name}`, async ({
    page,
  }) => {
    await open(page);
    await command(
      page,
      `${name} 2>start-error; echo FILE_STATUS:$?; printf 'FILE_DIAGNOSTIC:<%s>\\n' "$(cat start-error)"; ${name} 2>&-; echo CLOSED_STATUS:$?; test-guest emit '' 1 126; echo EXIT_STATUS:$?; test-guest emit '' 1 127; echo REAL127:$?`,
    );
    await output(page, "FILE_STATUS:126");
    await output(page, `FILE_DIAGNOSTIC:</usr/bin/bash: ${name}: Exec format error>`);
    await output(page, "CLOSED_STATUS:126");
    await output(page, "EXIT_STATUS:126");
    await output(page, "REAL127:127");
    await ready(page);
    const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
    expect(
      lines?.filter(
        (line) =>
          line.includes(`/usr/bin/bash: ${name}: Exec format error`) &&
          !line.includes(`${name} 2>`),
      ),
    ).toHaveLength(1);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

const pipelineWorkerBaselines = new WeakMap<
  Page,
  ReturnType<typeof createPipelineWorkerRetirementBaseline>
>();
