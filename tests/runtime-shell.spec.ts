import { test, expect, type Page } from "./helpers/browser-test";
import { ready, startupReady } from "./helpers/readiness.ts";

test.setTimeout(60000);

async function open(page: Page) {
  await page.goto("/?test=1&renderer=canvas&engine=own-shell");
  await startupReady(page);
  expect(await page.evaluate(() => window.bashWeb?.snapshot().engine)).toBe("own-shell");
  await page.locator("textarea").focus();
  return page.workers().length;
}
async function command(page: Page, source: string) {
  await page.keyboard.insertText(source);
  await page.keyboard.press("Enter");
}
async function output(page: Page, expected: string, afterPrompt = false) {
  await expect
    .poll(() =>
      page.evaluate(
        (allowPrompt) =>
          window.bashWeb?.readLines().map((line) => {
            const text = line.trim();
            // Bash allows a background job to print after the waiting prompt.
            // Only strip that exact prefix, never match the echoed command source.
            return allowPrompt ? text.replace(/^\$ /, "") : text;
          }),
        afterPrompt,
      ),
    )
    .toContain(expected);
}
async function file(page: Page, path: string, source: string) {
  await command(page, `printf '%s' '${source.replaceAll("'", "'\\''")}' > ${path}`);
  await ready(page);
}

test("own shell is the default engine", async ({ page }) => {
  await page.goto("/?test=1&renderer=canvas");
  await startupReady(page);
  expect(await page.evaluate(() => window.bashWeb?.snapshot().engine)).toBe("own-shell");
});

