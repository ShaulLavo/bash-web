import { cleanupStorage, startPage } from "waffle/testing/page-runner/page";
import { promptHookCases, type PromptHookRequest } from "./prompt-hook-contract.ts";
import { promptStatusDiagnostics } from "./prompt-status-diagnostics.ts";

startPage<PromptHookRequest>({
  list: async () => promptHookCases.slice(),
  run: {
    kind: "host",
    teardown: async (_request, body) => promptStatusDiagnostics(body),
  },
  finish: (ledger) => cleanupStorage(ledger),
});
