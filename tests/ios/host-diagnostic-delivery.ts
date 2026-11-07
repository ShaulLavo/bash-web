import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { nativeMain, writeResult, type SuiteAdapter } from "waffle/testing/page-runner";

export interface HostAttachment {
  caseId: string;
  name: string;
  body: string;
  contentType: string;
}
type Sink = typeof writeResult;
type Emit = (label: string, detail: string) => void;
type DescriptorSelector = (teardownResult: unknown) => unknown;
interface DeliveryOptions {
  selectDescriptor: DescriptorSelector;
  write?: Sink;
  emit?: Emit;
}
interface CaseDelivery {
  caseId: string;
  status: "delivered" | "not-returned" | "failed";
  emitted: number;
  written: boolean;
  detail?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function attachment(value: unknown): value is HostAttachment {
  return (
    record(value) &&
    typeof value.caseId === "string" &&
    typeof value.name === "string" &&
    typeof value.body === "string" &&
    typeof value.contentType === "string"
  );
}
async function existingAttachments(path: string): Promise<HostAttachment[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(source);
  if (!record(value) || !Array.isArray(value.attachments) || !value.attachments.every(attachment))
    throw new Error("Invalid existing host attachment container");
  return value.attachments;
}

export async function appendHostAttachments(
  resultPath: string,
  entries: readonly HostAttachment[],
  write: Sink = writeResult,
): Promise<void> {
  if (!isAbsolute(resultPath)) throw new Error("Host attachments require an absolute result path");
  const path = `${resultPath}.attachments.json`;
  const existing = await existingAttachments(path);
  await write(path, { attachments: existing.concat(entries) });
}

function pendingText(body: string): string {
  const snapshot: unknown = JSON.parse(body);
  if (!snapshot || (record(snapshot) && snapshot.unavailable === true))
    return "snapshot unavailable";
  if (!record(snapshot) || !record(snapshot.startup))
    throw new Error("Invalid diagnostic snapshot");
  const pending = snapshot.startup.pending;
  if (!Array.isArray(pending) || !pending.every((item: unknown) => typeof item === "string"))
    throw new Error("Invalid diagnostic pending list");
  return pending.join(", ") || "none observed";
}

function descriptor(value: unknown) {
  if (
    !record(value) ||
    value.name !== "browser-startup-diagnostics" ||
    typeof value.body !== "string" ||
    value.contentType !== "application/json"
  )
    throw new Error("Invalid browser-startup-diagnostics descriptor");
  return { name: value.name, body: value.body, contentType: value.contentType };
}

type SettledDescriptor = { kind: "missing"; detail: string } | { kind: "returned"; value: unknown };
function settledDescriptor(results: Record<string, unknown>, caseId: string): SettledDescriptor {
  const result = results[caseId];
  if (!record(result) || !record(result.teardown))
    return { kind: "missing", detail: "Teardown result not returned" };
  if (result.teardown.status !== "pass")
    return { kind: "missing", detail: `Teardown ${String(result.teardown.status)}` };
  const value = result.teardown.result;
  if (value === null || value === undefined)
    return { kind: "missing", detail: "No diagnostic descriptor returned" };
  return { kind: "returned", value };
}

async function deliverCase(
  resultPath: string,
  results: Record<string, unknown>,
  caseId: string,
  write: Sink,
  emit: Emit,
  selectDescriptor: DescriptorSelector,
): Promise<CaseDelivery> {
  const settled = settledDescriptor(results, caseId);
  if (settled.kind === "missing")
    return { caseId, status: "not-returned", emitted: 0, written: false, detail: settled.detail };
  let emitted = 0;
  try {
    const selected = selectDescriptor(settled.value);
    if (selected === undefined || selected === null)
      return {
        caseId,
        status: "not-returned",
        emitted: 0,
        written: false,
        detail: "No diagnostic descriptor selected",
      };
    const returned = descriptor(selected);
    const pending = pendingText(returned.body);
    emit("Pending browser startup awaits", pending);
    emitted++;
    emit("Browser startup diagnostics", returned.body);
    emitted++;
    await appendHostAttachments(resultPath, [{ caseId, ...returned }], write);
    return { caseId, status: "delivered", emitted, written: true };
  } catch (error) {
    return { caseId, status: "failed", emitted, written: false, detail: String(error) };
  }
}

export async function finalizeHostDiagnostics(
  resultPath: string,
  originalExit: number,
  options: DeliveryOptions,
): Promise<number> {
  const write = options.write ?? writeResult;
  const emit = options.emit ?? ((label, detail) => console.error(label, detail));
  const cases: CaseDelivery[] = [];
  const failures: string[] = [];
  let kind: "suite" | "precondition" | "unreadable" = "suite";
  try {
    const result: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    if (!record(result)) throw new Error("Invalid persisted result");
    if (result.exit === 3 && typeof result.precondition === "string" && !("selected" in result)) {
      kind = "precondition";
    } else {
      if (
        !Array.isArray(result.selected) ||
        !result.selected.every((id: unknown) => typeof id === "string") ||
        !record(result.results)
      )
        throw new Error("Missing persisted suite results");
      for (const caseId of result.selected)
        cases.push(
          await deliverCase(
            resultPath,
            result.results,
            caseId,
            write,
            emit,
            options.selectDescriptor,
          ),
        );
    }
  } catch (error) {
    kind = "unreadable";
    failures.push(String(error));
  }
  const failed = failures.length > 0 || cases.some((item) => item.status === "failed");
  const exit = originalExit === 0 && failed ? 2 : originalExit;
  try {
    await write(`${resultPath}.diagnostic-delivery.json`, {
      originalExit,
      exit,
      kind,
      cases,
      failures,
    });
    return exit;
  } catch (error) {
    try {
      emit("Host diagnostic delivery receipt failed", String(error));
    } catch {
      console.error("Host diagnostic delivery receipt failed", String(error));
    }
    return originalExit === 0 ? 2 : originalExit;
  }
}

export async function nativeMainWithDiagnostics<R>(
  adapter: SuiteAdapter<R>,
  args: string[],
  selectDescriptor: DescriptorSelector,
): Promise<number> {
  const exit = await nativeMain(adapter, args);
  const path = args[1];
  if (args.length !== 2 || args[0] !== "--result" || !path || !isAbsolute(path)) return exit;
  return finalizeHostDiagnostics(path, exit, { selectDescriptor });
}
