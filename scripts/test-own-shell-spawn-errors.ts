import assert from "node:assert/strict";
import { test } from "node:test";
import {
  api,
  prepareWaffleDirectories,
  runRoot,
  shell,
  waffleFixture,
} from "./own-shell-waffle-fixture.ts";

for (const [source, expectedStatus, expectedOutput] of [
  ["/usr/bin/startup-tool", 126, ""],
  ["/usr/bin/startup-tool; echo continued", 0, "continued\n"],
] as const) {
  test(
    `released Waffle preserves the startup cause with status ${expectedStatus}`,
    { timeout: 15000 },
    async (context) => {
      const fixture = await waffleFixture(context);
      const runtime = fixture.runtime;
      await prepareWaffleDirectories(runtime, ["/tmp/spec", "/usr/bin"]);
      await runtime.filesystem.writeFile("/usr/bin/startup-tool", new Uint8Array());
      await runtime.filesystem.drain();
      const adapter = "bash-web:spawn-diagnostic-test";
      runtime.registerAdapter(adapter, () => {
        assert.fail("a failed module must not enter the adapter");
      });
      runtime.registerProgram("/usr/bin/startup-tool", {
        adapter,
        module: async () => {
          throw new Error("module loading failed", {
            cause: new RangeError("original module cause"),
          });
        },
        cooperative: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const status = await runRoot(
        runtime,
        api,
        shell,
        { modulePath: "", tmp: "/tmp/spec", env: {}, fixtureDirectory: "" },
        source,
        (fd, bytes) => (fd === 2 ? stderr : stdout).push(Buffer.from(bytes)),
        fixture.setStop,
      );
      const diagnostic = Buffer.concat(stderr).toString();
      assert.equal(status, expectedStatus);
      assert.equal(Buffer.concat(stdout).toString(), expectedOutput);
      assert.match(
        diagnostic,
        /^\/usr\/bin\/bash: \/usr\/bin\/startup-tool: Input\/output error: /,
      );
      assert.match(diagnostic, /module loading failed/);
      assert.match(diagnostic, /RangeError: original module cause/);
      assert.ok(
        Buffer.byteLength(diagnostic) <=
          4096 + "/usr/bin/bash: /usr/bin/startup-tool: Input/output error: ".length + 1,
      );
    },
  );
}
