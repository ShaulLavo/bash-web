import type { HostVerdict } from "waffle/testing/page-runner/page";

async function snapshotBrowserStartup(): Promise<unknown> {
  try {
    const access: unknown = Reflect.get(window, "bashWeb");
    if (!access || typeof access !== "object") return undefined;
    const snapshot: unknown = Reflect.get(access, "snapshot");
    if (typeof snapshot !== "function") return undefined;
    return await Reflect.apply(snapshot, access, []);
  } catch {
    return undefined;
  }
}

function pendingAwaits(snapshot: unknown): string {
  if (!snapshot) return "snapshot unavailable";
  if (typeof snapshot !== "object") throw new Error("Invalid startup snapshot");
  const startup: unknown = Reflect.get(snapshot, "startup");
  if (!startup || typeof startup !== "object") throw new Error("Invalid startup snapshot");
  const pending: unknown = Reflect.get(startup, "pending");
  if (!Array.isArray(pending) || !pending.every((item: unknown) => typeof item === "string"))
    throw new Error("Invalid startup snapshot");
  return pending.join(", ") || "none observed";
}

export async function promptStatusDiagnostics(body: HostVerdict): Promise<unknown> {
  if (body.status === "pass") return null;
  const snapshot = await snapshotBrowserStartup();
  const attachment = {
    name: "browser-startup-diagnostics",
    body: JSON.stringify(snapshot ?? { unavailable: true }, null, 2),
    contentType: "application/json",
  };
  console.error("Pending browser startup awaits", pendingAwaits(snapshot));
  console.error("Browser startup diagnostics", attachment.body);
  return attachment;
}
