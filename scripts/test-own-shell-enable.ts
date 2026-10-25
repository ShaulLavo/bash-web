import assert from "node:assert/strict";
import { test } from "node:test";
import { recordedBashTests } from "./recorded-bash-tests.ts";
import { assertShellControlOutput, createShellFixtureRunner } from "./shell-fixture-runner.ts";

await recordedBashTests("enable", new URL("fixtures/shell-enable.json", import.meta.url));

const run = await createShellFixtureRunner({ utilities: false });
const controls = [
  {
    name: "source handlers share dispatch and completion availability",
    code: "echo 'echo loaded' > lib; PATH=; enable -n source .; source ./lib; echo direct:$?; builtin . ./lib; echo wrapped:$?; command -v source; echo query:$?; compgen -A disabled source; enable source .; command source ./lib; builtin . ./lib; compgen -A enabled source",
    stdout: "direct:127\nwrapped:1\nquery:1\nsource\nloaded\nloaded\nsource\n",
  },
  {
    name: "sourced local append shares disable state and restores local bindings",
    code: "word=outer; echo 'value=loaded; enable -n printf; local word+=X' > lib; f() { local word=before; source ./lib; echo inside:$word:$value; }; f; type -t printf; echo disabled:$?; enable printf; printf '%s\\n' outside:$word:$value",
    stdout: "inside:beforeX:loaded\ndisabled:1\noutside:outer:loaded\n",
  },
  {
    name: "source function changes share state but subshell changes do not",
    code: "enable -n source; (enable source; type -t source); type -t source; echo parent:$?; f() { enable source; }; f; type -t source",
    stdout: "builtin\nparent:1\nbuiltin\n",
  },
  {
    name: "completion availability follows the registry",
    code: "PATH=; enable -n printf; compgen -A enabled printf; echo enabled:$?; compgen -A disabled printf; compgen -A builtin printf; compgen -A command printf; echo command:$?; enable printf; compgen -A enabled printf; compgen -A disabled printf; echo disabled:$?",
    stdout: "enabled:1\nprintf\nprintf\ncommand:1\nprintf\ndisabled:1\n",
  },
  {
    name: "disabled dispatch and queries share one registry",
    code: "PATH=; enable -n printf; type -t printf; echo type:$?; command -v printf; echo query:$?; builtin printf bad; echo builtin:$?; printf bad; echo direct:$?; command printf bad; echo command:$?; enable printf; builtin printf '%s\\n' restored",
    stdout: "type:1\nquery:1\nbuiltin:1\ndirect:127\ncommand:127\nrestored\n",
  },
  {
    name: "subshells, substitutions, pipelines and background jobs isolate disable state",
    code: "PATH=; (enable -n printf; type -t printf); type -t printf; x=$(enable -n printf; type -t printf); type -t printf; enable -n printf | true; type -t printf; enable -n printf & wait; type -t printf; f() { enable -n printf; }; f; type -t printf; echo function:$?; (enable printf; type -t printf); type -t printf; echo parent:$?; enable printf",
    stdout: "builtin\nbuiltin\nbuiltin\nbuiltin\nfunction:1\nbuiltin\nparent:1\n",
  },
  {
    name: "disabled listings are sorted and re-enable removes an entry",
    code: "enable -n printf echo; enable -n echo; enable -n; enable echo; enable -np; enable printf; enable -n",
    stdout: "enable -n echo\nenable -n printf\nenable -n printf\n",
  },
  {
    name: "unsupported names and dynamic loading cannot claim builtin support",
    code: "enable source; echo source:$?; enable times; echo times:$?; enable -f library printf; echo load:$?; enable -d printf; echo delete:$?; type -t printf",
    stdout: "source:0\ntimes:1\nload:2\ndelete:2\nbuiltin\n",
  },
  {
    name: "functions precede disabled builtins and command still bypasses them",
    code: "PATH=; enable -n printf; printf() { echo function; }; printf; command printf bad; echo command:$?; enable printf; printf; command printf '%s\\n' restored",
    stdout: "function\ncommand:127\nfunction\nrestored\n",
  },
  {
    name: "aliases keep their reader precedence",
    code: "shopt -s expand_aliases\nalias printf='echo alias'\nenable -n printf\nprintf value\ncommand printf bad; echo command:$?\nenable printf\ncommand printf '%s\\n' builtin",
    stdout: "alias value\ncommand:127\nbuiltin\n",
  },
];
for (const control of controls)
  test(`production Waffle enable: ${control.name}`, async () => {
    const actual = await run(control.code);
    assertShellControlOutput(actual, control);
  });

test("production Waffle enable remains a core feature without utility add-ons", async () => {
  const actual = await run("enable -n; enable -n printf; enable printf; printf core; cat");
  assert.equal(actual.crash, undefined);
  assert.equal(actual.status, 127);
  assert.equal(actual.stdout.toString(), "core");
  assert.match(actual.stderr.toString(), /cat: command not found/u);
});
