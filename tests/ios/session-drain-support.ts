export const sessionDrainInventory = [
  { id: "D01", label: "an idle session has no repeated drain turns" },
  { id: "D02", label: "worker output and phase-only changes wake a settled session" },
  { id: "D03", label: "full-ring paste resumes through receive without output" },
  { id: "D04", label: "full-ring paste resumes through consume without output" },
  { id: "D05", label: "burst output coalesces and each delivery stays bounded" },
  {
    id: "D06",
    label: "a completed output drain waits for new activity without an empty follow-up turn",
  },
  {
    id: "D07",
    label: "input capacity and phase published during a drain are handled before waiting",
  },
  { id: "D08", label: "exit retains final output larger than one drain" },
  { id: "D09", label: "fail retains final output larger than one drain" },
  { id: "D10", label: "dispose suppresses pending wake callbacks" },
  { id: "D11", label: "publication between sampling and wait subscription is not missed" },
  { id: "D12", label: "interrupt clears a full paste after a contended reader unlocks" },
];

export type SessionDrainRequest = { id: string };
export const sessionDrainIds = sessionDrainInventory.map((item) => item.id);
export const sessionDrainFixturePath = "/session-drain-fixture.js";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a finite number from the page");
  return value;
}

export function selectSessionDrainDiagnostic(result: unknown): unknown {
  if (!record(result) || result.afterEach !== "pass" || !Array.isArray(result.attachments))
    throw new Error("Missing completed session drain teardown envelope");
  if (result.attachments.length > 1)
    throw new Error("Unexpected session drain diagnostic attachment inventory");
  return result.attachments[0] ?? null;
}
