import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { ProcessContext } from "waffle/proc/types";
import {
  api,
  directory,
  prepareWaffleDirectories,
  runRoot,
  shell,
  waffleFixture,
} from "./own-shell-waffle-fixture.ts";

const shellBytes = new Uint8Array(await readFile(`${directory}/shell-runtime.wasm`));
const encoder = new TextEncoder();
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function trackWorkers(context: TestContext) {
  const Original = globalThis.Worker;
  const images: { pid: number; retired: boolean }[] = [];
  class ObservedWorker extends Original {
    private image?: (typeof images)[number];
    override postMessage(
      message: unknown,
      transfer: Transferable[] | StructuredSerializeOptions = [],
    ) {
      if (message && typeof message === "object" && "runtimeProcess" in message)
        this.observe(message.runtimeProcess);
      super.postMessage(message, Array.isArray(transfer) ? transfer : (transfer.transfer ?? []));
    }
    private observe(transport: unknown) {
      if (
        !transport ||
        typeof transport !== "object" ||
        !("pid" in transport) ||
        typeof transport.pid !== "number"
      )
        return;
      this.image = { pid: transport.pid, retired: false };
      images.push(this.image);
    }
    override terminate() {
      const stopped: unknown = super.terminate();
      if (stopped instanceof Promise) return stopped.then(() => this.retire());
      this.retire();
    }
    private retire() {
      if (this.image) this.image.retired = true;
    }
  }
  Object.defineProperty(globalThis, "Worker", { value: ObservedWorker, configurable: true });
  context.after(() => {
    Object.defineProperty(globalThis, "Worker", { value: Original, configurable: true });
  });
  return images;
}

async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "replacement did not reach its readiness boundary");
    await delay(5);
  }
}

async function fixture(context: TestContext, source: boolean) {
  const fixture = await waffleFixture(context);
  const runtime = fixture.runtime;
  const images = trackWorkers(context);
  await prepareWaffleDirectories(runtime, ["/bin", "/tmp/spec"]);
  await runtime.filesystem.writeFile("/payload", encoder.encode("abc\n"));
  for (const path of ["/bin/sh", "/bin/next"])
    await runtime.filesystem.writeFile(path, new Uint8Array());
  await runtime.filesystem.drain();
  const launches: ProcessContext[] = [];
  const launcher = api.guestLauncher(
    runtime,
    new URL("../.build/node/shell.mjs", import.meta.url).href,
    undefined,
    true,
  );
  runtime.registerAdapter("exec-test", (context, service) => {
    if (context.request.executable === "/bin/next") {
      assert.ok(
        images.some((image) => image.pid === context.pid && image.retired),
        "old shell Worker must stop before successor admission",
      );
      assert.ok(
        images.filter((image) => image.pid === context.pid).every((image) => image.retired),
        "no waiting shell Worker may survive replacement",
      );
    }
    launches.push(context);
    return launcher(context, service);
  });
  for (const path of ["/bin/sh", "/bin/next"])
    runtime.registerProgram(
      path,
      source
        ? { adapter: "exec-test", source: shellBytes }
        : { adapter: "exec-test", module: shell.module, cooperative: true },
    );
  const service = await runtime.processes();
  const supervisor = await service.ready();
  const exits: number[] = [];
  const unobserve = supervisor.onChildExit((event) => exits.push(event.pid));
  context.after(unobserve);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const invoke = (code: string) =>
    runRoot(
      runtime,
      api,
      shell,
      { modulePath: "", tmp: "/tmp/spec", env: { DROP: "old" }, fixtureDirectory: "" },
      code,
      (fd, data) => (fd === 2 ? stderr : stdout).push(Buffer.from(data)),
      fixture.setStop,
    );
  return { runtime, launches, images, exits, service, stdout, stderr, invoke };
}

