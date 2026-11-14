import { test, expect, type Page } from "../tests/helpers/browser-test.ts";
import { startupReady, ready } from "../tests/helpers/readiness.ts";
import { writeFileSync } from "node:fs";

type Hit = { lower: number; upper: number };
type Observation = {
  installed: number;
  commandStart: number | null;
  phaseStart: number | null;
  firstFinalPredicate: number | null;
  last: number;
  ticks: number;
  maxGap: number;
  maxReadMs: number;
  timerResolution: number;
  seenRunning: boolean;
  hits: Record<string, Hit>;
  timer: number;
};
declare global { interface Window { pipelineMeasurement: Observation } }

async function output(page: Page, text: string, final = false, timeout = 5000, invocationEpoch = 0) {
  await expect.poll(() => page.evaluate(({ final, invocationEpoch }) => {
    if (final && window.pipelineMeasurement.phaseStart === null) {
      window.pipelineMeasurement.phaseStart = invocationEpoch - performance.timeOrigin;
      window.pipelineMeasurement.firstFinalPredicate = performance.now();
    }
    return window.bashWeb?.readLines().map(line => line.trim());
  }, { final, invocationEpoch }), { timeout, intervals: final ? [10] : undefined }).toContain(text);
}

function installBrowserObserver() {
    const begin = performance.now();
    let resolution = 0;
    for (let i = 0; i < 10000 && resolution === 0; i++) resolution = performance.now() - begin;
    const value: Observation = {
      installed: performance.now(), commandStart: null, phaseStart: null, firstFinalPredicate: null,
      last: performance.now(), ticks: 0, maxGap: 0, maxReadMs: 0,
      timerResolution: resolution, seenRunning: false, hits: {}, timer: 0,
    };
    function sample() {
      const before = performance.now();
      const lines = window.bashWeb!.readLines().map(line => line.trim());
      const after = performance.now();
      value.maxGap = Math.max(value.maxGap, before - value.last);
      value.maxReadMs = Math.max(value.maxReadMs, after - before);
      value.ticks++;
      for (const marker of lines) {
        if (!/^(\$|READER_WAITING|WRITTEN:\d+|DRAINED:5242880:1|COUNT:2688895:400001)$/.test(marker)) continue;
        value.hits[marker] ??= { lower: value.last, upper: after };
      }
      if (value.commandStart !== null && window.bashWeb!.snapshot().state === "running") value.seenRunning = true;
      if (value.seenRunning && window.bashWeb!.snapshot().state === "ready")
        value.hits.READY ??= { lower: value.last, upper: after };
      value.last = before;
    }
    window.pipelineMeasurement = value;
    sample();
    value.timer = window.setInterval(sample, 10);
}

for (let sample = 1; sample <= 5; sample++) {
  test(`slow downstream completion sample ${sample}`, async ({ page, browser }, info) => {
    const caseNodeStart = performance.now();
    const evidence: Record<string, unknown> = { sample, kind: "drained", status: "started", browser: browser.version() };
    try {
      await page.goto("/?test=1&renderer=canvas&engine=own-shell");
      await startupReady(page);
      // The diagnostic watchdog stays inside the original total case bound.
      test.setTimeout(60000);
      expect(await page.evaluate(() => window.bashWeb?.snapshot().engine)).toBe("own-shell");
      const baseline = page.workers().length;
      evidence.baselineWorkers = baseline;
      await page.locator("textarea").focus();
      await page.evaluate(installBrowserObserver);
      const clockBefore = performance.timeOrigin + performance.now();
      const clockBrowser = await page.evaluate(() => performance.timeOrigin + performance.now());
      const clockAfter = performance.timeOrigin + performance.now();
      evidence.clockControl = { nodeBeforeEpoch: clockBefore, browserEpoch: clockBrowser, nodeAfterEpoch: clockAfter, roundTripMs: clockAfter - clockBefore };
      await page.evaluate(() => { window.pipelineMeasurement.commandStart = performance.now(); });
      const commandNodeStart = performance.now();
      await page.keyboard.insertText("test-guest produce 80 65536 97 | test-guest delayed-count 2000 DRAINED");
      await page.keyboard.press("Enter");
      await output(page, "READER_WAITING");
      await output(page, "WRITTEN:0");
      await page.waitForTimeout(200);
      const lines = await page.evaluate(() => window.bashWeb?.readLines().map(line => line.trim()));
      expect(lines).not.toContain("WRITTEN:79");
      expect(await page.evaluate(() => window.bashWeb?.snapshot().state)).toBe("running");
      const control = await page.evaluate(() => window.pipelineMeasurement);
      expect(control.hits.READER_WAITING).toBeDefined();
      expect(control.hits["WRITTEN:0"]).toBeDefined();
      expect(control.hits["DRAINED:5242880:1"]).toBeUndefined();
      evidence.earlyControl = { lines, observation: control, state: "running" };
      // Match the shipping final predicate and its fine sampling; record visibility independently.
      // Only this diagnostic wait can consume the remaining original case budget.
      const remaining = Math.max(1, 60000 - (performance.now() - caseNodeStart) - 6000);
      const finalNodeStart = performance.now();
      evidence.finalWaitInvocationEpoch = performance.timeOrigin + finalNodeStart;
      await output(page, "DRAINED:5242880:1", true, remaining, performance.timeOrigin + finalNodeStart);
      evidence.coarseFinalPollNodeMs = performance.now() - finalNodeStart;
      const completedLines = await page.evaluate(() => window.bashWeb?.readLines().map(line => line.trim()));
      expect(completedLines).toEqual(expect.arrayContaining(Array.from({ length: 80 }, (_, index) => `WRITTEN:${index}`)));
      await ready(page);
      await expect.poll(() => page.workers().length).toBe(baseline);
      evidence.commandThroughRetirementNodeMs = performance.now() - commandNodeStart;
      evidence.caseThroughRetirementNodeMs = performance.now() - caseNodeStart;
      evidence.completedLines = completedLines;
      evidence.finalWorkers = page.workers().length;
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.error = String(error);
      throw error;
    } finally {
      evidence.observation = await page.evaluate(() => {
        const value = window.pipelineMeasurement;
        if (value) window.clearInterval(value.timer);
        return { timing: value, snapshot: window.bashWeb?.snapshot(), runtime: window.bashWeb?.runtimeSnapshot(), lines: window.bashWeb?.readLines() };
      }).catch(error => ({ unavailable: String(error) }));
      writeFileSync(`measurement-output/drained-${sample}.json`, JSON.stringify(evidence, null, 2));
      await info.attach("measurement", { body: JSON.stringify(evidence), contentType: "application/json" });
    }
  });
}

