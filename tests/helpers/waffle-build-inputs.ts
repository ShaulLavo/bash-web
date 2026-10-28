import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function waffleBuildFixture(root: string, builder: string, patch: string) {
  const waffle = {
    revision: hash(builder + patch).slice(0, 40),
    version: "0.0.91",
    specifier:
      "https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.91/waffle-0.0.91.tgz",
    buildInputs: {
      packagePath: "packages/waffle",
      builderSha256: hash(builder),
      patchSha256: hash(patch),
    },
  };
  const put = (path: string, text: string) => {
    const file = resolve(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  put(
    "package.json",
    JSON.stringify({
      devDependencies: { waffle: waffle.specifier },
      peerDependencies: { waffle: waffle.specifier },
    }),
  );
  put("sources.lock.json", JSON.stringify({ waffle }));
  put(
    "node_modules/waffle/package.json",
    JSON.stringify({ name: "waffle", version: waffle.version }),
  );
  put("node_modules/waffle/scripts/build-wasi-libc.sh", builder);
  const staged = `.build/waffle-inputs/${waffle.revision}/packages/waffle`;
  put(`${staged}/scripts/build-wasi-libc.sh`, builder);
  put(`${staged}/patches/wasi-libc/preopen-scan.patch`, patch);
  return waffle;
}
