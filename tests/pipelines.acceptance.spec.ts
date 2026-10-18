import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

import { execFileSync } from "node:child_process";

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

test("pipeline forwards ticker lines while the producer is running", async ({ page }, info) => {
  await open(page);
  await command(page, "test-guest ticker 0 500 tick | grep tick");
  await output(page, "tick 0");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await output(page, "tick 1");
  await output(page, "tick 2");
  await page.screenshot({ path: info.outputPath("live-pipeline.png") });
  await page.keyboard.press("Control+c");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(page, "echo INTERRUPT:$?");
  await output(page, "INTERRUPT:130");
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

test("pipeline Ctrl+C stops every stage and its children", async ({ page }) => {
  await open(page);
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
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(page, "echo STATUS:$?:$KEEP");
  await output(page, "STATUS:130:kept");
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
    "Missing public bun-wasm API: installBunAdapters(runtime, { workerUrl }) and bun-wasm/worker with its matching verified guest artifact; no public launcher package is available yet and copied Bun host code is not shipped.",
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
    await output(page, `PIPE_DIAGNOSTIC:<${diagnostic}>`);
    await output(page, `START_STATUS:0:${code} 0`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

test("asynchronous start failure honors redirected and explicitly closed stderr", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    "test-start-failure 2>start-error; echo FILE_STATUS:$?; printf 'FILE_DIAGNOSTIC:<%s>\\n' \"$(cat start-error)\"; test-start-failure 2>&-; echo CLOSED_STATUS:$?; test-guest emit '' 1 126; echo EXIT_STATUS:$?; test-guest emit '' 1 127; echo REAL127:$?",
  );
  await output(page, "FILE_STATUS:126");
  await output(page, "FILE_DIAGNOSTIC:</usr/bin/bash: test-start-failure: Exec format error>");
  await output(page, "CLOSED_STATUS:126");
  await output(page, "EXIT_STATUS:126");
  await output(page, "REAL127:127");
  await ready(page);
  const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  expect(
    lines?.filter(
      (line) =>
        line.includes("/usr/bin/bash: test-start-failure: Exec format error") &&
        !line.includes("test-start-failure 2>"),
    ),
  ).toHaveLength(1);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});