test("missing runtime devices fail rather than creating a fake /dev/null file", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(
    page,
    `printf secret >/dev/null; printf 'NULL_WRITE_STATUS:%s\\n' "$?"; cat /dev/null; printf 'NULL_READ_STATUS:%s\\n' "$?"`,
  );
  await output(page, "NULL_WRITE_STATUS:1");
  await output(page, "NULL_READ_STATUS:1");
  await ready(page);
  const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  expect(lines).not.toContain("secret");
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("an always-ready background shell loop cannot starve a foreground command", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(page, "while :; do :; done & echo FOREGROUND_FAIR");
  await output(page, "FOREGROUND_FAIR");
  await ready(page);
  await command(page, "kill %1; wait; echo BACKGROUND_REAPED");
  await output(page, "BACKGROUND_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("Ctrl+C interrupts executing shell WASM without killing an independent background WASI guest", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(page, "test-guest ticker 0 250 BACKGROUND &");
  await output(page, "BACKGROUND 0", true);
  await ready(page);
  await command(page, "while :; do :; done");
  await expect.poll(() => page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
  await page.keyboard.press("Control+c");
  await ready(page);
  await command(page, "echo CPU_STATUS:$?");
  await output(page, "CPU_STATUS:130");
  // Background child remains live until the job is explicitly killed from the next command.
  expect(page.workers().length).toBeGreaterThan(baseline);
  await command(page, "kill %1; wait; echo CPU_BACKGROUND_REAPED");
  await output(page, "CPU_BACKGROUND_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("nonstandard inherited descriptors share file offsets and redirected stdout", async ({
  page,
}) => {
  test.fixme(
    true,
    "External Bun guest payload is not rebuilt here; it must link Waffle's patched libc preopen scanner before inherited-descriptor filesystem coverage can run.",
  );
  await open(page);
  await file(page, "descriptor-data", "shared-offset");
  await command(
    page,
    `exec 4< descriptor-data; bun -e 'const f=require("node:fs");const b=Buffer.alloc(6);f.readSync(4,b,0,6,null);f.writeSync(3,"FD3:"+b.toString()+"\\n")' 3>&1; bun -e 'console.log("FD4:"+require("node:fs").readFileSync(4,"utf8"))'`,
  );
  await output(page, "FD3:shared");
  await output(page, "FD4:-offset");
  await ready(page);
});

test("an inherited fd 3 does not replace the filesystem root preopen", async ({ page }) => {
  test.fixme(
    true,
    "External Bun guest payload is not rebuilt here; it must link Waffle's patched libc preopen scanner before inherited-descriptor filesystem coverage can run.",
  );
  await open(page);
  await file(page, "preopen-data", "ROOT_PREOPEN_OK");
  await command(page, `bun -e 'console.log(await Bun.file("preopen-data").text())' 3>&1`);
  await output(page, "ROOT_PREOPEN_OK");
  await ready(page);
});

// These are rebuilt here with Waffle's patched libc. The unrelated external Bun
// guest above is not built by this repository and must not stand in for coverage.
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Each child is a separately instantiated WASI shell. These are transported
// RuntimeEndpoint descriptors, not the native engine's in-memory pipe fixture.
const descriptorForms = [
  { name: "test", predicate: (value: string) => `test ${value}` },
  { name: "bracket", predicate: (value: string) => `[ ${value} ]` },
  { name: "conditional", predicate: (value: string) => `[[ ${value} ]]` },
];

for (const form of descriptorForms) {
  test(`descriptor kinds survive transported pipes, ${form.name}`, async ({ page }) => {
    const baseline = await open(page);
    const read = [
      `${form.predicate("-p /dev/stdin")}; echo READ_STDIN:$?`,
      `${form.predicate("-p /dev/fd/0")}; echo READ_FD:$?`,
      `exec 3<&0; exec 0<&-`,
      `${form.predicate("-p /dev/fd/3")}; echo READ_REMAP:$?`,
      `${form.predicate("-t 3")}; echo READ_TTY:$?`,
      `cat <&3; exec 3<&-`,
      `${form.predicate("-p /dev/fd/3")}; echo READ_CLOSED:$?`,
    ].join("; ");
    const write = [
      `${form.predicate("-p /dev/stdout")}; echo WRITE_STDOUT:$? >&2`,
      `${form.predicate("-p /dev/fd/1")}; echo WRITE_FD:$? >&2`,
      `exec 3>&1; exec 1>&-`,
      `${form.predicate("-p /dev/fd/3")}; echo WRITE_REMAP:$? >&2`,
      `${form.predicate("-t 3")}; echo WRITE_TTY:$? >&2`,
      `printf 'PIPE_PAYLOAD\\n' >&3; exec 3>&-`,
      `${form.predicate("-p /dev/fd/3")}; echo WRITE_CLOSED:$? >&2`,
    ].join("; ");
    await command(
      page,
      `printf 'PIPE_PAYLOAD\\n' | /programs/shell-engine.wasm -c ${shellQuote(read)}; /programs/shell-engine.wasm -c ${shellQuote(write)} | cat; echo DESCRIPTOR_DONE:$?`,
    );
    for (const marker of [
      "READ_STDIN:0",
      "READ_FD:0",
      "READ_REMAP:0",
      "READ_TTY:1",
      "READ_CLOSED:1",
      "WRITE_STDOUT:0",
      "WRITE_FD:0",
      "WRITE_REMAP:0",
      "WRITE_TTY:1",
      "WRITE_CLOSED:1",
      "DESCRIPTOR_DONE:0",
    ]) {
      await output(page, marker);
    }
    await ready(page);
    const lines = await page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim()));
    expect(lines.filter((line) => line === "PIPE_PAYLOAD")).toHaveLength(2);
    await expect.poll(() => page.workers().length).toBe(baseline);
    await expect
      .poll(() => page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].pipes))
      .toBe(0);
  });
}

