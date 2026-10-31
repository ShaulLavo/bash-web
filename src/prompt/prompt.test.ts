import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrompt } from "./index";
import { parsePromptConfig } from "./config/file";
import type { PromptContext, PromptFilesystem } from "./types";

const encoder = new TextEncoder();

function filesystem(files: Record<string, string>, delayMs = 0): PromptFilesystem {
  const directories = new Map<string, Set<string>>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
      const parent = index === 0 ? "/" : `/${parts.slice(0, index).join("/")}`;
      const names = directories.get(parent) ?? new Set<string>();
      names.add(parts[index]);
      directories.set(parent, names);
    }
  }
  const wait = async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  };
  return {
    async lookup(path) {
      await wait();
      if (directories.has(path))
        return {
          kind: "dir",
          ino: 1,
          mtime: 1,
          children: new Map(
            Array.from(directories.get(path) ?? [], (name) => [
              name,
              { kind: "file", ino: 1, mtime: 1 },
            ]),
          ),
        };
      if (files[path] !== undefined) return { kind: "file", ino: 1, mtime: 1 };
      return undefined;
    },
    async readFile(path) {
      await wait();
      return files[path] === undefined ? undefined : encoder.encode(files[path]);
    },
  };
}

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    turn: 1,
    cwd: "/home/user/workspace/empty",
    status: 0,
    pipestatus: [0],
    durationMs: undefined,
    jobs: 0,
    columns: 80,
    rows: 24,
    lineEditor: "bash",
    ps1: "$ ",
    variables: new Map([
      ["HOME", "/home/user"],
      ["TERM", "xterm-256color"],
    ]),
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("renders the Starship non-git empty fixture", async () => {
  const prompt = createPrompt({ filesystem: filesystem({}), versions: { node: "26.12.1" } });
  const live = { signal: new AbortController().signal, update() {} };
  const output = await prompt.render(context(), live);
  assert.equal(output, "\n\u001b[1;36m~/workspace/empty\u001b[0m \n\u001b[1;32m❯\u001b[0m ");
});

test("renders package and Bun segments from filesystem data and host versions", async () => {
  const prompt = createPrompt({
    filesystem: filesystem({
      "/home/user/workspace/bun/package.json": '{"version":"2.3.4"}',
      "/home/user/workspace/bun/bun.lock": "lock",
    }),
    versions: { bun: "1.4.4", node: "26.12.1" },
  });
  const output = await prompt.render(context({ cwd: "/home/user/workspace/bun" }), {
    signal: new AbortController().signal,
    update() {},
  });
  assert.equal(
    output,
    "\n\u001b[1;36m~/workspace/bun\u001b[0m is \u001b[1;38;5;208m📦 v2.3.4\u001b[0m via \u001b[1;31m🥟 v1.4.4 \u001b[0m\n\u001b[1;32m❯\u001b[0m ",
  );
});

test("keeps invalid JSON errors pathful and retains the last good config", async () => {
  const messages: string[] = [];
  const prompt = createPrompt({
    filesystem: filesystem({ "/home/user/.config/bash-web/prompt.json": '{"paintMs":true}' }),
    file: true,
    logger: (message) => messages.push(message),
  });
  const live = { signal: new AbortController().signal, update() {} };
  await prompt.render(context(), live);
  await prompt.render(context({ turn: 2 }), live);
  assert.deepEqual(messages, ["paintMs: expected a finite number"]);
});

