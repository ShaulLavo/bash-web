import { clearMerge } from "./git-merge";
import * as git from "isomorphic-git";
import {
  arity,
  clean,
  GitFailure,
  identity,
  exists,
  text,
  options,
  output,
  type GitContext,
} from "./git-context";

export async function gitCommit(context: GitContext, args: readonly string[]) {
  const parsed = options(args, ["--allow-empty", "-q", "--quiet"], ["-m", "--message"]);
  arity(parsed.paths, 0);
  const message = parsed.named.get("-m") ?? parsed.named.get("--message");
  if (!message)
    throw new GitFailure(
      "commit requires a nonempty -m message; editors and hooks are unsupported",
      129,
    );
  const mergeHead = `${context.dir}/.git/MERGE_HEAD`;
  const parent = (await exists(context.fs, mergeHead))
    ? [
        await git.resolveRef({ ...context, ref: "HEAD" }),
        (await text(context.fs, mergeHead)).trim(),
      ]
    : undefined;
  const author = await identity(context, "AUTHOR");
  const committer = await identity(context, "COMMITTER");
  try {
    await git.commit({
      ...context,
      message,
      author,
      committer,
      disallowEmpty: parent === undefined && !parsed.flags.has("--allow-empty"),
      parent,
    });
    if (parent) await clearMerge(context);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EmptyCommitError")
      throw new GitFailure("nothing to commit", 1);
    throw error;
  }
}

export async function gitLog(context: GitContext, args: readonly string[]) {
  const parsed = options(
    args,
    ["--oneline", "--first-parent"],
    ["--format", "--pretty", "-n", "--max-count"],
  );
  arity(parsed.paths, 0, 1);
  const format =
    parsed.named.get("--format") ??
    parsed.named.get("--pretty")?.replace(/^format:/, "") ??
    (parsed.flags.has("--oneline") ? "%h %s" : "%H %s");
  if (!new Set(["%s", "%H", "%h %s", "%H %s"]).has(format))
    throw new GitFailure("unsupported log format", 129);
  const count = Number(
    parsed.named.get("-n") ?? parsed.named.get("--max-count") ?? Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(count) || count < 0) throw new GitFailure("invalid log count", 129);
  const ref = parsed.paths[0] ?? "HEAD";
  if (count === 0) return;
  const commits = parsed.flags.has("--first-parent")
    ? await firstParent(context, ref, count)
    : await git.log({ ...context, ref, depth: count });
  await output(
    context,
    commits
      .map(
        ({ oid, commit }) =>
          `${format.replace("%H", oid).replace("%h", oid.slice(0, 7)).replace("%s", commit.message.split("\n")[0])}\n`,
      )
      .join(""),
  );
}

async function firstParent(context: GitContext, ref: string, count: number) {
  const commits: Awaited<ReturnType<typeof git.log>> = [];
  let oid: string | undefined = await git.resolveRef({ ...context, ref });
  while (oid && commits.length < count) {
    const result = await git.readCommit({ ...context, oid });
    commits.push(result);
    oid = result.commit.parent[0];
  }
  return commits;
}

export async function gitBranch(context: GitContext, args: readonly string[]) {
  const parsed = options(args, ["--list", "--show-current", "-d", "-D"]);
  const current = await git.currentBranch(context);
  if (parsed.flags.has("--show-current")) {
    arity(parsed.paths, 0);
    return output(context, current ? `${current}\n` : "");
  }
  if (!parsed.paths.length) {
    const branches = await git.listBranches(context);
    return output(
      context,
      branches.map((branch) => `${branch === current ? "*" : " "} ${branch}\n`).join(""),
    );
  }
  arity(parsed.paths, 1, parsed.flags.has("-d") || parsed.flags.has("-D") ? 1 : 2);
  if (parsed.flags.has("--list")) throw new GitFailure("branch list patterns are unsupported", 129);
  const ref = parsed.paths[0];
  if (!parsed.flags.has("-d") && !parsed.flags.has("-D"))
    return git.branch({ ...context, ref, object: parsed.paths[1] });
  if (ref === current) throw new GitFailure("cannot delete the checked out branch", 1);
  if (!parsed.flags.has("-D")) await requireMerged(context, ref);
  await git.deleteBranch({ ...context, ref });
}

async function requireMerged(context: GitContext, ref: string) {
  const oid = await git.resolveRef({ ...context, ref: "HEAD" });
  const ancestor = await git.resolveRef({ ...context, ref });
  if (oid === ancestor || (await git.isDescendent({ ...context, oid, ancestor }))) return;
  throw new GitFailure(`branch '${ref}' is not fully merged`, 1);
}

export async function gitCheckout(context: GitContext, args: readonly string[]) {
  const parsed = options(args, [], ["-b"]);
  if (await exists(context.fs, `${context.dir}/.git/MERGE_HEAD`))
    throw new GitFailure("finish or abort the current merge first", 1);
  arity(parsed.paths, parsed.named.has("-b") ? 0 : 1, 1);
  const ref = parsed.named.get("-b") ?? parsed.paths[0];
  await clean(context);
  if (!parsed.named.has("-b")) await requireCheckoutRef(context, ref);
  if (parsed.named.has("-b")) await git.branch({ ...context, ref, object: parsed.paths[0] });
  await git.checkout({ ...context, ref });
}

async function requireCheckoutRef(context: GitContext, ref: string) {
  try {
    await git.resolveRef({ ...context, ref });
  } catch {
    throw new GitFailure(`pathspec '${ref}' did not match a local revision`, 1);
  }
}