test("descriptor kinds distinguish actual runtime terminals, files and invalid handles", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(
    page,
    `test-guest fd-kinds 0 1 2 99; printf 'RAW_PAYLOAD\\n' | { test-guest fd-kinds 0 3 3<&0; cat; }; { test-guest fd-kinds 1 3 3>&1; printf 'RAW_PAYLOAD\\n'; } | cat; : > descriptor-file; test-guest fd-kinds 3 3< descriptor-file; test-guest fd-kinds 3 3< .`,
  );
  for (const marker of [
    "FD_KIND:0:2",
    "FD_KIND:1:2",
    "FD_KIND:2:2",
    "FD_KIND:99:-8",
    "FD_KIND:0:1",
    "FD_KIND:1:1",
    "FD_KIND:3:1",
    "FD_KIND:3:3",
    "FD_KIND:3:4",
  ]) {
    await output(page, marker);
  }
  await ready(page);
  const rawLines = await page.evaluate(() =>
    window.bashWeb!.readLines().map((line) => line.trim()),
  );
  expect(rawLines.filter((line) => line === "RAW_PAYLOAD")).toHaveLength(2);
  const predicates = descriptorForms.flatMap((form) => [
    `${form.predicate("-p /dev/stdin")}; echo ${form.name}_TERMINAL_PIPE:$?`,
    `${form.predicate("-t 0")}; echo ${form.name}_TERMINAL_TTY:$?`,
    `${form.predicate("-p /dev/fd/3")} 3< descriptor-file; echo ${form.name}_FILE_PIPE:$?`,
    `${form.predicate("-t 3")} 3< descriptor-file; echo ${form.name}_FILE_TTY:$?`,
    `${form.predicate("-t 99")}; echo ${form.name}_CLOSED_TTY:$?`,
    `${form.predicate("-p /dev/fd/3")} 3< .; echo ${form.name}_DIRECTORY_PIPE:$?`,
    `${form.predicate("-t 3")} 3< .; echo ${form.name}_DIRECTORY_TTY:$?`,
  ]);
  await command(
    page,
    `/programs/shell-engine.wasm -c ${shellQuote(predicates.join("; "))}; rm descriptor-file`,
  );
  for (const form of descriptorForms) {
    for (const suffix of [
      "TERMINAL_PIPE:1",
      "TERMINAL_TTY:0",
      "FILE_PIPE:1",
      "FILE_TTY:1",
      "CLOSED_TTY:1",
      "DIRECTORY_PIPE:1",
      "DIRECTORY_TTY:1",
    ]) {
      await output(page, `${form.name}_${suffix}`);
    }
  }
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].pipes))
    .toBe(0);
});

