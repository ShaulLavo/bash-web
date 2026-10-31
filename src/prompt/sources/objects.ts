import type { TurnFilesystem } from "../fs";
import type { WorkBudget } from "../live";
import type { Known, ObjectStatus, ParsedIndex } from "./index-types";
import type { RepositorySnapshot } from "./repo-types";
import { ObjectReader } from "./object-reader";
import { aheadBehind, stagedChanges } from "./object-tree";
import { readUpstream } from "./object-upstream";
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
  if (head.kind === "unknown")
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
