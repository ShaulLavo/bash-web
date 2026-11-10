import { cleanupStorage, isHostedPage, startPage } from "waffle/testing/page-runner/page";
import { pythonCaseInventory, type PythonRequest } from "./python-contract";

import type {} from "../../scripts/measure-python";

const lifetime = new AbortController();
if (typeof window !== "undefined") Reflect.set(window, "__pythonAdapterSignal", lifetime.signal);

async function pythonTeardown(request: PythonRequest) {
  lifetime.abort(new Error("Python case teardown"));
  await window.pythonAcceptance?.close();
  return { id: request.id, disposal: "pass" };
}

if (isHostedPage())
  startPage<PythonRequest>({
    list: async () => pythonCaseInventory.map((entry) => ({ ...entry })),
    run: { kind: "host", teardown: pythonTeardown },
    finish: cleanupStorage,
  });
