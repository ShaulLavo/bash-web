import { test, expect, type Page } from "./helpers/browser-test";
import { command } from "./helpers/shell-browser.ts";
import { ready, prepareOwnShell } from "./helpers/readiness.ts";

// iOS Safari's Worker.terminate() does not stop a worker running Wasm. These tests turn
// terminate() into a no-op, so a killed guest stops only by polling Waffle's stop check.
// A worker whose thread runs a Playwright evaluation is not running guest code.
interface StopRecord {
  readonly id: number;
  readonly messages: string[];
  terminated: number;
}
declare global {
  interface Window {
    stopRecords: StopRecord[];
  }
}

function installInertTerminate() {
  const records: StopRecord[] = [];
  window.stopRecords = records;
  window.Worker = class extends window.Worker {
    private readonly record: StopRecord;
    constructor(url: string | URL, options?: WorkerOptions) {
      const record: StopRecord = { id: records.length, messages: [], terminated: 0 };
      super(`${String(url)}#stop-record=${record.id}`, options);
      records.push(record);
      this.record = record;
      this.addEventListener("message", (event: MessageEvent<unknown>) => {
        const data = event.data;
        record.messages.push(
          data && typeof data === "object" && "type" in data ? String(data.type) : typeof data,
        );
      });
    }
    override terminate() {
      this.record.terminated++;
    }
  };
}

async function lines(page: Page) {
  return page.evaluate(() => window.bashWeb?.readLines().map((line) => line.trim()) ?? []);
}
async function output(page: Page, expected: string) {
  await expect.poll(() => lines(page)).toContain(expected);
}
const records = (page: Page) => page.evaluate(() => window.stopRecords);

async function open(page: Page) {
  await page.addInitScript(installInertTerminate);
  await prepareOwnShell(page);
  await page.locator("textarea").focus();
}

/** True when the worker's thread is free to run a task within a second. */
async function idle(page: Page, id: number) {
  const worker = page.workers().find((each) => each.url().endsWith(`#stop-record=${id}`));
  if (!worker) return false;
  const answered = worker.evaluate(() => true).catch(() => false);
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000));
  return Promise.race([answered, late]);
}

/** Every worker the runtime tried to terminate must stop on its own, then stay silent. */
async function expectStopped(page: Page, from = 0) {
  const stopped = (await records(page)).slice(from).filter((row) => row.terminated > 0);
  expect(stopped.length).toBeGreaterThan(0);
  const busy = async () => {
    const answers = await Promise.all(stopped.map((row) => idle(page, row.id)));
    return stopped.filter((_, index) => !answers[index]).map((row) => row.id);
  };
  await expect.poll(busy).toEqual([]);
  const count = async () => (await records(page)).map((row) => row.messages.length);
  const settled = await count();
  await page.waitForTimeout(250);
  expect(await count()).toEqual(settled);
}

/** Starts `script` in a child shell, waits until it runs, kills it with `signal`. */
async function killRunning(page: Page, name: string, script: string, signal: string) {
  const before = (await records(page)).length;
  const marker = `/tmp/${name}-ready`;
  const body = `printf go > ${marker}; ${script}`.replaceAll("'", "'\\''");
  await command(
    page,
    `/bin/bash -c '${body}' & while [[ ! -f ${marker} ]]; do :; done; kill -${signal} $!; wait $!; echo ${name}:$?`,
  );
  return before;
}

const childLoops: readonly [string, string][] = [
  ["while", "while :; do :; done"],
  ["until", "until false; do :; done"],
  ["for", "for ((;;)); do :; done"],
  ["forin", "for x in 1; do while :; do :; done; done"],
  ["function", "f() { while :; do :; done; }; f"],
  ["subshell", "( while :; do :; done )"],
  ["background", "while :; do :; done & wait"],
  ["substitution", "x=$(while :; do :; done)"],
  ["pipeline", "while :; do :; done | while :; do :; done"],
  ["printf", "while :; do printf -v x '%0100000d' 0; done"],
  ["pattern", "s=$(printf '%05000d' 0); while :; do [[ $s == *0*0*0*1 ]]; done"],
  ["brace", "while :; do x=({1..20000}); done"],
  ["read", "read -r x < <(while :; do :; done)"],
];

for (const [name, script] of childLoops)
  test(`a killed child shell busy in ${name} stops without Worker.terminate`, async ({ page }) => {
    await open(page);
    const before = await killRunning(page, name, script, "KILL");
    await output(page, `${name}:137`);
    await expectStopped(page, before);
    await ready(page);
  });

for (const [signal, status] of [
  ["TERM", 143],
  ["INT", 130],
] as const)
  test(`SIG${signal} keeps its default action in a busy child loop`, async ({ page }) => {
    await open(page);
    const name = signal.toLowerCase();
    const before = await killRunning(page, name, "while :; do :; done", signal);
    await output(page, `${name}:${status}`);
    await expectStopped(page, before);
    await ready(page);
  });

const rootLoops: readonly [string, string][] = [
  ["foreground", "while :; do :; done"],
  ["foreground pipeline", "while :; do :; done | while :; do :; done"],
  ["background", "while :; do :; done &"],
  ["background subshell", "( while :; do :; done ) &"],
  ["background pipeline", "while :; do :; done | while :; do :; done &"],
];

for (const [name, source] of rootLoops)
  test(`disposing a shell busy in a ${name} loop stops its guest`, async ({ page }) => {
    await open(page);
    await command(page, source);
    if (name.startsWith("foreground"))
      await expect
        .poll(() => page.evaluate(() => window.bashWeb?.snapshot().state))
        .toBe("running");
    else await ready(page);
    await page.evaluate(() => window.bashWeb?.dispose());
    await expectStopped(page);
  });
