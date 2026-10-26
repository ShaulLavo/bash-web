import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

const baselineWorkers = new WeakMap<Page, number>();

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
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

test("external WASI guest streams before exit", async ({ page }) => {
  await open(page);
  await command(page, "test-guest ticker 2 2000 STREAM");
  await output(page, "STREAM 0");
  expect(await page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  expect(
    await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("STREAM 1");
  await output(page, "STREAM 1");
  await ready(page);
});

test("external bun executes through normal command lookup", async ({ page }) => {
  test.skip(
    true,
    "Public bun-wasm installer and worker exports exist; pending verification of an aligned Bun package, shared Waffle commit, and matching receipted guest; this case exercises the real Bun executable, not the generic WASI guest.",
  );
  await open(page);
  await command(page, `bun -e 'console.log("EXTERNAL_OK")'`);
  await output(page, "EXTERNAL_OK");
  await ready(page);
});

test("printf octal escapes produce exact bytes for an external guest", async ({ page }) => {
  await open(page);
  await command(page, `printf 'hi\\000\\377\\r\\n' | test-guest bytes`);
  await output(page, "BYTES:104,105,0,255,13,10");
  await ready(page);
});

test("echo options and escapes preserve exact bytes for an external guest", async ({ page }) => {
  await open(page);
  await command(page, `echo -e 'hi\\000\\0377\\r\\n\\cdiscarded' later | test-guest bytes`);
  await output(page, "BYTES:104,105,0,255,13,10");
  await ready(page);
  await command(page, `echo -neE 'a\\nb' | test-guest bytes`);
  await output(page, "BYTES:97,92,110,98");
  await ready(page);
});

test("read character counts preserve Unicode and unread pipe bytes", async ({ page }) => {
  await open(page);
  await command(
    page,
    `test-guest emit-bytes 195,169,228,184,173,120,10 | { LC_ALL=C.UTF-8 read -n2 x; printf '%s' "$x" | test-guest bytes; read -r; printf '%s' "$REPLY" | test-guest bytes; }`,
  );
  await output(page, "BYTES:195,169,228,184,173");
  await output(page, "BYTES:120");
  await ready(page);
});

test("external pipes preserve binary bytes, EOF, and backpressure in both directions", async ({
  page,
}) => {
  await open(page);
  await command(
    page,
    "test-guest emit-bytes 0,255,13,10,97 | cat > binary; cat binary | test-guest bytes",
  );
  await output(page, "BYTES:0,255,13,10,97");
  await ready(page);
  await command(page, `test-guest emit $'foo\\nbar\\nfoo two\\n' | grep foo`);
  await output(page, "foo");
  await output(page, "foo two");
  await ready(page);
  await command(page, "test-guest pattern 8192 23 251 | test-guest check-pattern 8192 251");
  await output(page, "COUNT:188416:true");
  await ready(page);
});

test("command builtin launches a registered external WASI guest", async ({ page }) => {
  await open(page);
  await command(page, `command /bin/test-guest emit $'COMMAND_OK\\n'`);
  await output(page, "COMMAND_OK");
  await ready(page);
});

test("external status controls lists and pipelines", async ({ page }) => {
  await open(page);
  await command(
    page,
    "test-guest exit 7; echo STATUS:$?; test-guest exit 7 && echo BAD_AND; test-guest exit 7 || echo OR_OK",
  );
  await output(page, "STATUS:7");
  await output(page, "OR_OK");
  expect(
    await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AND");
  await ready(page);
  await command(page, "set -o pipefail; echo hi | test-guest exit 7; echo PIPE_STATUS:$?");
  await output(page, "PIPE_STATUS:7");
});

test("Ctrl+C interrupts instrumented external WASM with status 130 and preserves the shell", async ({
  page,
}) => {
  await open(page);
  await command(page, "export KEEP=retained; test-spin CHILD_STARTED; echo BAD_AFTER_INTERRUPT");
  await output(page, "CHILD_STARTED");
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page)! + 1);
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, `echo INTERRUPT:$?:$KEEP; test-guest emit $'NEXT_CHILD_OK\\n'`);
  await output(page, "INTERRUPT:130:retained");
  await output(page, "NEXT_CHILD_OK");
  expect(
    await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AFTER_INTERRUPT");
  await ready(page);
});

test("child files are shared after nonzero exit, with cwd and exported environment", async ({
  page,
}) => {
  test.skip(
    true,
    "Public bun-wasm installer and worker exports exist; pending verification of an aligned Bun package, shared Waffle commit, and matching receipted guest; this case verifies Bun's Node filesystem APIs and process context.",
  );
  await open(page);
  await command(
    page,
    "mkdir demo; cd demo; export TEST_VALUE=from-shell; printf source > input; printf remove > deleted",
  );
  await ready(page);
  await command(
    page,
    `bun -e 'const fs=require("node:fs"); console.log("CONTEXT:"+process.cwd()+":"+process.env.TEST_VALUE); fs.writeFileSync("output", fs.readFileSync("input")); fs.unlinkSync("deleted"); fs.mkdirSync("nested"); fs.writeFileSync("nested/new", "created"); process.exit(9)' > captured; echo FILE_STATUS:$?; cat captured; cat output; echo; cat nested/new; echo; bun -e 'if(!require("node:fs").existsSync("deleted"))console.log("DELETE_OK")'`,
  );
  await output(page, "FILE_STATUS:9");
  await output(page, "CONTEXT:/home/guest/demo:from-shell");
  await output(page, "source");
  await output(page, "created");
  await output(page, "DELETE_OK");
  await ready(page);
  await command(
    page,
    `printf appended >> output; bun -e 'console.log("MERGED:"+require("node:fs").readFileSync("output","utf8"))'`,
  );
  await output(page, "MERGED:sourceappended");
});

test("external terminal stdin receives a raw input line", async ({ page }) => {
  await open(page);
  await command(page, "test-guest read-line INPUT: INPUT_READY");
  await output(page, "INPUT_READY");
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page)! + 1);
  await command(page, "typed line");
  await output(page, "INPUT:typed line");
  await ready(page);
});

