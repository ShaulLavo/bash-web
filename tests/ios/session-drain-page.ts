import {
  isHostedPage,
  startPage,
  type HostPageRun,
  type HostVerdict,
  type PageSuite,
} from "waffle/testing/page-runner/page";
import { record, sessionDrainIds, type SessionDrainRequest } from "./session-drain-support";

const pageErrors: string[] = [];

async function originalAfterEach(): Promise<void> {
  const session: unknown = Reflect.get(window, "sessionDrain");
  if (session === undefined || session === null) return;
  if (!record(session) || typeof session.dispose !== "function")
    throw new Error("Session drain fixture has no dispose function");
  await session.dispose();
}

function startupSnapshot(): unknown {
  try {
    const api: unknown = Reflect.get(window, "bashWeb");
    if (!record(api) || typeof api.snapshot !== "function") return undefined;
    return api.snapshot();
  } catch {
    return undefined;
  }
}

function pendingStartup(snapshot: unknown): string {
  if (!snapshot) return "snapshot unavailable";
  if (!record(snapshot) || !record(snapshot.startup) || !Array.isArray(snapshot.startup.pending))
    throw new Error("Invalid browser startup snapshot");
  const pending: unknown[] = snapshot.startup.pending;
  if (!pending.every((item) => typeof item === "string"))
    throw new Error("Invalid pending browser startup entries");
  return pending.join(", ") || "none observed";
}

function failureDiagnostics() {
  const snapshot = startupSnapshot();
  const body = JSON.stringify(snapshot ?? { unavailable: true }, null, 2);
  const pending = pendingStartup(snapshot);
  console.error("Pending browser startup awaits", pending);
  console.error("Browser startup diagnostics", body);
  return {
    name: "browser-startup-diagnostics",
    contentType: "application/json",
    body,
    logs: [
      ["Pending browser startup awaits", pending],
      ["Browser startup diagnostics", body],
    ],
  };
}

export async function sessionDrainTeardown(request: SessionDrainRequest, verdict: HostVerdict) {
  let disposalError: string | undefined;
  try {
    await originalAfterEach();
  } catch (error) {
    disposalError = String(error);
  }
  let diagnosticError: string | undefined;
  let attachments: ReturnType<typeof failureDiagnostics>[] = [];
  try {
    if (verdict.status === "fail" || disposalError !== undefined || pageErrors.length > 0)
      attachments = [failureDiagnostics()];
  } catch (error) {
    diagnosticError = String(error);
  }
  const result = {
    id: request.id,
    afterEach: disposalError === undefined ? "pass" : "fail",
    pageErrors: pageErrors.slice(),
    attachments,
  };
  if (disposalError !== undefined || diagnosticError !== undefined)
    throw new Error(JSON.stringify({ ...result, disposalError, diagnosticError }));
  return result;
}

export const sessionDrainPageRun: HostPageRun<SessionDrainRequest> = {
  kind: "host",
  teardown: sessionDrainTeardown,
};

export const sessionDrainPage: PageSuite<SessionDrainRequest> = {
  async list() {
    return { ids: sessionDrainIds.slice() };
  },
  run: sessionDrainPageRun,
  async finish(ledger) {
    return ledger.slice();
  },
};

export function sessionDrainPageError(event: Pick<ErrorEvent, "message">): void {
  pageErrors.push(event.message);
  console.error(event.message);
}

function sessionDrainPageRejection(event: PromiseRejectionEvent): void {
  const reason: unknown = event.reason;
  const message =
    record(reason) && typeof reason.message === "string" ? reason.message : String(reason);
  sessionDrainPageError({ message });
}

if (isHostedPage()) {
  window.addEventListener("error", sessionDrainPageError);
  window.addEventListener("unhandledrejection", sessionDrainPageRejection);
  startPage(sessionDrainPage);
}