test("terminal operand errors keep Bash conditional status and short circuiting", async ({
  page,
}) => {
  const baseline = await open(page);
  const source = [
    "test -t '-0'; echo SIGNED_TTY:$?",
    "[ -t ' +00 ' ]; echo PADDED_TTY:$?",
    "[[ -t 4294967296 ]]; echo WIDE_FD:$?",
    "test ! -t nope; echo TEST_ERROR:$?",
    "[ ! -t nope ]; echo BRACKET_ERROR:$?",
    "[[ -t nope ]]; echo CONDITIONAL_ERROR:$?",
    "[[ ! -t nope ]]; echo NOT_ERROR:$?",
    "[[ -t nope || yes ]]; echo OR_ERROR:$?",
    "[[ -t nope && yes ]]; echo AND_ERROR:$?",
    "[[ yes || -t skipped ]]; echo SKIPPED_ERROR:$?",
    "test -t 9223372036854775808; echo OVERFLOW_ERROR:$?",
  ].join("; ");
  await command(page, `/programs/shell-engine.wasm -c ${shellQuote(source)}`);
  for (const marker of [
    "SIGNED_TTY:0",
    "PADDED_TTY:0",
    "WIDE_FD:1",
    "TEST_ERROR:2",
    "BRACKET_ERROR:2",
    "CONDITIONAL_ERROR:2",
    "NOT_ERROR:0",
    "OR_ERROR:0",
    "AND_ERROR:2",
    "SKIPPED_ERROR:0",
    "OVERFLOW_ERROR:2",
  ]) {
    await output(page, marker);
  }
  await ready(page);
  const lines = await page.evaluate(() => window.bashWeb!.readLines().map((line) => line.trim()));
  expect(lines.filter((line) => line === "/usr/bin/bash: [[: nope: integer expected")).toHaveLength(
    4,
  );
  expect(lines).toContain("/usr/bin/bash: test: nope: integer expected");
  expect(lines).toContain("/usr/bin/bash: [: nope: integer expected");
  expect(lines.some((line) => line.includes("skipped: integer expected"))).toBe(false);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

const preopenGuests = ["shell-engine", "test-guest", "test-spin"] as const;
const preopenLayouts = [
  { name: "persistent fd 3", extraFds: [], nested: false },
  { name: "fd 3 and sparse bindings 10–12", extraFds: [10, 11, 12], nested: false },
  { name: "all bindings 3–9", extraFds: [4, 5, 6, 7, 8, 9], nested: false },
  { name: "nested shell inheritance", extraFds: [], nested: true },
];

function preopenInvocation(
  guest: (typeof preopenGuests)[number],
  marker: string,
  extraFds: readonly number[],
  inputBinding = false,
) {
  if (guest !== "shell-engine") {
    const mode = inputBinding ? "preopen-input" : "preopen-probe";
    return `/bin/${guest} ${mode} /preopen-input /preopen-result ${marker} ${extraFds.join(" ")}`;
  }
  // Exercise the built shell through its existing absolute-path filesystem
  // operations, not a new engine probe or an adapter-side preopen lookup.
  const operations = [
    "IFS= read -r value </preopen-input",
    'test "$value" = ROOT_PREOPEN_DATA',
    `printf '${marker}:FILESYSTEM\\n' >/preopen-result`,
    "IFS= read -r value </preopen-result",
    `test "$value" = ${marker}:FILESYSTEM`,
  ];
  if (inputBinding) {
    operations.push(
      "IFS= read -r value <&3",
      'test "$value" = ROOT_PREOPEN_DATA',
      `printf '${marker}:FD3_INPUT\\n'`,
    );
  } else {
    operations.push(`printf '${marker}:FD3\\n' >&3`);
    for (const fd of extraFds) operations.push(`printf '${marker}:FD${fd}\\n' >&${fd}`);
  }
  return `/programs/shell-engine.wasm -c ${shellQuote(operations.join(" && "))}`;
}

for (const guest of preopenGuests) {
  for (const layout of preopenLayouts) {
    test(`${guest} keeps filesystem access and literal fd 3 with ${layout.name}`, async ({
      page,
    }) => {
      const baseline = await open(page);
      const marker = `PREOPEN_${guest.replaceAll("-", "_")}`;
      await command(page, "printf 'ROOT_PREOPEN_DATA\\n' >/preopen-input; exec 3>/preopen-fd");
      await ready(page);
      let invocation = preopenInvocation(guest, marker, layout.extraFds);
      if (layout.nested) invocation = `/programs/shell-engine.wasm -c ${shellQuote(invocation)}`;
      const bindings = layout.extraFds.map((fd) => `${fd}>&3`).join(" ");
      await command(page, `${invocation} ${bindings}; printf 'PREOPEN_STATUS:%s\\n' "$?"`);
      await output(page, "PREOPEN_STATUS:0");
      await ready(page);
      await command(page, "cat /preopen-result; cat /preopen-fd; exec 3>&-");
      await output(page, `${marker}:FILESYSTEM`);
      await output(page, `${marker}:FD3`);
      for (const fd of layout.extraFds) await output(page, `${marker}:FD${fd}`);
      await ready(page);
      await expect.poll(() => page.workers().length).toBe(baseline);
    });
  }

  test(`${guest} discovers the filesystem root with cmd 3<&0`, async ({ page }) => {
    const baseline = await open(page);
    const marker = `PREOPEN_INPUT_${guest.replaceAll("-", "_")}`;
    await command(page, "printf 'ROOT_PREOPEN_DATA\\n' >/preopen-input");
    await ready(page);
    const invocation = preopenInvocation(guest, marker, [], true);
    await command(
      page,
      `${invocation} </preopen-input 3<&0; printf 'PREOPEN_INPUT_STATUS:%s\\n' "$?"`,
    );
    await output(page, `${marker}:FD3_INPUT`);
    await output(page, "PREOPEN_INPUT_STATUS:0");
    await ready(page);
    await command(page, "cat /preopen-result");
    await output(page, `${marker}:FILESYSTEM`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baseline);
  });
}

test("builtins and runtime shell children preserve arbitrary descriptors and the root preopen", async ({
  page,
}) => {
  const baseline = await open(page);
  await file(page, "direct-descriptor-data", "shared-offset");
  await command(page, `printf 'BUILTIN_FD3:%s\\n' shared 3>&1 >&3`);
  await output(page, "BUILTIN_FD3:shared");
  await ready(page);
  await command(
    page,
    `exec 4< direct-descriptor-data; /programs/shell-engine.wasm -c 'read -r -u 4 value; printf "DIRECT_FD3:%s\\n" "$value" >&3' 3>&1`,
  );
  await output(page, "DIRECT_FD3:shared-offset");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("the registered shell program can run as a child without owning the root terminal", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(page, `/programs/shell-engine.wasm -c 'echo CHILD_SHELL_OK'`);
  await output(page, "CHILD_SHELL_OK");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

for (const scenario of [
  {
    name: "closed stderr",
    source: 'printf "CLOSED_STDERR_OK\\n"',
    redirections: "2>&-",
    marker: "CLOSED_STDERR_OK",
    status: 0,
  },
  {
    name: "closed stdin",
    source: 'printf "CLOSED_STDIN_OK\\n"',
    redirections: "0<&-",
    marker: "CLOSED_STDIN_OK",
    status: 0,
  },
  { name: "unused closed stdout", source: ":", redirections: "1>&-", status: 0 },
  {
    name: "writing to closed stdout",
    source: "printf inaccessible",
    redirections: "1>&-",
    status: 1,
  },
  { name: "all stdio closed", source: ":", redirections: "0<&- 1>&- 2>&-", status: 0 },
  { name: "a parse error and closed stderr", source: "if", redirections: "2>&-", status: 2 },
]) {
  test(`a runtime shell child tolerates ${scenario.name} without inventing descriptors`, async ({
    page,
  }) => {
    const baseline = await open(page);
    await command(
      page,
      `/programs/shell-engine.wasm -c '${scenario.source}' ${scenario.redirections}; printf 'CHILD_STDIO_STATUS:%s\\n' "$?"`,
    );
    if (scenario.marker) await output(page, scenario.marker);
    await output(page, `CHILD_STDIO_STATUS:${scenario.status}`);
    await ready(page);
    await expect.poll(() => page.workers().length).toBe(baseline);
  });
}

test("an interactive expansion error aborts its command but preserves the session", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(
    page,
    "RECOVERY_SENTINEL=alive; unset missing; echo ${missing:?required}; echo BAD_AFTER_EXPANSION",
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.bashWeb?.readLines().some((line) => line.includes("missing: required")),
      ),
    )
    .toBe(true);
  await ready(page);
  await command(
    page,
    `printf 'EXPANSION_STATUS:%s:%s\\n' "$?" "$RECOVERY_SENTINEL"; echo EXPANSION_RECOVERED`,
  );
  await output(page, "EXPANSION_STATUS:127:alive");
  await output(page, "EXPANSION_RECOVERED");
  await ready(page);
  const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  expect(lines).not.toContain("BAD_AFTER_EXPANSION");
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("nested WASI spawn inherits the live pipeline and reaps its child", async ({ page }) => {
  const baseline = await open(page);
  await command(
    page,
    "printf NESTED_STDIN:; printf payload | test-guest spawn /bin/test-guest cat; nested_status=$?; echo; echo NESTED_STATUS:$nested_status",
  );
  await output(page, "NESTED_STDIN:payload");
  await output(page, "NESTED_STATUS:0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].pipes))
    .toBe(0);
});

test("nested Bun stdin inheritance retains the generic parent's pipe", async ({ page }) => {
  test.skip(
    true,
    "Missing public bun-wasm API: installBunAdapters(runtime, { workerUrl }) and bun-wasm/worker with its matching verified guest artifact; no public launcher package is available yet and copied Bun host code is not shipped.",
  );
  const baseline = await open(page);
  await file(page, "stdin-reader.ts", 'console.log("NESTED_STDIN:"+await Bun.stdin.text())');
  await file(
    page,
    "stdin-parent.ts",
    'const child=Bun.spawn(["bun","run","stdin-reader.ts"],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});await child.exited',
  );
  await command(page, "printf payload | bun run stdin-parent.ts");
  await output(page, "NESTED_STDIN:payload");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("a guest that handles EPIPE keeps its own exit status", async ({ page }) => {
  const baseline = await open(page);
  await command(
    page,
    `set -o pipefail; test-guest yes first | { IFS= read -r line; echo "$line"; }; printf 'HANDLED:%s:%s\\n' "$?" "\${PIPESTATUS[*]}"`,
  );
  await output(page, "first");
  await output(page, "HANDLED:23:23 0");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("a background WASI producer streams while the next command can kill and wait for its job", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(page, "test-guest ticker 0 250 DEV &");
  await output(page, "DEV 0", true);
  await ready(page);
  await output(page, "DEV 1");
  await command(page, "echo NEXT_COMMAND");
  await output(page, "NEXT_COMMAND");
  await ready(page);
  await command(page, "kill %1; wait; echo DEV_REAPED");
  await output(page, "DEV_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

test("a background shell group kills and waits for sequential members after its first WASI guest exits", async ({
  page,
}) => {
  const baseline = await open(page);
  await command(
    page,
    "{ test-guest emit FIRST_MEMBER; echo; test-guest ticker 0 250 LATER_MEMBER; echo BAD_AFTER_JOB_KILL; } &",
  );
  await output(page, "FIRST_MEMBER", true);
  await output(page, "LATER_MEMBER 0", true);
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline + 1);
  await command(page, "kill %1; wait %1; echo SEQUENTIAL_MEMBERS_REAPED");
  await output(page, "SEQUENTIAL_MEMBERS_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
  const lines = await page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()));
  expect(lines).not.toContain("BAD_AFTER_JOB_KILL");
});

test("Ctrl+C confirms foreground descendants while preserving another background job", async ({
  page,
}) => {
  test.fixme(
    true,
    "Known runtime failure: step 7b must move Bun.spawn descendants into the shared process directory before whole-job interruption can reach them.",
  );
  const baseline = await open(page);
  await file(page, "descendant.ts", 'console.log("DESCENDANT_READY");for(;;)await Bun.sleep(100)');
  await file(
    page,
    "parent.ts",
    'const child=Bun.spawn(["bun","run","descendant.ts"],{stdin:"ignore",stdout:"inherit",stderr:"inherit"});console.log("PARENT_READY");await child.exited',
  );
  await command(page, "bun -e 'console.log(\"INDEPENDENT_READY\");for(;;)await Bun.sleep(100)' &");
  await output(page, "INDEPENDENT_READY");
  await ready(page);
  await command(page, "bun run parent.ts");
  await output(page, "PARENT_READY");
  await output(page, "DESCENDANT_READY");
  await expect.poll(() => page.workers().length).toBe(baseline + 3);
  await page.keyboard.press("Control+c");
  await ready(page);
  // The prompt is forbidden until all foreground descendants have exited.
  expect(page.workers().length).toBe(baseline + 1);
  await command(page, "echo DESCENDANT_STATUS:$?; kill %1; wait; echo DESCENDANTS_REAPED");
  await output(page, "DESCENDANT_STATUS:130");
  await output(page, "DESCENDANTS_REAPED");
  await ready(page);
  await expect.poll(() => page.workers().length).toBe(baseline);
});

// These bounds cover the shell, descriptor transport and supervisor. The child
// program's deliberate read-all allocation is not a shell buffering budget.
test("an accumulating consumer cannot make the shell or transport buffer its input", async ({
  page,
}) => {
  const baselineWorkers = await open(page);
  const before = await page.evaluate(() => window.bashWeb!.runtimeSnapshot()!);
  const baseMemory = before.roots[0].memoryBytes;
  let peakShell = baseMemory;
  let peakPipes = 0;
  let peakSlots = before.roots[0].retainedSlots;
  await command(page, "seq 1 2000000 | test-guest delayed-count 500 ACCUMULATED");
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => ({
      runtime: window.bashWeb!.runtimeSnapshot()!,
      done: window
        .bashWeb!.readLines()
        .some((line) => line.trim() === "ACCUMULATED:14888896:2000001"),
    }));
    const root = sample.runtime.roots[0];
    peakShell = Math.max(peakShell, root.memoryBytes);
    peakPipes = Math.max(peakPipes, root.pipes);
    peakSlots = Math.max(peakSlots, root.retainedSlots);
    expect(sample.runtime.terminal.outputQueued).toBeLessThanOrEqual(
      sample.runtime.terminal.outputCapacity,
    );
    if (sample.done) break;
    await page.waitForTimeout(20);
  }
  await output(page, "ACCUMULATED:14888896:2000001");
  await ready(page);
  expect(peakShell - baseMemory).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(peakPipes).toBeLessThanOrEqual(2);
  expect(peakSlots - before.roots[0].retainedSlots).toBeLessThanOrEqual(1);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers);
  await expect
    .poll(() => page.evaluate(() => window.bashWeb!.runtimeSnapshot()!.roots[0].pipes))
    .toBe(0);
});

test("a slow terminal applies backpressure without growing the shell or output queue", async ({
  page,
}) => {
  const baselineWorkers = await open(page);
  const before = await page.evaluate(() => {
    const terminal = window.bashWeb!.terminal!;
    const write = terminal.write.bind(terminal);
    terminal.write = (bytes) => {
      // Slow the actual downstream consumer; workers continue producing off-thread.
      const until = performance.now() + 12;
      while (performance.now() < until) {
        /* synchronous terminal work */
      }
      return write(bytes);
    };
    return window.bashWeb!.runtimeSnapshot()!;
  });
  let peakQueue = 0;
  let peakShell = before.roots[0].memoryBytes;
  const line = "x".repeat(8191) + "\\n";
  await command(page, `test-guest emit $'${line}' 512; echo SLOW_TERMINAL_DONE`);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const sample = await page.evaluate(() => ({
      runtime: window.bashWeb!.runtimeSnapshot()!,
      done: window.bashWeb!.readLines().some((line) => line.trim() === "SLOW_TERMINAL_DONE"),
    }));
    peakQueue = Math.max(peakQueue, sample.runtime.terminal.outputQueued);
    peakShell = Math.max(peakShell, sample.runtime.roots[0].memoryBytes);
    expect(sample.runtime.terminal.outputQueued).toBeLessThanOrEqual(262144);
    if (sample.done) break;
    await page.waitForTimeout(20);
  }
  await output(page, "SLOW_TERMINAL_DONE");
  await ready(page);
  expect(peakQueue).toBeGreaterThan(0);
  expect(peakShell - before.roots[0].memoryBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  await expect.poll(() => page.workers().length).toBe(baselineWorkers);
});
