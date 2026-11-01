import type { TurnFilesystem } from "../fs";
import type { WorkBudget } from "../live";
import type { Known, ObjectStatus, ParsedIndex } from "./index-types";
import type { RepositorySnapshot } from "./repo-types";
import { ObjectReader } from "./object-reader";
import { aheadBehind, stagedChanges } from "./object-tree";
import { readUpstream } from "./object-upstream";
import { hasPackedReplacement } from "./repo-refs";
import type { ObjectWork } from "./object-work";

export async function readObjectStatus(
  filesystem: TurnFilesystem,
  repository: RepositorySnapshot,
  index: ParsedIndex,
  budget: WorkBudget,
): Promise<ObjectStatus> {
  const work = budget;
  const reader = new ObjectReader(filesystem, repository.commonDir, work);
  const head = repository.head;
  const replaced = await known(work, async () => {
    const directory = await filesystem.lookup(`${repository.commonDir}/refs/replace`);
    const grafts = await filesystem.lookup(`${repository.commonDir}/info/grafts`);
    return (
      Boolean(grafts || (directory && (directory.kind !== "dir" || directory.children.size > 0))) ||
      (await hasPackedReplacement(filesystem, repository.commonDir))
    );
  });
  if (replaced.kind === "unknown" || replaced.value || head.kind === "unknown")
    return { staged: { kind: "unknown" }, aheadBehind: { kind: "unknown" } };
  const staged = await known(work, () => stagedChanges(reader, head.commit, index));
  const counts = await known(work, async () => {
    if (!head.commit) return { ahead: 0, behind: 0 };
    const upstream = await readUpstream(filesystem, repository);
    work.check();
    if (!upstream) return { ahead: 0, behind: 0 };
    return aheadBehind(reader, head.commit, upstream);
  });
  return { staged, aheadBehind: counts };
}

async function known<T>(work: ObjectWork, read: () => Promise<T>): Promise<Known<T>> {
  try {
    work.check();
    const value = await read();
    work.check();
    return { kind: "known", value };
  } catch {
    return { kind: "unknown" };
  }
}