test("merges a file edit on the next prompt", async () => {
  let version = '{"segments":{"character":{"successSymbol":"$"}}}';
  const base = filesystem({});
  const prompt = createPrompt({
    filesystem: {
      lookup: async (path) =>
        path.endsWith("prompt.json")
          ? { kind: "file", ino: 1, mtime: version.includes('"#"') ? 2 : 1 }
          : base.lookup(path),
      readFile: async (path) =>
        path.endsWith("prompt.json") ? encoder.encode(version) : base.readFile(path),
    },
    file: true,
  });
  const live = { signal: new AbortController().signal, update() {} };
  const first = await prompt.render(context(), live);
  assert.ok(first);
  assert.match(first, /\$/u);
  version = '{"segments":{"character":{"successSymbol":"#"}}}';
  const second = await prompt.render(context({ turn: 2 }), live);
  assert.ok(second);
  assert.match(second, /#/u);
});

test("reports a slow source through a live update and rejects stale generations", async () => {
  const updates: string[] = [];
  const prompt = createPrompt({
    filesystem: filesystem({ "/home/user/workspace/slow/package.json": '{"version":"1.0.0"}' }, 25),
  });
  const controller = new AbortController();
  const live = {
    signal: controller.signal,
    update(text: string) {
      updates.push(text);
    },
  };
  const first = await prompt.render(context({ cwd: "/home/user/workspace/slow" }), live);
  assert.equal(first, "\n\u001b[1;36m~/workspace/slow\u001b[0m \n\u001b[1;32m❯\u001b[0m ");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(updates.length, 1);
  assert.match(updates[0], /v1\.0\.0/u);
});

test("validates unknown fields and colors at the JSON boundary", () => {
  const parsed = parsePromptConfig({
    segments: { character: { style: { fg: { bad: true } } } },
    extra: true,
  });
  assert.deepEqual(
    parsed.errors.map((error) => error.path),
    ["extra", "segments.character.style"],
  );
});

test("does not push a result from an older turn", async () => {
  const updates: string[] = [];
  const prompt = createPrompt({
    filesystem: filesystem({ "/home/user/workspace/slow/package.json": '{"version":"1.0.0"}' }, 25),
  });
  const firstController = new AbortController();
  const firstLive = {
    signal: firstController.signal,
    update(text: string) {
      updates.push(`first:${text}`);
    },
  };
  const secondLive = {
    signal: new AbortController().signal,
    update(text: string) {
      updates.push(`second:${text}`);
    },
  };
  await prompt.render(context({ cwd: "/home/user/workspace/slow" }), firstLive);
  firstController.abort();
  await prompt.render(context({ turn: 2, cwd: "/home/user/workspace/slow" }), secondLive);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(updates.filter((text) => text.startsWith("first:")).length, 0);
  assert.equal(updates.filter((text) => text.startsWith("second:")).length, 1);
});

test("segment schemas reject unknown keys, nulls, arrays and wrong field types", () => {
  const cases: readonly [unknown, string][] = [
    [{ directory: { bogus: true } }, "segments.directory.bogus"],
    [{ directory: { truncationLength: "3" } }, "segments.directory.truncationLength"],
    [{ character: { disabled: "false" } }, "segments.character.disabled"],
    [{ directory: null }, "segments.directory"],
    [{ directory: [] }, "segments.directory"],
    [{ directory: { suffix: null } }, "segments.directory.suffix"],
    [{ directory: { suffix: [] } }, "segments.directory.suffix"],
    [{ git_branch: { ignoreBranches: [1] } }, "segments.git_branch.ignoreBranches"],
    [{ git_commit: { length: -1 } }, "segments.git_commit.length"],
    [{ directory: { style: { fg: 256 } } }, "segments.directory.style.fg"],
    [{ directory: { style: { fg: -1 } } }, "segments.directory.style.fg"],
    [{ directory: { style: { fg: 1.5 } } }, "segments.directory.style.fg"],
    [{ directory: { style: { fg: "#abc" } } }, "segments.directory.style.fg"],
    [{ directory: { style: { fg: "\u001b[31m" } } }, "segments.directory.style.fg"],
  ];
  for (const [segments, path] of cases)
    assert.ok(
      parsePromptConfig({ segments }).errors.some((error) => error.path === path),
      path,
    );
  assert.deepEqual(
    parsePromptConfig({
      segments: {
        directory: { style: { fg: "theme_primary", bg: "#12abef" }, truncationLength: 3 },
      },
      palette: { theme_primary: 255 },
    }).errors,
    [],
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function liveRecorder() {
  const controller = new AbortController();
  const updates: string[] = [];
  return {
    controller,
    updates,
    live: {
      signal: controller.signal,
      update: (text: string) => {
        updates.push(text);
      },
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("zero background budget admits no reads or updates", async () => {
  let reads = 0;
  const fs: PromptFilesystem = {
    lookup: async () => {
      reads++;
      return undefined;
    },
    readFile: async () => {
      reads++;
      return undefined;
    },
  };
  const prompt = createPrompt({
    filesystem: fs,
    file: true,
    config: { paintMs: 0, backgroundMs: 0 },
  });
  const recorder = liveRecorder();
  await prompt.render(context(), recorder.live);
  assert.equal(reads, 0);
  assert.deepEqual(recorder.updates, []);
});

for (const reason of ["abort", "deadline"] as const) {
  test(`${reason} retires an admitted lookup without publishing or starting a manifest read`, async () => {
    const listing = deferred<Awaited<ReturnType<PromptFilesystem["lookup"]>>>();
    let manifestReads = 0;
    const prompt = createPrompt({
      filesystem: {
        lookup: () => listing.promise,
        readFile: async () => {
          manifestReads++;
          return encoder.encode('{"version":"1"}');
        },
      },
      config: { paintMs: 0, backgroundMs: reason === "deadline" ? 5 : 2_000 },
    });
    const recorder = liveRecorder();
    await prompt.render(context(), recorder.live);
    if (reason === "abort") recorder.controller.abort();
    else await new Promise((resolve) => setTimeout(resolve, 10));
    listing.resolve({
      kind: "dir",
      ino: 1,
      mtime: 1,
      children: new Map([["package.json", { kind: "file", ino: 2, mtime: 1 }]]),
    });
    await tick();
    assert.equal(manifestReads, 0);
    assert.deepEqual(recorder.updates, []);
  });
}

test("shell-state, literal-only and disabled layouts make no source requests", async () => {
  for (const config of [
    { layout: ["character"] as const },
    { layout: [{ text: "hello\n" }] },
    { layout: ["package"] as const, segments: { package: { disabled: true } } },
  ]) {
    let requests = 0;
    const prompt = createPrompt({
      config,
      filesystem: {
        lookup: async () => {
          requests++;
          return undefined;
        },
        readFile: async () => {
          requests++;
          return undefined;
        },
      },
    });
    await prompt.render(context(), liveRecorder().live);
    assert.equal(requests, 0);
  }
});

test("a shared provider lets both shells finish independent live turns", async () => {
  const prompt = createPrompt({
    filesystem: filesystem(
      { "/a/package.json": '{"version":"1.0.0"}', "/b/package.json": '{"version":"2.0.0"}' },
      5,
    ),
    config: { paintMs: 0 },
  });
  const a = liveRecorder();
  const b = liveRecorder();
  prompt.prepare?.({ cwd: "/a", env: { HOME: "/a", FOO: "from-a" } });
  prompt.prepare?.({ cwd: "/b", env: { HOME: "/b", FOO: "from-b" } });
  await Promise.all([
    prompt.render(context({ cwd: "/a", turn: 1 }), a.live),
    prompt.render(context({ cwd: "/b", turn: 1 }), b.live),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(a.updates.length, 1);
  assert.match(a.updates[0], /v1\.0\.0/);
  assert.equal(b.updates.length, 1);
  assert.match(b.updates[0], /v2\.0\.0/);
});

test("prepare environments do not leak or resurrect unset variables between shells", async () => {
  const prompt = createPrompt({
    filesystem: filesystem({}),
    config: {
      newline: false,
      layout: ["env_var"],
      segments: { env_var: { variable: "FOO", prefix: "" } },
    },
  });
  prompt.prepare?.({ cwd: "/a", env: { FOO: "a" } });
  prompt.prepare?.({ cwd: "/b", env: { FOO: "b" } });
  assert.equal(await prompt.render(context({ variables: new Map() }), liveRecorder().live), "");
  assert.equal(
    await prompt.render(context({ variables: new Map([["FOO", "a"]]) }), liveRecorder().live),
    "a",
  );
});

test("metadata sanitization removes terminal controls but keeps layout newlines and renderer colors", async () => {
  const fs = filesystem({
    "/project/package.json": JSON.stringify({ version: "1\u001b[31m\n.2\u001b]0;title\u0007.3" }),
  });
  const prompt = createPrompt({
    filesystem: fs,
    versions: { node: "24\u001b[32m\r.0" },
    config: {
      newline: false,
      layout: [
        "directory",
        "package",
        "nodejs",
        "python",
        "env_var",
        { text: "\nnext" },
        "line_break",
        "character",
      ],
      segments: { env_var: { variable: "FOO" } },
    },
  });
  const variables = new Map([
    ["FOO", "safe\u001b[2J\nvalue"],
    ["VIRTUAL_ENV", "/env/venv\u001b[33m\rname"],
  ]);
  const text = await prompt.render(context({ cwd: "/project", variables }), liveRecorder().live);
  assert.ok(text);
  assert.match(text, /v1\.2\.3/);
  assert.match(text, /v24\.0/);
  assert.match(text, /venvname/);
  assert.match(text, /safevalue/);
  assert.match(text, /\nnext\n/);
  assert.ok(text.includes("\u001b[1;36m"));
  assert.ok(!text.includes("title"));
  assert.ok(!text.includes("\u001b[2J"));
  const plain = await prompt.render(
    context({ cwd: "/home/\u001b[31mbad\npath", variables: new Map([["NO_COLOR", "1"]]) }),
    liveRecorder().live,
  );
  assert.ok(plain);
  assert.ok(!plain.includes("\u001b"));
  assert.ok(plain.includes("badpath"));
});

test("a file override recursively preserves host fields and invalid edits retain last good config", async () => {
  let file = '{"segments":{"directory":{"suffix":"X","style":{"bold":false}}}}';
  let mtime = 1;
  const messages: string[] = [];
  const fs: PromptFilesystem = {
    lookup: async (path) =>
      path.endsWith("prompt.json") ? { kind: "file", ino: 1, mtime } : undefined,
    readFile: async () => encoder.encode(file),
  };
  const prompt = createPrompt({
    filesystem: fs,
    file: true,
    logger: (message) => messages.push(message),
    config: {
      newline: false,
      layout: ["directory"],
      segments: { directory: { style: { fg: "red", bold: true } } },
    },
  });
  const text = await prompt.render(context(), liveRecorder().live);
  assert.equal(text, "\u001b[31m~/workspace/empty\u001b[0mX");
  file = '{"segments":{"directory":{"style":{"fg":999}}}}';
  mtime++;
  assert.equal(await prompt.render(context({ turn: 2 }), liveRecorder().live), text);
  assert.equal(await prompt.render(context({ turn: 3 }), liveRecorder().live), text);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /segments.directory.style.fg/);
});

test("file edits negotiate new env dependencies without discarding other shells' names", async () => {
  let variable = "FOO";
  let mtime = 1;
  const prompt = createPrompt({
    file: true,
    filesystem: {
      lookup: async () => ({ kind: "file", ino: 1, mtime }),
      readFile: async () =>
        encoder.encode(
          JSON.stringify({
            layout: ["env_var"],
            newline: false,
            segments: { env_var: { variable, prefix: "" } },
          }),
        ),
    },
  });
  await prompt.render(context(), liveRecorder().live);
  assert.ok(prompt.variables.includes("FOO"));
  const variables = new Map([
    ["HOME", "/home/user"],
    ["FOO", "first"],
  ]);
  assert.equal(await prompt.render(context({ turn: 2, variables }), liveRecorder().live), "first");
  variable = "BAR";
  mtime++;
  await prompt.render(context({ turn: 3, variables }), liveRecorder().live);
  assert.ok(prompt.variables.includes("BAR"));
  assert.ok(prompt.variables.includes("FOO"));
  assert.equal(
    await prompt.render(
      context({
        turn: 4,
        variables: new Map([
          ["HOME", "/home/user"],
          ["BAR", "second"],
        ]),
      }),
      liveRecorder().live,
    ),
    "second",
  );
});

import { styleToSgr } from "./style";
import { renderPrompt } from "./render";
import { WorkBudget, PromptTurnLive } from "./live";

test("named, bright, palette and extended backgrounds retain background intent", () => {
  assert.equal(styleToSgr({ bg: "red" }, {}, {}), "\u001b[41m");
  assert.equal(styleToSgr({ fg: "red", bg: "bright-blue" }, {}, {}), "\u001b[31;104m");
  assert.equal(styleToSgr({ bg: "theme" }, { theme: "bright-red" }, {}), "\u001b[101m");
  assert.equal(styleToSgr({ bg: 208 }, {}, {}), "\u001b[48;5;208m");
  assert.equal(styleToSgr({ bg: "#123456" }, {}, { trueColor: true }), "\u001b[48;2;18;52;86m");
});

test("missing config files do not import the validator", async () => {
  let loads = 0;
  const options = {
    file: true,
    filesystem: filesystem({}),
    config: { layout: ["character"] as const },
  };
  await renderPrompt(options, {}, context(), liveRecorder().live, async () => {
    loads++;
    throw new Error("unexpected validator import");
  });
  assert.equal(loads, 0);
});

test("work units discard expired results and refuse further admission", async () => {
  let now = 0;
  let work = 0;
  const budget = new WorkBudget(new AbortController().signal, 5, () => now);
  assert.equal(
    await budget.run(() => {
      work++;
      now = 6;
      return 1;
    }),
    undefined,
  );
  assert.equal(
    await budget.run(() => {
      work++;
      return 2;
    }),
    undefined,
  );
  assert.equal(work, 1);
});

test("live updates coalesce and reject a superseded generation", async () => {
  let generation = 1;
  const updates: string[] = [];
  const live = new PromptTurnLive(
    new AbortController().signal,
    1,
    () => generation,
    (text) => updates.push(text),
  );
  live.update("one");
  live.update("two");
  await tick();
  assert.deepEqual(updates, ["two"]);
  generation++;
  live.update("stale");
  await tick();
  assert.deepEqual(updates, ["two"]);
});

test("the first-answer signal expiring does not cancel the live prompt", async () => {
  const reply = new AbortController();
  const recorder = liveRecorder();
  const prompt = createPrompt({
    config: { paintMs: 0 },
    filesystem: filesystem({ "/project/package.json": '{"version":"1.0.0"}' }, 5),
  });
  await prompt.render(context({ cwd: "/project", signal: reply.signal }), recorder.live);
  reply.abort();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(recorder.updates.length, 1);
});

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { defaultPromptConfig } from "./config/defaults";

test("every segment field uses its exact declared schema", () => {
  for (const [segment, fields] of Object.entries(defaultPromptConfig.segments)) {
    for (const [field, sample] of Object.entries(fields)) {
      const bad = typeof sample === "boolean" ? "false" : null;
      const errors = parsePromptConfig({ segments: { [segment]: { [field]: bad } } }).errors;
      assert.ok(
        errors.some((error) => error.path === `segments.${segment}.${field}`),
        `${segment}.${field}`,
      );
    }
  }
});

test("all retained native captures keep their hash and all 24 non-git cases match", async () => {
  const root = `${process.cwd()}/src/prompt/fixtures`;
  const manifest: {
    captures: {
      output: string;
      bytes: number;
      sha256: string;
      caseName: string;
      variant: { status: number; jobs: number; durationMs: number; terminalWidth: number };
    }[];
  } = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
  let compared = 0;
  for (const capture of manifest.captures) {
    const reference = await readFile(`${root}/${capture.output}`);
    assert.equal(reference.length, capture.bytes);
    assert.equal(createHash("sha256").update(reference).digest("hex"), capture.sha256);
    if (capture.caseName.startsWith("git-")) continue;
    const cwd = `/home/user/workspace/${capture.caseName}`;
    const files: Record<string, string> = {};
    if (capture.caseName !== "empty")
      files[`${cwd}/package.json`] = JSON.stringify({
        version:
          capture.caseName === "bun"
            ? "2.3.4"
            : capture.caseName === "package-private"
              ? "9.8.7"
              : "1.2.3",
        private: capture.caseName === "package-private",
      });
    if (capture.caseName === "bun") files[`${cwd}/bun.lock`] = "lock";
    const prompt = createPrompt({
      filesystem: filesystem(files),
      versions: { bun: "1.4.4", node: "26.12.1" },
    });
    const { status, jobs, durationMs, terminalWidth } = capture.variant;
    const text = await prompt.render(
      context({ cwd, status, jobs, durationMs, columns: terminalWidth }),
      liveRecorder().live,
    );
    assert.equal(text, reference.toString("utf8").slice("\u001b[J".length), capture.output);
    compared++;
  }
  assert.equal(compared, 24);
});

test("invalid JSON retains the valid file configuration and reports once", async () => {
  let file = '{"layout":[{"text":"good"}],"newline":false}';
  let mtime = 1;
  const messages: string[] = [];
  const prompt = createPrompt({
    file: true,
    filesystem: {
      lookup: async () => ({ kind: "file", ino: 1, mtime }),
      readFile: async () => encoder.encode(file),
    },
    logger: (message) => messages.push(message),
  });
  assert.equal(await prompt.render(context(), liveRecorder().live), "good");
  file = "{";
  mtime++;
  assert.equal(await prompt.render(context({ turn: 2 }), liveRecorder().live), "good");
  assert.equal(await prompt.render(context({ turn: 3 }), liveRecorder().live), "good");
  assert.deepEqual(messages, ["$: expected an object"]);
});

test("layout demand shares one directory lookup and one manifest read", async () => {
  const calls: string[] = [];
  const underlying = filesystem({
    "/project/package.json": '{"version":"1.0.0"}',
    "/project/bun.lock": "lock",
  });
  const fs: PromptFilesystem = {
    lookup(path) {
      calls.push(`lookup:${path}`);
      return underlying.lookup(path);
    },
    readFile(path) {
      calls.push(`read:${path}`);
      return underlying.readFile(path);
    },
  };
  await createPrompt({ filesystem: fs, config: { layout: ["bun"] } }).render(
    context({ cwd: "/project" }),
    liveRecorder().live,
  );
  assert.deepEqual(calls, ["lookup:/project"]);
  calls.length = 0;
  await createPrompt({
    filesystem: fs,
    config: { layout: ["package", "nodejs", "package"] },
  }).render(context({ cwd: "/project" }), liveRecorder().live);
  assert.deepEqual(calls, ["lookup:/project", "read:/project/package.json"]);
});

test("coalescing keeps the latest text even when it reverts to the previous value", async () => {
  const updates: string[] = [];
  const live = new PromptTurnLive(
    new AbortController().signal,
    1,
    () => 1,
    (text) => updates.push(text),
  );
  live.update("one");
  await tick();
  live.update("two");
  live.update("one");
  await tick();
  assert.deepEqual(updates, ["one"]);
});

test("paint measurements with a 0.3 ms fake filesystem", async (owner) => {
  const prompt = createPrompt({
    filesystem: filesystem({ "/project/package.json": '{"version":"1.0.0"}' }, 0.3),
    versions: { node: "26.12.1" },
  });
  const samples: number[] = [];
  for (let turn = 1; turn <= 51; turn++) {
    const started = performance.now();
    await prompt.render(context({ turn, cwd: "/project" }), liveRecorder().live);
    samples.push(performance.now() - started);
  }
  const warm = samples.slice(1).sort((left, right) => left - right);
  owner.diagnostic(
    JSON.stringify({
      coldMs: samples[0],
      warmMedianMs: warm[25],
      warmP95Ms: warm[47],
      requestDelayMs: 0.3,
      prompts: samples.length,
    }),
  );
  assert.equal(samples.length, 51);
});

test("a manifest finishing after the deadline is discarded", async () => {
  const manifest = deferred<Uint8Array | undefined>();
  let admitted = false;
  const prompt = createPrompt({
    config: { paintMs: 0, backgroundMs: 8 },
    filesystem: {
      lookup: async () => ({
        kind: "dir",
        ino: 1,
        mtime: 1,
        children: new Map([["package.json", { kind: "file", ino: 2, mtime: 1 }]]),
      }),
      readFile() {
        admitted = true;
        return manifest.promise;
      },
    },
  });
  const recorder = liveRecorder();
  await prompt.render(context(), recorder.live);
  assert.ok(admitted);
  await new Promise((resolve) => setTimeout(resolve, 12));
  manifest.resolve(encoder.encode('{"version":"late"}'));
  await tick();
  assert.deepEqual(recorder.updates, []);
});

test("shared-provider config caches are scoped by path, not inode alone", async () => {
  const prompt = createPrompt({
    file: true,
    filesystem: {
      lookup: async () => ({ kind: "file", ino: 1, mtime: 1 }),
      readFile: async (path) =>
        encoder.encode(
          JSON.stringify({
            newline: false,
            layout: [{ text: path.startsWith("/a/") ? "a" : "b" }],
          }),
        ),
    },
  });
  const a = context({ cwd: "/a", variables: new Map([["HOME", "/a"]]) });
  const b = context({ cwd: "/b", variables: new Map([["HOME", "/b"]]) });
  const results = await Promise.all([
    prompt.render(a, liveRecorder().live),
    prompt.render(b, liveRecorder().live),
  ]);
  assert.deepEqual(results, ["a", "b"]);
});