for (const source of [false, true]) {
  for (const automatic of [false, true]) {
    test(
      `${source ? "source" : "prepared"} shell ${automatic ? "final command" : "explicit exec"} retains PID and completes only after final image`,
      { timeout: 20000 },
      async (context) => {
        const state = await fixture(context, source);
        const successor = `IFS= read -r value </payload; printf 'READY:%s:%s:%s\\n' "$0" "$X" "$value"; while [[ ! -f /release ]]; do :; done; exit 23`;
        const command = automatic
          ? `X=kept /bin/next -c ${quote(successor)}`
          : `exec 3>&-; X=kept exec -c -a renamed /bin/next -c ${quote(successor)}`;
        let completed = false;
        const done = state.invoke(`/bin/sh -c ${quote(command)} 3</payload`).then((status) => {
          completed = true;
          return status;
        });
        await until(() => Buffer.concat(state.stdout).toString().includes("READY:"));
        assert.equal(state.launches.length, 2);
        const [initial, successorContext] = state.launches;
        assert.ok(initial && successorContext);
        assert.equal(initial.pid, successorContext.pid);
        assert.equal(initial.parentPid, successorContext.parentPid);
        assert.equal(initial.job, successorContext.job);
        assert.equal(completed, false);
        assert.equal(state.exits.length, 0, "image stop must not publish process completion");
        assert.equal(
          state.images.filter((image) => image.pid === initial.pid && !image.retired).length,
          1,
        );
        await state.runtime.filesystem.writeFile("/release", encoder.encode("go"));
        await state.runtime.filesystem.drain();
        assert.equal(await done, 23);
        assert.equal(state.exits.filter((pid) => pid === initial.pid).length, 1);
        assert.equal(Buffer.concat(state.stderr).toString(), "");
        assert.match(
          Buffer.concat(state.stdout).toString(),
          automatic ? /READY:\/bin\/next:kept:abc/ : /READY:renamed::abc/,
        );
      },
    );
  }
  test(
    `${source ? "source" : "prepared"} exec preserves pipe input, fd aliases and shared offsets`,
    { timeout: 20000 },
    async (context) => {
      const state = await fixture(context, source);
      const successor = `IFS= read -rN1 -u3 second; IFS= read -rN1 -u7 third; IFS= read -rN1 input; printf '%s:%s:%s\\n' "$second" "$third" "$input"; IFS= read -r file </payload; printf '%s\\n' "$file"; exit 17`;
      const inner = `IFS= read -rN1 -u3 first; exec 7<&3; exec /bin/next -c ${quote(successor)}`;
      assert.equal(await state.invoke(`printf p | /bin/sh -c ${quote(inner)} 3</payload`), 17);
      assert.equal(state.launches[0]?.pid, state.launches[1]?.pid);
      assert.equal(Buffer.concat(state.stdout).toString(), "b:c:p\nabc\n");
      assert.equal(Buffer.concat(state.stderr).toString(), "");
    },
  );
  test(
    `${source ? "source" : "prepared"} cancellation reaches the replacement under the original PID`,
    { timeout: 20000 },
    async (context) => {
      const state = await fixture(context, source);
      const successor = `printf 'READY\\n'; while true; do :; done`;
      const done = state.invoke(`/bin/sh -c ${quote(`exec /bin/next -c ${quote(successor)}`)}`);
      await until(() => Buffer.concat(state.stdout).toString().includes("READY"));
      const pid = state.launches[0]?.pid;
      assert.ok(pid);
      await state.service.kill(pid, 9);
      assert.equal(await done, 137);
      assert.equal(state.exits.filter((child) => child === pid).length, 1);
    },
  );
}

test(
  "a complete exec fd list omitting the root cannot recover filesystem access",
  { timeout: 20000 },
  async (context) => {
    const state = await fixture(context, false);
    const module = await WebAssembly.compile(
      await readFile(new URL("../public/programs/test-guest.wasm", import.meta.url)),
    );
    await state.runtime.filesystem.writeFile("/bin/exec-fixture", new Uint8Array());
    await state.runtime.filesystem.drain();
    state.runtime.registerProgram("/bin/exec-fixture", {
      adapter: "exec-test",
      module,
      cooperative: true,
    });
    const request = JSON.stringify({
      executable: "/bin/next",
      argv: ["next", "-c", "read data </payload; echo ACCESS:$data"],
      env: {},
      cwd: "/",
      fds: [0, 1, 2].map((fd) => ({ child: fd, parent: fd })),
    });
    assert.equal(await state.invoke(`/bin/exec-fixture exec-json ${quote(request)}`), 2);
    assert.match(Buffer.concat(state.stderr).toString(), /errno 44/);
    assert.doesNotMatch(Buffer.concat(state.stdout).toString(), /ACCESS/);
    assert.equal(state.launches[0]?.pid, state.launches[1]?.pid);
  },
);
