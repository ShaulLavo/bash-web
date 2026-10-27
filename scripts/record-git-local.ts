import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type GitLocalAction =
  | { kind: "write"; path: string; text: string }
  | { kind: "remove"; path: string }
  | { kind: "git"; argv: string[]; output: "exact" | "exit-only" };

export interface GitLocalState {
  files: Record<string, string>;
  head: string;
  refs: Record<string, string>;
  history: Record<string, { subject: string; parents: string[] }>;
  status: string;
  stash: string[];
}

export interface GitLocalStep {
  action: GitLocalAction;
  expected: { status: number; stdout: string | null; stderr: string | null } | null;
  state: GitLocalState;
  oracle: { status: number; stdout: string; stderr: string } | null;
}

export interface GitLocalCase {
  id: string;
  semantics: string;
  steps: GitLocalStep[];
}

export const gitLocalEnvironment = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
  GIT_AUTHOR_DATE: "2001-02-03T04:05:06+0000",
  GIT_COMMITTER_DATE: "2001-02-03T04:05:06+0000",
};

export const gitLocalConfig = [
  "core.autocrlf=false",
  "core.filemode=false",
  "core.quotePath=false",
  "color.ui=false",
  "commit.gpgSign=false",
  "tag.gpgSign=false",
  "commit.cleanup=verbatim",
  "diff.algorithm=myers",
  "diff.context=3",
  "merge.conflictStyle=merge",
  "merge.autoStash=false",
  "rerere.enabled=false",
];

export const gitLocalProbes = {
  head: ["symbolic-ref", "--short", "HEAD"],
  refs: ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/"],
  history: ["log", "--branches", "--topo-order", "--reverse", "--format=%H%x00%P%x00%s"],
  status: ["status", "--porcelain=v1", "--untracked-files=all"],
  stash: ["stash", "list", "--format=%gs"],
};

function git(...argv: string[]): GitLocalAction {
  return { kind: "git", argv, output: "exit-only" };
}

function query(...argv: string[]): GitLocalAction {
  return { kind: "git", argv, output: "exact" };
}

function write(path: string, text: string): GitLocalAction {
  return { kind: "write", path, text };
}

const init = git("init", "--quiet", "--initial-branch=main", "--object-format=sha1", "--template=");
const status = query("status", "--porcelain=v1", "--untracked-files=all");
const base = [init, write("story.txt", "base\n"), git("add", "story.txt"), git("commit", "-m", "base")];

