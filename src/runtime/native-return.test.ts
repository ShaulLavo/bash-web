import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { claimOutcome } from "waffle/proc/outcome";
import { captureNativeReturn, captureProcessObserver } from "waffle/proc/observation";
import { createWorkerProcessTransport, workerProcessState } from "waffle/proc/worker-client";
import { createFilesystemIdentity } from "waffle/fs/protocol";
import { SharedBridge } from "../bridge";
import { createTerminalController } from "./terminal-controller";
import type { ShellWorkerRequest } from "./worker";
import { nativeReturnControl } from "../../tests/helpers/native-return-control";

function request(context: TestContext) {
  const transport = createWorkerProcessTransport({ capacity: 4 });
  const terminal = new SharedBridge();
  const controller = createTerminalController({ disposed: false }, transport, terminal, (error) => {
    throw error;
  });
  context.after(() => controller.quiesce());
  const channel = new MessageChannel();
  context.after(() => {
    channel.port1.close();
    channel.port2.close();
  });
  transport.data = { ...controller.metadata };
  const request: ShellWorkerRequest = {
    runtimeProcess: transport,
    module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    args: [],
    env: {},
    filesystem: { ...createFilesystemIdentity(), port: channel.port1 },
    controlGrant: { kind: "unbounded" },
    terminal: terminal.buffer,
  };
  return { request, transport };
}

for (const returned of [false, true]) {
  test(
    `native-return late shell bootstrap preserves ${returned ? "terminated" : "selected"} observation`,
    { timeout: 10000 },
    async (context) => {
      const control = nativeReturnControl(context);
      const f = request(context);
      const observer = captureProcessObserver(f.transport);
      assert.deepEqual(await control.observe(f.transport), { kind: "pending" });
      const result = claimOutcome(workerProcessState(f.transport).signals.outcome, {
        kind: "exited",
        code: 23,
      });
      assert.deepEqual(await control.observe(f.transport), { kind: "selected", result });
      if (returned) captureNativeReturn(f.transport)();
      assert.deepEqual(
        observer.read(),
        returned ? { kind: "terminated" } : { kind: "selected", result },
      );
      await control.start(f.request);
      const exits = control.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "exit",
      );
      assert.equal(exits.length, returned ? 0 : 1);
      assert.deepEqual(await control.observe(f.transport), observer.read());
    },
  );
}
