import { test, type Page } from "./helpers/browser-test";
import {
  compilePromptHookProof,
  promptHookBody,
  promptHookCostsBody,
} from "./helpers/prompt-hook-fixture";
import { checkPromptHookResult, recordPromptHookCosts } from "./helpers/prompt-hook-assertions";

async function prove(page: Page, name: string, body: string): Promise<unknown> {
  await page.route(`**/${name}`, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
      body: "<!doctype html><title>Prompt hook</title>",
    }),
  );
  await page.goto(`/${name}`);
  const compiled = await compilePromptHookProof(body);
  await page.addScriptTag({ type: "module", content: compiled });
  await page.waitForFunction(() => "proof" in window);
  return page.evaluate(() => Reflect.get(window, "proof") as Promise<unknown>);
}

test("a prompt provider draws each prompt and redraws it in place", async ({ page }) => {
  const result = await prove(page, "prompt-hook-fixture", promptHookBody);
  checkPromptHookResult(result);
});

test("prompt hook costs", async ({ page }, testInfo) => {
  test.skip(!process.env.BASH_WEB_MEASURE, "set BASH_WEB_MEASURE=1 to measure");
  const result = await prove(page, "prompt-hook-costs", promptHookCostsBody({ kind: "original" }));
  await recordPromptHookCosts(result, (name, options) => testInfo.attach(name, options));
});
