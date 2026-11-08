import { cleanupStorage, isHostedPage, startPage } from "waffle/testing/page-runner/page";
import type { HostVerdict } from "waffle/testing/page-runner/page";
import { promptStatusDiagnostics } from "./prompt-status-diagnostics";

export interface StartupRequest {
  id: string;
  labels: string[];
}

export async function startupTeardown(_request: StartupRequest, verdict: HostVerdict) {
  const diagnostic = await promptStatusDiagnostics(verdict);
  await window.bashWeb?.dispose();
  return { diagnostic, disposed: true };
}

if (isHostedPage())
  startPage<StartupRequest>({
    list: async () => {
      const response = await fetch("/startup-inventory.json");
      if (!response.ok) throw new Error("Startup inventory was not served");
      return response.json();
    },
    run: { kind: "host", teardown: startupTeardown },
    finish: cleanupStorage,
  });
