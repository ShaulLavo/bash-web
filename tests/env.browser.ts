import { test, expect } from "./helpers/browser-test";

for (const [script, stdout] of [
  ["env -i", ""],
  ["env -i A=one B=two", "A=one\nB=two\n"],
  ["env -i -0 A=one B=two", "A=one\0B=two\0"],
  ["env -i A=first A=last EMPTY= C=x=y", "A=last\nEMPTY=\nC=x=y\n"],
  ["env -i -S 'A=one B=\"two words\"'", "A=one\nB=two words\n"],
  ["env -u A -i A=new; printf 'parent:%s' \"$A\"", "A=new\nparent:old"],
] satisfies [string, string][]) {
  test(`env browser print contract: ${script}`, async ({ page }) => {
    await page.goto("/env-tests.html");
    await page.waitForFunction(() => Boolean(window.envTests));
    expect(await page.evaluate((script) => window.envTests.check(script), script)).toEqual({
      status: 0,
      stdout,
      stderr: "",
    });
    await expect.poll(() => page.workers().length).toBe(0);
  });
}

test("env preserves lazy loading and leaves the caller runtime usable after uninstall", async ({
  page,
}) => {
  await page.goto("/env-tests.html");
  await page.waitForFunction(() => Boolean(window.envTests));
  expect(await page.evaluate(() => window.envTests.lifecycle())).toEqual({
    before: [],
    after: ["env"],
    first: { status: 0, stdout: "A=one\n", stderr: "" },
    second: { status: 0, stdout: "B=two\0", stderr: "" },
    ownerAlive: "alive",
    removed: true,
  });
  await expect.poll(() => page.workers().length).toBe(0);
});

for (const [script, status, stdout] of [
  ["env -i env -i 'A=two words' EMPTY=", 0, "A=two words\nEMPTY=\n"],
  ["env -i A=old env -u A B=new /usr/bin/env", 0, "B=new\n"],
  ["env -i -C /tmp -a custom env -i A=changed; printf '%s' \"$A\"", 0, "A=changed\nold"],
  ["env missing-command", 127, ""],
  ["env /bin/env -0 command", 125, ""],
] satisfies [string, number, string][]) {
  test(`env browser command: ${script}`, async ({ page }) => {
    await page.goto("/env-tests.html");
    await page.waitForFunction(() => Boolean(window.envTests));
    const result = await page.evaluate((script) => window.envTests.check(script), script);
    expect(result.status).toBe(status);
    expect(result.stdout).toBe(stdout);
    await expect.poll(() => page.workers().length).toBe(0);
  });
}

for (const mode of [
  "-0",
  "--ignore-signal=INT",
  "--default-signal",
  "--block-signal=PIPE",
  "--list-signal-handling",
]) {
  test(`env rejects unsupported mode ${mode} before consuming shared input`, async ({ page }) => {
    await page.goto("/env-tests.html");
    await page.waitForFunction(() => Boolean(window.envTests));
    const result = await page.evaluate(
      (mode) =>
        window.envTests.check(
          `printf 'unconsumed\\n' >/input; { env ${mode} probe; status=$?; IFS= read -r line; printf '%s:%s' "$status" "$line"; } </input`,
        ),
      mode,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("125:unconsumed");
    expect(result.stderr.length).toBeGreaterThan(0);
    await expect.poll(() => page.workers().length).toBe(0);
  });
}
