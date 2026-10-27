import * as git from "isomorphic-git";
import {
  arity,
  clean,
  GitFailure,
  identity,
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
  const author = await identity(context, "AUTHOR");
  const committer = await identity(context, "COMMITTER");
  try {
    await git.commit({
      ...context,
      message,
      author,
      committer,
      disallowEmpty: !parsed.flags.has("--allow-empty"),
    });
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

export async function gitMerge(context: GitContext, args: readonly string[]) {
  const parsed = options(args, ["--ff-only", "--no-ff"], ["-m", "--message"]);
  arity(parsed.paths, 1);
  if (parsed.flags.has("--ff-only") && parsed.flags.has("--no-ff"))
    throw new GitFailure("incompatible merge flags", 129);
  await clean(context);
  const theirs = parsed.paths[0];
  const ref = await git.currentBranch(context);
  if (!ref) throw new GitFailure("merging in detached HEAD is unsupported", 129);
  const author = await identity(context, "AUTHOR");
  const committer = await identity(context, "COMMITTER");
  const merge = {
    ...context,
    theirs,
    author,
    committer,
    fastForward: !parsed.flags.has("--no-ff"),
    fastForwardOnly: parsed.flags.has("--ff-only"),
    message: parsed.named.get("-m") ?? parsed.named.get("--message"),
  };
  try {
    await git.merge({ ...merge, dryRun: true });
    await git.checkout({ ...context, ref: theirs, dryRun: true, noUpdateHead: true });
    await git.merge(merge);
    await git.checkout({ ...context, ref });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "MergeConflictError"
    )
      throw new GitFailure("merge conflicts; this local slice leaves the repository unchanged", 1);
    throw error;
  }
}
