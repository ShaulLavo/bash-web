import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { createWaffleRunner } from "./waffle-compat.ts";

const directory = resolve(process.env.CARGO_TARGET_DIR ?? ".build/shell", "wasm32-wasip1/release");
const modulePath = process.env.BASH_WEB_SUPPORT_WASM ?? resolve(directory, "shell-runtime.wasm");
const run = await createWaffleRunner({
  modulePath,
  tmp: "/tmp/spec",
  env: {},
  fixtureDirectory: directory,
});

const cases = [
  {
    name: "large heredoc crosses external pipe backpressure without losing bytes",
    source: 'payload=$(printf "%131072s" x); cat <<< "$payload" | cat | wc -c',
    stdout: "131073\n",
  },
  {
    name: "early external reader close releases a blocked producer",
    source: 'seq 1 100000 | head -n 1; printf "status:%s\\n" "$?"',
    stdout: "1\nstatus:0\n",
  },
  {
    name: "descriptor aliases share a read offset and close independently",
    source:
      'printf abc >data; exec 3<data; exec 4<&3; exec 3<&-; read -N1 first <&4; read -N2 rest <&4; exec 4<&-; printf "%s:%s\\n" "$first" "$rest"',
    stdout: "a:bc\n",
  },
  {
    name: "buffered input pump preserves alias position across external children",
    source: 'f() { read -N1 first; printf "%s:" "$first"; cat; }; f 3<<<abcd 0<&3',
    stdout: "a:bcd\n",
  },
  {
    name: "process substitution waits wake and release each inherited endpoint",
    source: 'cat <(printf left) <(printf right); printf "\\nstatus:%s\\n" "$?"',
    stdout: "leftright\nstatus:0\n",
  },
  {
    name: "directory metadata and enumeration use the shared filesystem reactor",
    source:
      'mkdir -p a/b; printf x >a/file; for path in a/*; do printf "%s\\n" "$path"; done; [[ -d a/b && -f a/file ]]',
    stdout: "a/b\na/file\n",
  },
];

for (const scenario of cases) {
  test(scenario.name, { timeout: 30000 }, async () => {
    const result = await run(scenario.source);
    assert.equal(result.crash, undefined);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), scenario.stdout);
  });
}
