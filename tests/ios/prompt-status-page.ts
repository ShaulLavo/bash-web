import { startPage } from "waffle/testing/page-runner/page";
import { promptStatusCase, type PromptStatusRequest } from "./prompt-status-contract.ts";
import { promptStatusDiagnostics } from "./prompt-status-diagnostics.ts";

startPage<PromptStatusRequest>({
  list: async () => [promptStatusCase],
  run: {
    kind: "host",
    teardown: async (_request, body) => promptStatusDiagnostics(body),
  },
  finish: async (ledger) => ledger.slice(),
});
