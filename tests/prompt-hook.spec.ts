import { test, type Page } from "./helpers/browser-test";
import { navigateTestPage } from "./helpers/navigate-test-page.ts";
import {
  compilePromptHookProof,
  promptHookBody,
  promptHookCostsBody,
} from "./helpers/prompt-hook-fixture";
import { checkPromptHookResult, recordPromptHookCosts } from "./helpers/prompt-hook-assertions";
import { OUTCOME_HANG_MS } from "./helpers/outcome-timeouts.ts";

async function prove(page: Page, body: string): Promise<unknown> {
  await navigateTestPage(page, "/test-fixture");
  const compiled = await compilePromptHookProof(body, OUTCOME_HANG_MS);
  await page.addScriptTag({ type: "module", content: compiled });
  await page.waitForFunction(() => "proof" in window);
  return page.evaluate(() => Reflect.get(window, "proof") as Promise<unknown>);
}

test("a prompt provider draws each prompt and redraws it in place", async ({ page }) => {
  const result = await prove(page, promptHookBody);
  checkPromptHookResult(result);
});

test("prompt hook costs", async ({ page }, testInfo) => {
  test.skip(!process.env.BASH_WEB_MEASURE, "set BASH_WEB_MEASURE=1 to measure");
  const result = await prove(page, promptHookCostsBody({ kind: "original" }));
  await recordPromptHookCosts(result, (name, options) => testInfo.attach(name, options));
});