test("unregistered files fail with 126 and leave the command host usable", async ({ page }) => {
  await open(page);
  await command(
    page,
    `printf invalid > fake; ./fake; echo UNREGISTERED:$?; test-guest emit $'AFTER_ERROR_OK\\n'`,
  );
  await output(page, "UNREGISTERED:126");
  await output(page, "AFTER_ERROR_OK");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("PATH skips non-runnable candidates and resolves cwd components", async ({ page }) => {
  await open(page);
  await command(page, "printf unregistered > /home/guest/test-guest; mkdir /tmp/test-guest");
  await ready(page);
  for (const [label, cwd, path] of [
    ["SKIPPED", "/home/guest", "/missing:/home/guest:/tmp:/bin"],
    ["RELATIVE", "/programs", "../bin"],
    ["LEADING_EMPTY", "/bin", ":/missing"],
    ["TRAILING_EMPTY", "/bin", "/missing:"],
    ["EMPTY", "/bin", ""],
  ]) {
    await command(
      page,
      `cd ${cwd}; export PATH='${path}'; test-guest emit $'PATH_${label}\\n'; echo PATH_STATUS_${label}:$?`,
    );
    await output(page, `PATH_${label}`);
    await output(page, `PATH_STATUS_${label}:0`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  }
});

test("command queries share live PATH lookup without launching a guest", async ({ page }) => {
  await open(page);
  await command(
    page,
    "printf unregistered > /home/guest/test-guest; mkdir /tmp/test-guest; test -d /tmp/test-guest; echo QUERY_FIXTURE:$?",
  );
  await output(page, "QUERY_FIXTURE:0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  let queryWorkers = 0;
  const countQueryWorker = () => queryWorkers++;
  page.on("worker", countQueryWorker);
  await command(
    page,
    "export PATH=/missing:/home/guest:/tmp:/bin; command -v test-guest; echo QUERY:$?; command -V test-guest; echo VERBOSE:$?",
  );
  await output(page, "/bin/test-guest");
  await output(page, "test-guest is /bin/test-guest");
  await output(page, "QUERY:0");
  await output(page, "VERBOSE:0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(
    page,
    "cd /programs; export PATH=../bin; command -v test-guest; command -V test-guest; export PATH=/missing; command -v test-guest; echo MISSING_QUERY:$?; command -V test-guest; echo MISSING_VERBOSE:$?",
  );
  await output(page, "../bin/test-guest");
  await output(page, "test-guest is /programs/../bin/test-guest");
  await output(page, "MISSING_QUERY:1");
  await output(page, "MISSING_VERBOSE:1");
  await ready(page);
  expect(queryWorkers).toBe(0);
  page.off("worker", countQueryWorker);
  await command(
    page,
    "/bin/test-guest unlink /bin/test-guest; export PATH=/bin; command -v test-guest; echo DELETED_QUERY:$?; command -V test-guest; echo DELETED_VERBOSE:$?",
  );
  await output(page, "DELETED_QUERY:1");
  await output(page, "DELETED_VERBOSE:1");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("PATH preserves denied versus missing status without executing rejected files", async ({
  page,
}) => {
  await open(page);
  await command(page, "printf unregistered > /home/guest/test-guest; mkdir /tmp/test-guest");
  await ready(page);
  for (const [label, path, status] of [
    ["FILE", "/home/guest:/missing", 126],
    // Bash ignores directories while searching PATH; an explicit directory is 126 below.
    ["DIRECTORY", "/tmp:/missing", 127],
    ["MISSING", "/missing", 127],
  ]) {
    await command(
      page,
      `export PATH='${path}'; test-guest emit $'REJECTED_RAN\\n'; echo PATH_${label}:$?`,
    );
    await output(page, `PATH_${label}:${status}`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  }
  expect(
    await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("REJECTED_RAN");
  await command(page, "export PATH=/bin; test-guest emit $'PATH_RECOVERED\\n'");
  await output(page, "PATH_RECOVERED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("an executable file cannot be traversed as a directory", async ({ page }) => {
  await open(page);
  await command(
    page,
    "/bin/test-guest/../test-guest emit $'NOTDIR_RAN\\n'; echo NOTDIR:$?; /bin/test-guest/ emit $'TRAILING_RAN\\n'; echo TRAILING:$?",
  );
  await output(page, "NOTDIR:126");
  await output(page, "TRAILING:126");
  const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  expect(lines).not.toContain("NOTDIR_RAN");
  expect(lines).not.toContain("TRAILING_RAN");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("session restart terminates a running child worker", async ({ page }) => {
  await open(page);
  await command(page, "test-spin RESTART_CHILD");
  await output(page, "RESTART_CHILD");
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page)! + 1);
  await page.evaluate(() => {
    void window.bashWeb?.restart();
  });
  await startupReady(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await page.locator("textarea").focus();
  await command(page, `test-guest emit $'RESTART_OK\\n'`);
  await output(page, "RESTART_OK");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

test("redirected stdout and stderr retain the child's write order", async ({ page }) => {
  await open(page);
  await command(page, "test-guest write-order 3 > ordered 2>&1; cat ordered");
  await output(page, "ERR:2");
  const writes = await page.evaluate(() =>
    window
      .bashWeb!.readLines()
      .map((line) => line.trim())
      .filter((line) => /^(OUT|ERR):[0-2]$/.test(line)),
  );
  expect(writes).toEqual(["OUT:0", "ERR:0", "OUT:1", "ERR:1", "OUT:2", "ERR:2"]);
  await ready(page);
});

test("child stdio preserves pipe rather than terminal device types", async ({ page }) => {
  await open(page);
  await command(page, "printf x | test-guest fd-types 2>err | cat");
  await output(page, "STDIOTTY:0:0:0");
  await ready(page);
});

for (const [label, setup, executable] of [
  ["relative", "cd /bin", "./test-guest"],
  ["dot segments", "cd /home/guest", "/bin/../bin/./test-guest"],
  ["root parent", "cd /home/guest", "/../../bin/test-guest"],
]) {
  test(`external executable lookup resolves ${label}`, async ({ page }) => {
    await open(page);
    await command(page, `${setup}; ${executable} emit $'RESOLVED_OK\\n'; echo LOOKUP:$?`);
    await output(page, "RESOLVED_OK");
    await output(page, "LOOKUP:0");
    await ready(page);
  });
}

for (const [label, setup, executable] of [
  ["missing relative", "cd /bin", "./missing"],
  ["missing intermediate before parent", "cd /bin", "/missing/../bin/test-guest"],
  ["deleted registered", "test-guest unlink /bin/test-guest", "/bin/test-guest"],
]) {
  test(`external executable lookup rejects ${label} files`, async ({ page }) => {
    await open(page);
    await command(page, `${setup}; ${executable} emit $'DELETED_RAN\\n'; echo MISSING:$?`);
    await output(page, "MISSING:127");
    expect(
      await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())),
    ).not.toContain("DELETED_RAN");
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

test("external zero-length stdin read finishes without input or EOF", async ({ page }) => {
  await open(page);
  await command(page, "test-guest zero-read");
  await output(page, "ZERO_READ:0");
  await ready(page);
});

test("normal child exit hands raw terminal input back before the next child", async ({
  page,
}, testInfo) => {
  await open(page);
  await command(page, "export HANDOFF=retained; test-guest read-exact 5 PARTIAL: TYPE_NOW");
  await output(page, "TYPE_NOW");
  // Raw input has no canonical line buffer: the guest consumes the unfinished line.
  await page.keyboard.insertText("stale");
  await output(page, "PARTIAL:stale");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(page, "echo HANDOFF:$HANDOFF; test-guest read-line INPUT: NEXT_READY");
  await output(page, "HANDOFF:retained");
  await output(page, "NEXT_READY");
  await command(page, "fresh");
  await output(page, "INPUT:fresh");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  await command(page, "echo NORMAL_EXIT_SHELL_OK");
  await output(page, "NORMAL_EXIT_SHELL_OK");
  await page.screenshot({ path: testInfo.outputPath("normal-exit-handoff.png") });
});

test("registered executable paths must still name regular files", async ({ page }) => {
  await open(page);
  await command(
    page,
    "test-guest unlink /bin/test-guest; mkdir /bin/test-guest; /bin/test-guest emit $'DIRECTORY_RAN\\n'; echo DIRECTORY:$?",
  );
  await output(page, "DIRECTORY:126");
  expect(
    await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim())),
  ).not.toContain("DIRECTORY_RAN");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
});

for (const [name, script, expected, status] of [
  ["default stdin", "printf 'one two\\nthree\\n' | wc", "2       3      14", 0],
  ["lines", "printf 'one two\\nthree\\n' | wc -l", "2", 0],
  ["words", "printf 'one two\\nthree\\n' | wc -w", "3", 0],
  ["bytes", "printf 'one two\\nthree\\n' | wc -c", "14", 0],
  ["binary bytes", "printf '\\377\\000a b\\n' | wc -c", "6", 0],
  ["pipeline", "printf 'one two\\nthree\\n' | cat | wc -c", "14", 0],
] as const) {
  test(`wc runs in Chromium with ${name}`, async ({ page }) => {
    await open(page);
    await command(page, `${script}; printf 'WC_STATUS:%s\\n' "$?"`);
    await output(page, expected);
    await output(page, `WC_STATUS:${status}`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baselineWorkers.get(page));
  });
}

test("wc reads files and reports totals in Chromium", async ({ page }) => {
  await open(page);
  await command(page, "printf 'a b\\n' > one; printf 'x\\ny z\\n' > two; wc one two");
  await output(page, "1  2  4 one");
  await output(page, "2  3  6 two");
  await output(page, "3  5 10 total");
  await ready(page);
});

test("wc returns file and option errors without stopping the browser shell", async ({ page }) => {
  await open(page);
  await command(page, "wc missing; printf 'MISSING:%s\\n' \"$?\"");
  await output(page, "MISSING:1");
  await ready(page);
  await command(page, "wc --not-an-option; printf 'INVALID:%s\\n' \"$?\"");
  await output(page, "INVALID:1");
  await ready(page);
  await command(page, "printf 'one two\\n' | wc -w");
  await output(page, "2");
  await ready(page);
});

test("wc bounds memory on sustained input and stops on Ctrl+C", async ({ page }, info) => {
  await open(page);
  const baseline = baselineWorkers.get(page)!;
  const before = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!);
  await command(page, "export KEEP=retained; while printf x; do :; done | wc; echo BAD_AFTER");
  await expect.poll(() => page.workers().length).toBe(baseline + 1);
  await page.waitForTimeout(100);
  const memory: number[] = [];
  for (let sample = 0; sample < 8; sample++) {
    const guests = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].guests);
    expect(guests).toHaveLength(1);
    expect(guests[0].memoryBytes).toBeGreaterThan(0);
    memory.push(guests[0].memoryBytes);
    await page.waitForTimeout(25);
  }
  expect(Math.max(...memory)).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(Math.max(...memory) - Math.min(...memory)).toBeLessThanOrEqual(8 * 1024 * 1024);
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, 'printf \'INTERRUPT:%s:%s\\n\' "$?" "$KEEP"');
  await output(page, "INTERRUPT:130:retained");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
  expect(
    await page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim())),
  ).not.toContain("BAD_AFTER");
  await info.attach("wc-sustained-input-memory", {
    body: JSON.stringify({
      memory,
      before: before.roots[0].memoryBytes,
      after: await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].memoryBytes),
    }),
    contentType: "application/json",
  });
});
