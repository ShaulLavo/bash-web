import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { checkReleaseMetadata } from "./check-waffle-release.ts";
import { installedFamilyNames, readMetadata, verifyInstalledWaffle } from "./installed-waffle.ts";
import { assertPackageHostInterface, parseHostInterface } from "./waffle-host-interface.ts";
import { verifyInstalledPrograms } from "./waffle-program-release.ts";

const required = parseHostInterface(1, "test");
const identity = (bytes: Uint8Array) => ({
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

function fixture(context: TestContext) {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "host-interface-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  const change = (path: string, update: (value: Record<string, unknown>) => void) => {
    const value = readMetadata(resolve(root, path));
    update(value);
    put(path, value);
  };
  const runtimeUrl = "https://example.test/waffle-107.tgz";
  const runtimeIdentity = { url: runtimeUrl, ...identity(Buffer.from("runtime")) };
  const gitDependency =
    "git+https://github.com/example/unrelated.git#0123456789012345678901234567890123456789";
  const packages = installedFamilyNames.map((name) => ({
    name,
    version: "15",
    url: `https://example.test/${name}.tgz`,
    waffleHostInterface: 1,
    closureDependencies: {},
    registryDependencies: name === "waffle-git" ? { unrelated: gitDependency } : {},
    artifacts: ["guest.wasm", "guest-program.json"].map((path) => ({
      path,
      ...identity(Buffer.from(path)),
    })),
  }));
  for (const pkg of packages) {
    put(`node_modules/${pkg.name}/package.json`, {
      name: pkg.name,
      version: pkg.version,
      main: "index.js",
      waffleHostInterface: 1,
      peerDependencies: { waffle: "*" },
      dependencies: pkg.registryDependencies,
    });
    put(
      `node_modules/${pkg.name}/index.js`,
      'throw new Error("family imported before validation");',
    );
    for (const artifact of pkg.artifacts)
      put(`node_modules/${pkg.name}/${artifact.path}`, artifact.path);
  }
  const release = {
    schema: "waffle-program-release/2",
    version: "15",
    sourceCommit: "0123456789012345678901234567890123456789",
    tagState: "tagged",
    dirty: false,
    runtime: { version: "107", waffleHostInterface: 1, ...runtimeIdentity },
    packages,
  };
  const bytes = Buffer.from(JSON.stringify(release));
  put("sources.lock.json", {
    waffle: {
      version: "107",
      hostInterface: 1,
      specifier: runtimeUrl,
      archiveBytes: runtimeIdentity.bytes,
      archiveSha256: runtimeIdentity.sha256,
    },
    wafflePrograms: {
      version: "15",
      revision: release.sourceCommit,
      runtime: runtimeIdentity,
      releaseManifest: identity(bytes),
    },
  });
  put("package.json", {
    waffleHostInterface: 1,
    peerDependencies: { waffle: "*" },
    devDependencies: { waffle: runtimeUrl },
  });
  put("node_modules/waffle/package.json", {
    name: "waffle",
    version: "107",
    main: "index.js",
    waffleHostInterface: 1,
  });
  put("node_modules/waffle/index.js", "");
  put("package-lock.json", {
    packages: Object.fromEntries(
      [["node_modules/waffle", { resolved: runtimeUrl }]].concat(
        packages.map((pkg) => [`node_modules/${pkg.name}`, { resolved: pkg.url }]),
      ),
    ),
  });
  put("bun.lock", `"waffle": ["waffle@${runtimeUrl}", "", {}, "sha512-fixture"]`);
  return { root, put, change, bytes, runtimeUrl, gitDependency, release };
}

for (const value of [
  undefined,
  null,
  "1",
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`host metadata rejects ${String(value)}`, () => {
    assert.throws(() => parseHostInterface(value, "test"), /host interface/);
    assert.throws(
      () => assertPackageHostInterface({ waffleHostInterface: value }, required, "test"),
      /host interface/,
    );
  });
}

test("wildcard peers share one physical runtime and preserve unrelated Git edges", (context) => {
  const f = fixture(context);
  const result = verifyInstalledPrograms(f.root, f.bytes);
  assert.equal(result.directories.size, 8);
  assert.equal(result.artifactCount, 16);
});

for (const name of ["waffle", "waffle-base", "@waffle/python", "waffle-git"]) {
  test(`${name} missing or mismatched metadata fails without importing family code`, (context) => {
    const f = fixture(context);
    const path = `node_modules/${name}/package.json`;
    f.change(path, (pkg) => {
      delete pkg.waffleHostInterface;
    });
    assert.throws(() => verifyInstalledWaffle(f.root), /host interface/);
    f.change(path, (pkg) => {
      pkg.waffleHostInterface = 2;
    });
    assert.throws(() => verifyInstalledWaffle(f.root), /host interface mismatch/);
  });
}

test("a nested runtime fails even with matching metadata and one claimed lock entry", (context) => {
  const f = fixture(context);
  f.put("node_modules/waffle-base/node_modules/waffle/package.json", {
    name: "waffle",
    main: "index.js",
    waffleHostInterface: 1,
  });
  f.put("node_modules/waffle-base/node_modules/waffle/index.js", "");
  assert.throws(() => verifyInstalledWaffle(f.root), /duplicate physical runtime/);
});

test("both package locks reject extra runtime entries", (context) => {
  const f = fixture(context);
  f.change("package-lock.json", (lock) => {
    Object.assign(Object(lock.packages), {
      "node_modules/waffle-base/node_modules/waffle": { resolved: f.runtimeUrl },
    });
  });
  assert.throws(() => verifyInstalledWaffle(f.root), /one npm runtime/);
  f.change("package-lock.json", (lock) => {
    delete Object(lock.packages)["node_modules/waffle-base/node_modules/waffle"];
  });
  f.put(
    "bun.lock",
    `"waffle": ["waffle@${f.runtimeUrl}"]\n"waffle-base/waffle": ["waffle@${f.runtimeUrl}"]`,
  );
  assert.throws(() => verifyInstalledWaffle(f.root), /one Bun runtime/);
});

for (const path of ["guest.wasm", "guest-program.json"]) {
  test(`changed ${path} is rejected independently of host compatibility`, (context) => {
    const f = fixture(context);
    f.put(`node_modules/waffle-coreutils/${path}`, "changed bytes");
    assert.throws(() => verifyInstalledPrograms(f.root, f.bytes), /mismatch/);
  });
}

for (const change of [
  { field: "url", value: "https://example.test/unreviewed-runtime.tgz" },
  { field: "bytes", value: 999 },
  { field: "sha256", value: "b".repeat(64) },
]) {
  test(`program release runtime identity rejects changed ${change.field}`, (context) => {
    const f = fixture(context);
    const release = {
      ...f.release,
      runtime: { ...f.release.runtime, [change.field]: change.value },
    };
    assert.throws(
      () =>
        checkReleaseMetadata(
          release,
          readMetadata(resolve(f.root, "sources.lock.json")).waffle,
          "programs",
          "15",
        ),
      /program release runtime .*mismatch/,
    );
  });
  test(`installed program runtime identity rejects changed ${change.field}`, (context) => {
    const f = fixture(context);
    const release = {
      ...f.release,
      runtime: { ...f.release.runtime, [change.field]: change.value },
    };
    const bytes = Buffer.from(JSON.stringify(release));
    f.change("sources.lock.json", (sources) => {
      Object.assign(Object(sources.wafflePrograms), { releaseManifest: identity(bytes) });
    });
    assert.throws(
      () => verifyInstalledPrograms(f.root, bytes),
      /program release runtime .*mismatch/,
    );
  });
}

test("a same-interface runtime update does not require a family rebind", (context) => {
  const f = fixture(context);
  f.change("sources.lock.json", (sources) => {
    Object.assign(Object(sources.waffle), {
      version: "108",
      specifier: "https://example.test/waffle-108.tgz",
      archiveBytes: 8,
      archiveSha256: "c".repeat(64),
    });
  });
  f.change("node_modules/waffle/package.json", (pkg) => {
    pkg.version = "108";
  });
  f.change("package.json", (pkg) => {
    pkg.devDependencies = { waffle: "https://example.test/waffle-108.tgz" };
  });
  f.change("package-lock.json", (lock) => {
    Object.assign(Object(lock.packages), {
      "node_modules/waffle": { resolved: "https://example.test/waffle-108.tgz" },
    });
  });
  f.put("bun.lock", '"waffle": ["waffle@https://example.test/waffle-108.tgz"]');
  assert.equal(verifyInstalledPrograms(f.root, f.bytes).artifactCount, 16);
  assert.equal(
    readFileSync(resolve(f.root, "node_modules/waffle-base/package.json"), "utf8").includes(
      '"version":"15"',
    ),
    true,
  );
});

test("release metadata cannot infer compatibility from an older schema or a runtime version", () => {
  assert.throws(
    () =>
      checkReleaseMetadata(
        { name: "waffle", version: "107" },
        { hostInterface: 1 },
        "runtime",
        "107",
      ),
    /host interface/,
  );
  assert.throws(
    () =>
      checkReleaseMetadata(
        { schema: "waffle-program-release/1", version: "15" },
        { hostInterface: 1 },
        "programs",
        "15",
      ),
    /waffle-program-release/,
  );
});

for (const path of ["package.json", "node_modules/waffle-base/package.json"]) {
  test(`${path} cannot publish a runtime dependency or optional peer`, (context) => {
    const f = fixture(context);
    f.change(path, (pkg) => {
      pkg.optionalDependencies = { waffle: f.runtimeUrl };
    });
    assert.throws(() => verifyInstalledWaffle(f.root), /forbidden Waffle/);
    f.change(path, (pkg) => {
      delete pkg.optionalDependencies;
      pkg.peerDependenciesMeta = { waffle: { optional: true } };
    });
    assert.throws(() => verifyInstalledWaffle(f.root), /peer is required/);
  });
}

test("unrelated Git edges and the pinned release manifest cannot change", (context) => {
  const f = fixture(context);
  f.change("node_modules/waffle-git/package.json", (pkg) => {
    pkg.dependencies = { unrelated: "changed" };
  });
  assert.throws(() => verifyInstalledPrograms(f.root, f.bytes), /changed dependency edges/);
  assert.throws(
    () => verifyInstalledPrograms(f.root, Buffer.concat([f.bytes, Buffer.from(" ")])),
    /mismatch/,
  );
});
