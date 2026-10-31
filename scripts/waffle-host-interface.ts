import assert from "node:assert/strict";

export type HostInterface = number & { readonly __brand: "WaffleHostInterface" };

export function metadataRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

export function parseHostInterface(value: unknown, source: string): HostInterface {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `${source}: host interface must be a positive safe integer`,
  );
  return value as HostInterface;
}

export function assertExactHostInterface(
  required: HostInterface,
  provided: HostInterface,
  source: string,
): void {
  assert.equal(provided, required, `${source}: Waffle host interface mismatch`);
}

export function assertPackageHostInterface(
  metadata: unknown,
  required: HostInterface,
  source: string,
): void {
  const pkg = metadataRecord(metadata);
  assertExactHostInterface(required, parseHostInterface(pkg.waffleHostInterface, source), source);
}

export function assertRuntimePeer(metadata: unknown, source: string): void {
  const pkg = metadataRecord(metadata);
  assert.equal(metadataRecord(pkg.peerDependencies).waffle, "*", `${source}: Waffle peer must be *`);
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (pkg[field] === undefined) continue;
    assert.equal(metadataRecord(pkg[field]).waffle, undefined, `${source}: forbidden Waffle ${field}`);
  }
}
