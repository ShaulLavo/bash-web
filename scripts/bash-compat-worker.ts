import { parentPort, workerData } from "node:worker_threads";
import { createWaffleRunner } from "./waffle-compat.ts";
import type { WaffleCaseOptions } from "./waffle-compat.ts";

interface WorkerRequest {
  id: number;
  code: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Invalid worker ${key}`);
  return value;
}

function parseEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Invalid worker env");
  return Object.fromEntries(
    Object.entries(value).map(([key, value]) => [key, requiredString({ value }, "value")]),
  );
}

function parseWorkerData(value: unknown): WaffleCaseOptions {
  if (!isRecord(value)) throw new Error("Invalid compatibility worker data");
  if (value.engine !== "own-shell") throw new Error(`Unknown compatibility engine: ${value.engine}`);
  const utilityDirectory = value.utilityDirectory;
  const programs = value.programs;
  const installPrograms = value.installPrograms;
  if (utilityDirectory !== undefined && typeof utilityDirectory !== "string")
    throw new Error("Invalid worker utilityDirectory");
  if (installPrograms !== undefined && typeof installPrograms !== "boolean")
    throw new Error("Invalid worker installPrograms");
  if (programs !== undefined && !Array.isArray(programs)) throw new Error("Invalid worker programs");
  return {
    modulePath: requiredString(value, "modulePath"),
    fixtureDirectory: requiredString(value, "fixtureDirectory"),
    tmp: requiredString(value, "tmp"),
    env: parseEnvironment(value.env),
    utilityDirectory,
    installPrograms,
    programs: programs?.map((program) => requiredString({ program }, "program")),
  };
}

function parseRequest(value: unknown): WorkerRequest {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.code !== "string")
    throw new Error("Invalid compatibility worker request");
  return { id: value.id, code: value.code };
}

function thrownMessage(error: unknown): string {
  if (isRecord(error) && "message" in error) return String(error.message);
  return String(error);
}

if (!parentPort) throw new Error("Compatibility worker requires a parent port");
const run = await createWaffleRunner(parseWorkerData(workerData));
parentPort.on("message", async (value: unknown) => {
  const { id, code } = parseRequest(value);
  try {
    parentPort.postMessage({ id, ...(await run(code)) });
  } catch (error) {
    parentPort.postMessage({
      id,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      crash: thrownMessage(error),
    });
  }
});
parentPort.postMessage({ ready: true });
