import * as git from "isomorphic-git";
import {
  arity,
  clean,
  exists,
  GitFailure,
  identity,
  options,
  output,
  text,
  type GitContext,
} from "./git-context";

export async function gitStash(context: GitContext, args: readonly string[]) {
  const parsed = options(args, ["--index"], ["-m", "--message", "--format"]);
  const op = parsed.paths[0] ?? "push";
  if (parsed.flags.has("--index") && op !== "apply" && op !== "pop")
    throw new GitFailure("--index requires stash apply or pop", 129);
  if (parsed.named.has("--format") && op !== "list")
    throw new GitFailure("--format requires stash list", 129);
  if ((parsed.named.has("-m") || parsed.named.has("--message")) && op !== "push")
    throw new GitFailure("-m requires stash push", 129);
  if (op === "list") return list(context, parsed);
  if (!["push", "apply", "pop", "drop", "clear"].includes(op))
    throw new GitFailure(`unsupported stash operation '${op}'`, 129);
  arity(parsed.paths, 0, op === "push" || op === "clear" ? 1 : 2);
  if (op === "apply" || op === "pop") await clean(context);
  const refIdx = stashIndex(parsed.paths[1]);
  const entries = await stashMessages(context);
  if (op !== "push" && op !== "clear" && refIdx >= entries.length)
    throw new GitFailure("no stash entry found", 1);
  if (op === "push")
    return push(context, parsed.named.get("-m") ?? parsed.named.get("--message") ?? "");
  if (op === "clear") {
    await git.stash({ ...context, op });
    return;
  }
  if (op === "drop") {
    await git.stash({ ...context, op, refIdx });
    return;
  }
  if (op !== "apply" && op !== "pop") throw new GitFailure("unsupported stash operation", 129);
  await git.stash({ ...context, op, refIdx });
  if (!parsed.flags.has("--index")) await unstage(context);
}

function stashIndex(value?: string) {
  if (value === undefined) return 0;
  const match = /^(?:stash@\{)?(\d+)\}?$/.exec(value);
  if (!match) throw new GitFailure("invalid stash reference", 129);
  return Number(match[1]);
}

async function list(context: GitContext, parsed: ReturnType<typeof options>) {
  arity(parsed.paths, 1);
  const format = parsed.named.get("--format");
  if (format && format !== "%gs") throw new GitFailure("only stash --format=%gs is supported", 129);
  const messages = await stashMessages(context);
  await output(
    context,
    messages.map((message, index) => `${format ? "" : `stash@{${index}}: `}${message}\n`).join(""),
  );
}

async function stashMessages(context: GitContext) {
  const path = `${context.dir}/.git/logs/refs/stash`;
  if (!(await exists(context.fs, path))) return [];
  return (await text(context.fs, path))
    .trimEnd()
    .split("\n")
    .reverse()
    .map((line) => line.slice(line.indexOf("\t") + 1));
}

async function push(context: GitContext, message: string) {
  const rows = await git.statusMatrix(context);
  if (
    !rows.some(
      ([, head, work, stage]) => (head !== 0 || stage !== 0) && (head !== work || head !== stage),
    )
  )
    return;
  const author = await identity(context, "AUTHOR");
  const configPath = `${context.dir}/.git/config`;
  const config = await text(context.fs, configPath);
  const fs = {
    promises: {
      ...context.fs.promises,
      async readFile(path: string, encoding?: string | { encoding?: string }) {
        if (path !== configPath) return context.fs.promises.readFile(path, encoding);
        const overlay = `${config}\n[user]\nname = ${JSON.stringify(author.name)}\nemail = ${JSON.stringify(author.email)}\n`;
        const format = typeof encoding === "string" ? encoding : encoding?.encoding;
        return format ? overlay : new TextEncoder().encode(overlay);
      },
    },
  };
  await git.stash({ ...context, fs, op: "push", message });
}

async function unstage(context: GitContext) {
  const rows = await git.statusMatrix(context);
  for (const [filepath, head, , stage] of rows) {
    if (head === stage) continue;
    await git.resetIndex({ ...context, filepath });
  }
}
