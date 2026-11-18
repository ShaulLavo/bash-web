import type { Page, Response, Route } from "@playwright/test";

export type NavigationPage = Pick<Page, "goto" | "route" | "unroute"> & {
  context(): { browser(): { browserType(): { name(): string } } | null };
};

/** True for a request to `target`: an absolute URL, or a path and query on the test server. */
export function navigationMatcher(target: string): (candidate: URL) => boolean {
  const relative = target.startsWith("/");
  const url = new URL(target, "http://test.invalid");
  url.hash = "";
  const expected = relative ? url.pathname + url.search : url.href;
  return (candidate) =>
    (relative ? candidate.pathname + candidate.search : candidate.href) === expected;
}

/**
 * `page.goto` for the cross-origin-isolated test pages. Use it for every navigation that can run
 * in WebKit.
 *
 * WebKit bug 325840: a COOP response can overtake the old web process's load-start IPC, and
 * WebKit then cancels its own process-swapped navigation. Playwright misses that cancellation,
 * so goto waits on about:blank until its timeout. A pass-through route for the document URL,
 * removed after goto, makes Playwright intercept the document request, which admits that IPC
 * before the real request continues. Same workaround as Waffle's tests/browser-navigation.ts and
 * bun-wasm's web/tests/navigate-test-page.ts. Remove when Playwright ships
 * https://github.com/WebKit/WebKit/pull/75569.
 *
 * No `times: 1`: in Playwright 1.64.1, an expiring page route that falls back to a context route
 * makes that context handler's `route.continue()` reject with "Route is already handled!". The
 * exact-URL matcher and the removal below bound the route instead.
 */
export async function navigateTestPage(
  page: NavigationPage,
  target: string,
  options?: Parameters<Page["goto"]>[1],
): Promise<Response | null> {
  if (page.context().browser()?.browserType().name() !== "webkit" || !/^(https?:|\/)/.test(target))
    return page.goto(target, options);
  const matches = navigationMatcher(target);
  const resume = (route: Route) => route.fallback();
  await page.route(matches, resume);
  try {
    return await page.goto(target, options);
  } finally {
    await page.unroute(matches, resume).catch(() => {});
  }
}
