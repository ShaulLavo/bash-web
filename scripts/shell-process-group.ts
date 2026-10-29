// An owned process group must stop consuming scratch before its owner removes it.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

function hasErrorCode(error: unknown, codes: readonly string[]): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return typeof error.code === "string" && codes.includes(error.code);
}

export function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!hasErrorCode(error, ["ESRCH"])) throw error;
  }
}

export async function drainGroup(pid: number | undefined) {
  if (!pid) return;
  killGroup(pid, "SIGKILL");
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (hasErrorCode(error, ["ESRCH"])) return;
      throw error;
    }
    // Orphaned zombies cannot consume scratch, but live descendants can.
    const processes = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const active = await Promise.all(
      processes.map(async (name) => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          return fields[2] === String(pid) && !["Z", "X"].includes(fields[0]);
        } catch (error) {
          if (hasErrorCode(error, ["ENOENT", "ESRCH", "EACCES"])) return false;
          throw error;
        }
      }),
    );
    if (!active.some(Boolean)) return;
    assert.ok(Date.now() < deadline, `process group ${pid} did not stop`);
    await delay(20);
  }
}
