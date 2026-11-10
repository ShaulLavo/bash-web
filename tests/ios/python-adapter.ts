import { expect } from "@playwright/test";
import { isAbsolute, resolve } from "node:path";
import type { HostCase, SuiteAdapter, SuiteCase } from "waffle/testing/page-runner";
import { pythonHostedPage, pythonHostAssets } from "./python-bootstrap";
import { pythonCaseInventory, type PythonRequest } from "./python-contract";
import { PythonMeasurement } from "./python-measurement";
import { originalPythonCases } from "./python-original";
import { PythonPage } from "./python-page";

type Original = Awaited<ReturnType<typeof originalPythonCases>>[number];
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function drive(original: Original, host: HostCase, resultPath: string) {
  const page = new PythonPage(host);
  const info = new PythonMeasurement(resultPath, original.id);
  const [body] = await Promise.allSettled([original.run(page, info, () => page.refreshWorkers())]);
  const [stopped] = await Promise.allSettled([page.disposeRequests()]);
  if (body.status === "rejected" && stopped.status === "rejected")
    throw new AggregateError(
      [body.reason, stopped.reason],
      "Python body and request teardown failed",
    );
  if (body.status === "rejected") throw body.reason;
  if (stopped.status === "rejected") throw stopped.reason;
  return { id: original.id, assertions: "pass", attachments: info.attachments };
}

export async function createPythonAdapter(
  resultPath: string,
): Promise<SuiteAdapter<PythonRequest>> {
  if (!isAbsolute(resultPath)) throw new Error("Python adapter requires an absolute result path");
  const originals = await originalPythonCases();
  const inventory = originals.map((original): SuiteCase<PythonRequest> => ({
    id: original.id,
    label: original.label,
    request: () => ({ id: original.id }),
    observation: "workers-and-requests",
    drive: (host) => drive(original, host, resultPath),
  }));
  return {
    suite: "bash-python",
    page: pythonHostedPage,
    inventory: () => inventory,
    assets: pythonHostAssets,
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 60_000,
      teardown: 60_000,
      caseDocument: 150_000,
      group: 150_000,
      run: 600_000,
    }),
    policy: {
      requireResult: true,
      listIds(value) {
        expect(value).toEqual(pythonCaseInventory);
        return pythonCaseInventory.map((entry) => entry.id);
      },
      allocation() {
        throw new Error("Original Python fixture must stay memory-only");
      },
      check(id, value) {
        if (!record(value) || !record(value.body) || !record(value.teardown))
          throw new Error("Missing complete Python body and teardown result");
        expect(value.body.status).toBe("pass");
        expect(value.body.result).toMatchObject({ id, assertions: "pass" });
        if (!record(value.body.result) || !Array.isArray(value.body.result.attachments))
          throw new Error("Missing Python file delivery metadata");
        expect(value.body.result.attachments).toHaveLength(id === "PY01" ? 1 : 0);
        if (id === "PY01")
          expect(value.body.result.attachments[0]).toMatchObject({
            name: "python-measurement",
            contentType: "application/json",
            path: resolve(`${resultPath}.artifacts`, id, "python-measurement-report.json"),
          });
        expect(value.teardown.status).toBe("pass");
        expect(value.teardown.result).toEqual({ id, disposal: "pass" });
      },
    },
  };
}