export const gitLocalInputs: { id: string; semantics: string; actions: GitLocalAction[] }[] = [
  {
    id: "index-worktree",
    semantics:
      "Init an empty repository. Stage a spaced filename and text, commit, then distinguish staged, unstaged, untracked and deleted files. Log subjects and both diff views reflect the index. An empty commit fails without changing refs.",
    actions: [
      init,
      status,
      write("notes.txt", "one\ntwo\n"),
      write("spaced name.txt", "space\n"),
      status,
      git("add", "notes.txt", "spaced name.txt"),
      query("diff", "--cached", "--no-ext-diff", "--no-color", "--no-prefix"),
      git("commit", "-m", "initial notes"),
      write("notes.txt", "one\nTWO\n"),
      git("add", "notes.txt"),
      write("notes.txt", "one\nTWO\nthree\n"),
      write("loose.txt", "untracked\n"),
      status,
      query("diff", "--no-ext-diff", "--no-color", "--no-prefix"),
      query("diff", "--cached", "--no-ext-diff", "--no-color", "--no-prefix"),
      git("commit", "-m", "stage second line"),
      status,
      { kind: "remove", path: "spaced name.txt" },
      git("add", "-u"),
      git("commit", "-m", "finish notes and remove spaced file"),
      query("log", "--format=%s"),
      git("commit", "-m", "empty commit must fail"),
      status,
    ],
  },
  {
    id: "branches-and-merges",
    semantics:
      "Create and list branches, checkout an existing branch and create one with -b. Fast-forward first, then merge independent changes with two parents. Checking out a missing branch fails and preserves files and refs.",
    actions: base.concat([
      git("branch", "feature"),
      query("branch", "--list"),
      git("checkout", "feature"),
      write("feature.txt", "feature\n"),
      git("add", "feature.txt"),
      git("commit", "-m", "feature work"),
      git("checkout", "main"),
      git("merge", "--ff-only", "feature"),
      git("checkout", "-b", "side"),
      write("side.txt", "side\n"),
      git("add", "side.txt"),
      git("commit", "-m", "side work"),
      git("checkout", "main"),
      write("main.txt", "main\n"),
      git("add", "main.txt"),
      git("commit", "-m", "main work"),
      git("merge", "--no-ff", "side", "-m", "combine independent changes"),
      query("log", "--first-parent", "--format=%s"),
      git("checkout", "missing"),
      status,
    ]),
  },
  {
    id: "conflict-and-recovery",
    semantics:
      "Conflicting edits produce exit 1, UU index state and conflict markers. Merge --abort restores the pre-merge files and refs. Retry, edit the resolution, add and commit to finish a two-parent merge.",
    actions: base.concat([
      git("checkout", "-b", "side"),
      write("story.txt", "side\n"),
      git("add", "story.txt"),
      git("commit", "-m", "side changes story"),
      git("checkout", "main"),
      write("story.txt", "main\n"),
      git("add", "story.txt"),
      git("commit", "-m", "main changes story"),
      git("merge", "side", "-m", "attempt story merge"),
      status,
      git("merge", "--abort"),
      status,
      git("merge", "side", "-m", "resolve story merge"),
      write("story.txt", "main and side\n"),
      git("add", "story.txt"),
      git("commit", "-m", "resolve story merge"),
      query("log", "--first-parent", "--format=%s"),
      status,
    ]),
  },
  {
    id: "stash-index-and-untracked",
    semantics:
      "Stash -u saves staged, unstaged and untracked files and cleans the worktree. Pop --index restores all three and drops the entry. Apply --index retains an entry until drop. An empty stash push creates no entry.",
    actions: base.concat([
      write("story.txt", "staged\n"),
      git("add", "story.txt"),
      write("story.txt", "staged\nunstaged\n"),
      write("loose.txt", "keep me\n"),
      git("stash", "push", "-u", "-m", "shelved work"),
      query("stash", "list", "--format=%gs"),
      status,
      git("stash", "pop", "--index"),
      status,
      git("add", "story.txt", "loose.txt"),
      git("commit", "-m", "restored work"),
      write("story.txt", "another change\n"),
      git("stash", "push", "-m", "apply separately"),
      git("stash", "apply", "--index"),
      query("stash", "list", "--format=%gs"),
      git("stash", "drop"),
      git("add", "story.txt"),
      git("commit", "-m", "applied work"),
      git("stash", "push", "-m", "nothing to save"),
      query("stash", "list", "--format=%gs"),
      status,
    ]),
  },
];

