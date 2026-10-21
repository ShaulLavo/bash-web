import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseShellRunner } from "./release-shell-runner.ts";

// Bare `${!ref}` whose target is a positional or special parameter, through
// the release guest on Waffle's process path.
const runner = await releaseShellRunner();
// GNU Bash 5.3.15 (the frozen oracle's version) observations, recorded so the
// check does not depend on the CI host's Bash. Diagnostics drop line numbers.
const cases = [
  {
    script: "set -- one two; ref1='1'; echo ref1=${!ref1}; ref2='2'; echo ref2=${!ref2}",
    status: 0,
    stdout: "ref1=one\nref2=two\n",
    stderr: "",
  },
  {
    script: "set -- one two; ref='@'; echo ref=${!ref}",
    status: 0,
    stdout: "ref=one two\n",
    stderr: "",
  },
  {
    script: 'set a b c; ref="2"; echo "${!ref}"',
    status: 0,
    stdout: "b\n",
    stderr: "",
  },
  {
    script: "set -- 'a b' '' c; r=@; printf '<%s>' ${!r} \"${!r}\" \"x${!r}y\"; echo",
    status: 0,
    stdout: "<a><b><c><a b><><c><xa b><><cy>\n",
    stderr: "",
  },
  {
    script: "set -- 'a b' '' c; r='*'; printf '<%s>' ${!r} \"${!r}\"; echo",
    status: 0,
    stdout: "<a><b><c><a b  c>\n",
    stderr: "",
  },
  {
    script: "set -- 'a b' '' c; IFS=:; r='*'; printf '<%s>' ${!r} \"${!r}\"; echo",
    status: 0,
    stdout: "<a b><><c><a b::c>\n",
    stderr: "",
  },
  {
    script:
      "set -- 'a b' '' c; IFS=; r='*'; printf '<%s>' ${!r} \"${!r}\"; r=@; printf '<%s>' ${!r} \"${!r}\"; echo",
    status: 0,
    stdout: "<a b><c><a bc><a b><c><a b><><c>\n",
    stderr: "",
  },
  {
    script: 'set --; r=@; set -- "${!r}"; echo "n=$#"',
    status: 0,
    stdout: "n=0\n",
    stderr: "",
  },
  {
    script: 'set --; r=\'*\'; set -- "${!r}"; echo "n=$#"',
    status: 0,
    stdout: "n=1\n",
    stderr: "",
  },
  {
    script: 'set -- one two; r=@; x=${!r}; echo "[$x]"; r=\'*\'; IFS=-; y="${!r}"; echo "[$y]"',
    status: 0,
    stdout: "[one two]\n[one-two]\n",
    stderr: "",
  },
  {
    script: "set -- a b c; r=2; case b in ${!r}) echo match;; *) echo no;; esac",
    status: 0,
    stdout: "match\n",
    stderr: "",
  },
  {
    script:
      'set -- a b c; r=3; echo "${!r}"; r=10; echo "[${!r}]"; r=01; echo "${!r}"; r=\'#\'; echo "${!r}"',
    status: 0,
    stdout: "c\n[]\na\n3\n",
    stderr: "",
  },
  {
    script: "r='?'; false; echo ${!r}",
    status: 0,
    stdout: "1\n",
    stderr: "",
  },
  {
    script:
      'f() { r=1; echo "${!r}:${!r}"; r=@; for x in "${!r}"; do echo "<$x>"; done; }; f \'p q\' s',
    status: 0,
    stdout: "p q:p q\n<p q>\n<s>\n",
    stderr: "",
  },
  {
    script: 'set -u; set -- a; r=1; echo "[${!r}]"; r=2; echo "[${!r}]"; echo after',
    status: 127,
    stdout: "[a]\n",
    stderr: "/usr/bin/bash: !r: unbound variable\n",
  },
  {
    script: 'set -u; set --; r=@; echo "[${!r}]"; r=\'*\'; echo "[${!r}]"; echo after',
    status: 127,
    stdout: "[]\n",
    stderr: "/usr/bin/bash: !r: unbound variable\n",
  },
];
const normalizeDiagnostic = (bytes: Buffer) => bytes.toString().replaceAll(/: line \d+:/g, ":");
for (const { script, status, stdout, stderr } of cases)
  test(`production Waffle indirect special target: ${script}`, async () => {
    const actual = await runner(script);
    assert.equal(actual.crash, undefined);
    assert.equal(actual.status, status);
    assert.equal(actual.stdout.toString(), stdout);
    assert.equal(normalizeDiagnostic(actual.stderr), stderr);
  });
