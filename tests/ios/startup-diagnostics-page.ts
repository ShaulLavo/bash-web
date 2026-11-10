import { cleanupStorage, isHostedPage, startPage } from "waffle/testing/page-runner/page";
import type { HostVerdict } from "waffle/testing/page-runner/page";
import { promptStatusDiagnostics } from "./prompt-status-diagnostics";

declare const __startupLabels: readonly string[];

export interface StartupRequest {
  id: string;
}

async function disposeDemo(): Promise<void> {
  const access: unknown = Reflect.get(window, "bashWeb");
  if (access === undefined) return;
  if (access === null || typeof access !== "object") throw new Error("Invalid demo access");
  const dispose: unknown = Reflect.get(access, "dispose");
  if (typeof dispose !== "function") throw new Error("Missing demo disposal");
  await Reflect.apply(dispose, access, []);
}

export async function startupTeardown(_request: StartupRequest, verdict: HostVerdict) {
  const diagnostic = await promptStatusDiagnostics(verdict);
  try {
    await disposeDemo();
    return { diagnostic, disposal: { status: "pass" } };
  } catch (error) {
    return { diagnostic, disposal: { status: "fail", error: String(error) } };
  }
}

if (isHostedPage())
  startPage<StartupRequest>({
    list: async () => __startupLabels.slice(),
    run: { kind: "host", teardown: startupTeardown },
    finish: cleanupStorage,
  });