export function gitLocalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function nativeGit(cwd: string, argv: readonly string[]) {
  const args = gitLocalConfig.flatMap((entry) => ["-c", entry]).concat(argv);
  const result = spawnSync("/usr/bin/git", args, {
    cwd,
    env: gitLocalEnvironment,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `git ${argv.join(" ")} terminated by signal`);
  assert.notEqual(result.status, null);
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function probe(cwd: string, argv: readonly string[]): string {
  const result = nativeGit(cwd, argv);
  assert.equal(result.status, 0, `git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function lines(text: string): string[] {
  return text.trimEnd() === "" ? [] : text.trimEnd().split("\n");
}

function readTree(root: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = readdirSync(join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, readTree(root, path + "/"));
    else files[path] = readFileSync(join(root, path), "utf8");
  }
  return files;
}

function commitLabel(labels: Map<string, string>, oid: string): string {
  const label = labels.get(oid);
  assert.ok(label, `Unknown commit ${oid}`);
  return label;
}

function inspectState(cwd: string, labels: Map<string, string>): GitLocalState {
  const refs: Record<string, string> = {};
  const history: GitLocalState["history"] = {};
  const refLines = lines(probe(cwd, gitLocalProbes.refs));
  const commits = refLines.length === 0 ? [] : lines(probe(cwd, gitLocalProbes.history));
  for (const line of commits) {
    const [oid, parents, subject] = line.split("\0");
    assert.ok(oid && parents !== undefined && subject);
    if (!labels.has(oid)) labels.set(oid, `c${labels.size + 1}`);
    history[commitLabel(labels, oid)] = {
      subject,
      parents: parents === "" ? [] : parents.split(" ").map((id) => commitLabel(labels, id)),
    };
  }
  for (const line of refLines) {
    const [ref, oid] = line.split("\0");
    assert.ok(ref && oid);
    refs[ref] = commitLabel(labels, oid);
  }
  return {
    files: readTree(cwd),
    head: probe(cwd, gitLocalProbes.head).trimEnd(),
    refs,
    history,
    status: probe(cwd, gitLocalProbes.status),
    stash: lines(probe(cwd, gitLocalProbes.stash)),
  };
}

export function gitLocalPath(root: string, path: string): string {
  assert.ok(path !== "" && !isAbsolute(path), "Expected relative worktree path");
  assert.ok(!path.split(/[\\/]/).some((part) => part === ".." || part === ".git"));
  return join(root, path);
}

function recordStep(cwd: string, action: GitLocalAction, labels: Map<string, string>): GitLocalStep {
  if (action.kind === "git") {
    const result = nativeGit(cwd, action.argv);
    return {
      action,
      expected: {
        status: result.status,
        stdout: action.output === "exact" ? result.stdout : null,
        stderr: action.output === "exact" ? result.stderr : null,
      },
      state: inspectState(cwd, labels),
      oracle: { ...result, stdout: result.stdout.replaceAll(cwd, "<repo>"), stderr: result.stderr.replaceAll(cwd, "<repo>") },
    };
  }
  const path = gitLocalPath(cwd, action.path);
  if (action.kind === "remove") rmSync(path);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, action.text);
  }
  return { action, expected: null, state: inspectState(cwd, labels), oracle: null };
}

export function recordGitLocal(scratchRoot = "/work/tmp") {
  assert.ok(isAbsolute(scratchRoot), "Scratch root must be absolute");
  const scratch = mkdtempSync(join(scratchRoot, "bash-web-git-oracle-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  const interrupt = () => { cleanup(); process.exit(130); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const cases: GitLocalCase[] = gitLocalInputs.map((input) => {
      const cwd = join(scratch, input.id);
      mkdirSync(cwd);
      const labels = new Map<string, string>();
      return { id: input.id, semantics: input.semantics, steps: input.actions.map((action) => recordStep(cwd, action, labels)) };
    });
    return {
      schema: 1,
      provenance: {
        git: { path: "/usr/bin/git", version: probe(scratch, ["--version"]).trimEnd(), sha256: createHash("sha256").update(readFileSync("/usr/bin/git")).digest("hex") },
        environment: gitLocalEnvironment,
        config: gitLocalConfig,
        probes: gitLocalProbes,
        inputsSha256: gitLocalDigest(gitLocalInputs),
        casesSha256: gitLocalDigest(cases),
        normalization: "Compare all states and exit statuses. Compare stdout/stderr only for exact queries. Commit labels c1,c2,... follow first observation in reverse topological history. No dates or object IDs in expected state. Raw mutation diagnostics are provenance only; scratch paths become <repo>.",
      },
      cases,
    };
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  assert.ok(mode === "--write" || mode === "--check", "Usage: node scripts/record-git-local.ts --write|--check");
  const fixture = new URL("./owned-fixtures/git-local.json", import.meta.url);
  const text = JSON.stringify(recordGitLocal(), null, 2) + "\n";
  if (mode === "--write") writeFileSync(fixture, text, { flag: "wx" });
  else assert.equal(readFileSync(fixture, "utf8"), text, "Git recording differs; inspect provenance and semantics");
}
