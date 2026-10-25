import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { liveNodeWorkers } from "./node-worker-host.ts";
import { releaseShellRunner } from "./release-shell-runner.ts";

const fixture: {
  selected: Case[];
  controls: Case[];
} = JSON.parse(readFileSync(new URL("cases/pipeline-status.json", import.meta.url), "utf8"));
type Case = {
  id: string;
  code: string;
  bash: { status: number; stdout: string };
};
const run = await releaseShellRunner();
for (const item of fixture.selected.concat(fixture.controls))
  test(`pipeline status ${item.id}`, async () => {
    const result = await run(item.code);
    assert.equal(result.crash, undefined);
    assert.equal(result.status, item.bash.status);
    assert.equal(result.stdout.toString("base64"), item.bash.stdout);
  });

const attributes: {
  cases: { id: string; code: string; status: number; stdout: string }[];
} = JSON.parse(
  readFileSync(new URL("cases/pipeline-status-attributes.json", import.meta.url), "utf8"),
);
for (const item of attributes.cases)
  test(`pipeline status declaration contract ${item.id}`, async () => {
    const result = await run(item.code);
    assert.equal(result.crash, undefined);
    assert.equal(result.outputLimit, undefined);
    assert.equal(result.status, item.status);
    assert.equal(result.stdout.toString(), item.stdout);
  });
after(() => assert.equal(liveNodeWorkers(), 0));