for (let sample = 1; sample <= 5; sample++) {
  test(`builtin to builtin completion sample ${sample}`, async ({ page, browser }, info) => {
    const caseNodeStart = performance.now();
    const evidence: Record<string, unknown> = { sample, kind: "count", status: "started", browser: browser.version() };
    try {
      await page.goto("/?test=1&renderer=canvas&engine=own-shell");
      await startupReady(page);
      expect(await page.evaluate(() => window.bashWeb?.snapshot().engine)).toBe("own-shell");
      const baseline = page.workers().length;
      evidence.baselineWorkers = baseline;
      await page.locator("textarea").focus();
      await page.evaluate(installBrowserObserver);
      const clockBefore = performance.timeOrigin + performance.now();
      const clockBrowser = await page.evaluate(() => performance.timeOrigin + performance.now());
      const clockAfter = performance.timeOrigin + performance.now();
      evidence.clockControl = { nodeBeforeEpoch: clockBefore, browserEpoch: clockBrowser, nodeAfterEpoch: clockAfter, roundTripMs: clockAfter - clockBefore };
      const control = await page.evaluate(() => window.pipelineMeasurement);
      expect(control.hits["$"]).toBeDefined();
      evidence.observerControl = control;
      await page.evaluate(() => { window.pipelineMeasurement.commandStart = performance.now(); });
      const commandNodeStart = performance.now();
      await page.keyboard.insertText("seq 1 400000 | cat > complete; test-guest count complete");
      await page.keyboard.press("Enter");
      const remaining = Math.max(1, 60000 - (performance.now() - caseNodeStart) - 6000);
      const finalNodeStart = performance.now();
      evidence.finalWaitInvocationEpoch = performance.timeOrigin + finalNodeStart;
      await output(page, "COUNT:2688895:400001", true, remaining, performance.timeOrigin + finalNodeStart);
      evidence.finalPollNodeMs = performance.now() - finalNodeStart;
      await ready(page);
      await expect.poll(() => page.workers().length).toBe(baseline);
      evidence.commandThroughRetirementNodeMs = performance.now() - commandNodeStart;
      evidence.caseThroughRetirementNodeMs = performance.now() - caseNodeStart;
      evidence.finalWorkers = page.workers().length;
      evidence.status = "passed";
    } catch (error) {
      evidence.status = "failed";
      evidence.error = String(error);
      throw error;
    } finally {
      evidence.observation = await page.evaluate(() => {
        const value = window.pipelineMeasurement;
        if (value) window.clearInterval(value.timer);
        return { timing: value, snapshot: window.bashWeb?.snapshot(), runtime: window.bashWeb?.runtimeSnapshot(), lines: window.bashWeb?.readLines() };
      }).catch(error => ({ unavailable: String(error) }));
      writeFileSync(`measurement-output/count-${sample}.json`, JSON.stringify(evidence, null, 2));
      await info.attach("measurement", { body: JSON.stringify(evidence), contentType: "application/json" });
    }
  });
}
