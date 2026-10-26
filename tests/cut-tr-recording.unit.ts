import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import fixture from "../scripts/owned-fixtures/cut-tr.json" with { type: "json" };
import { cutTrRecording } from "./helpers/cut-tr-recording.ts";

test("cut/tr qualification runners do not invoke a live host oracle", () => {
  for (const path of ["../scripts/test-own-shell-cut-tr.ts", "cut-tr.spec.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /node:child_process|spawnSync/);
  }
});

test("cut/tr qualification runners share the frozen matrix", () => {
  assert.equal(cutTrRecording().cases.length, 45);
  for (const path of ["../scripts/test-own-shell-cut-tr.ts", "cut-tr.spec.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /cutTrRecording\(\)/);
  }
});

test("cut/tr recordings reject missing, extra, reordered and changed scripts", () => {
  const changes: Array<(recording: typeof fixture) => void> = [
    (recording) => {
      recording.cases.pop();
    },
    (recording) => {
      recording.cases.push(recording.cases[0]);
    },
    (recording) => {
      recording.cases.reverse();
    },
    (recording) => {
      recording.cases[0].script += "; echo changed";
    },
  ];
  for (const change of changes) {
    const recording = structuredClone(fixture);
    change(recording);
    assert.throws(() => cutTrRecording(recording), /complete ordered matrix/);
  }
});

test("cut/tr recordings reject changed observations and oracle identities", () => {
  const changes: Array<(recording: typeof fixture) => void> = [
    (recording) => {
      recording.cases[0].status = 99;
    },
    (recording) => {
      recording.cases[0].stdoutBase64 = "AA==";
    },
    (recording) => {
      recording.cases[0].stderrPresent = true;
    },
    (recording) => {
      recording.oracle.bash.version = "5.3.20";
    },
    (recording) => {
      recording.oracle.cut.sha256 = "changed";
    },
    (recording) => {
      recording.oracle.tr.version = "changed";
    },
    (recording) => {
      recording.environment.LC_ALL = "C.UTF-8";
    },
  ];
  for (const change of changes) {
    const recording = structuredClone(fixture);
    change(recording);
    assert.throws(() => cutTrRecording(recording));
  }
});
