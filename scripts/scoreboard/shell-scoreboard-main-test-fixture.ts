import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { authority, git } from "./shell-scoreboard-main.ts";
import type { EvidenceSet, HostArtifact, HostJob, HostRun } from "./shell-scoreboard-main.ts";
import type { MainFloor } from "./shell-scoreboard-floor.ts";
import type { Score } from "./shell-scoreboard.ts";
import { scoreboardFixture } from "./shell-scoreboard-test-fixture.ts";

export const sha = (n: number): string => n.toString(16).padStart(40, "0");
const fixture = scoreboardFixture("oils");
export const { oracle } = fixture;
export const score = (ids: string[]): Score => fixture.score(ids, true);
export const floor = (sourceSha: string, ids: string[]): MainFloor => fixture.floor(ids, sourceSha);
export const empty = (): EvidenceSet => ({ scores: [], floors: [], evidence: [] });
export function provenance(kind: "raw" | "floor" = "raw") {
  const jobName = kind === "raw" ? "own-shell-compatibility" : "score-floor";
  const observe = kind === "raw" ? "Seal complete raw score" : "Fold main floor and qualification";
  const upload = kind === "raw" ? "Upload complete raw score" : "Upload cumulative main floor";
  const name = `own-shell-${kind}-${sha(1)}-10-2`;
  const start = "2026-10-24T17:00:00Z",
    end = "2026-10-24T17:00:02Z";
  const run: HostRun = {
    id: 10,
    run_attempt: 2,
    repository: { id: authority.repositoryId },
    head_repository: { id: authority.repositoryId },
    head_sha: sha(1),
    workflow_id: authority.workflowId,
    path: authority.workflowPath,
    event: "push",
    head_branch: "main",
    status: "in_progress",
    conclusion: null,
  };
  const job: HostJob = {
    id: 20,
    name: jobName,
    run_id: 10,
    run_attempt: 2,
    head_sha: sha(1),
    status: "completed",
    conclusion: "success",
    steps: [observe, upload].map((step, i) => ({
      name: step,
      number: i + 1,
      status: "completed",
      conclusion: "success",
      started_at: start,
      completed_at: end,
    })),
  };
  const artifact: HostArtifact = {
    id: 30,
    name,
    workflow_run: { id: 10, head_sha: sha(1), head_repository_id: authority.repositoryId },
    expired: false,
    digest: `sha256:${"d".repeat(64)}`,
    created_at: start,
  };
  const logs = `2026-10-24T17:00:01.100Z SHA256 digest of uploaded artifact zip is ${"d".repeat(64)}\n2026-10-24T17:00:01.200Z Artifact ${name} has been successfully uploaded! Final size is 100 bytes. Artifact ID is 30\n`;
  return {
    kind,
    run,
    job,
    artifact,
    logs,
    workflow: readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  };
}
export function archive(entries: [string, string][]): Buffer {
  return execFileSync(
    "python3",
    [
      "-c",
      "import io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); [z.writestr(n,v) for n,v in json.load(sys.stdin)]; z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    {
      input: JSON.stringify(entries),
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}
export interface RepoContext {
  root: string;
  put: (path: string, value: string | Buffer) => void;
  commit: () => string;
}
export async function withRepo(body: (repo: RepoContext) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(resolve(process.env.TMPDIR || tmpdir(), "scoreboard-git-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Score fixture"]);
    git(root, ["config", "user.email", "score@example.invalid"]);
    const put = (path: string, value: string | Buffer): void => {
      mkdirSync(resolve(root, path, ".."), { recursive: true });
      writeFileSync(resolve(root, path), value);
    };
    const commit = () => {
      git(root, ["add", "."]);
      git(root, [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "maintenance.auto=false",
        "commit",
        "-qm",
        "fixture",
      ]);
      return git(root, ["rev-parse", "HEAD"]);
    };
    await body({ root, put, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}
