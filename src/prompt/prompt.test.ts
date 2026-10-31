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
    ["extra", "segments.character.style.fg"],
  );
});

test("does not push a result from an older turn", async () => {
  const updates: string[] = [];
  const prompt = createPrompt({
    filesystem: filesystem({ "/home/user/workspace/slow/package.json": '{"version":"1.0.0"}' }, 25),
  });
  const firstLive = {
    signal: new AbortController().signal,
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
  await prompt.render(context({ turn: 2, cwd: "/home/user/workspace/slow" }), secondLive);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(updates.filter((text) => text.startsWith("first:")).length, 0);
  assert.equal(updates.filter((text) => text.startsWith("second:")).length, 1);
});
