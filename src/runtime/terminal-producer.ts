import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  attachTerminal,
  terminalControls,
  type TerminalContext,
  type TerminalGeometry,
  type TerminalGroup,
  type TerminalLease,
  type TerminalMember,
  type TerminalMemberPlan,
  type TerminalMode,
  type TerminalReason,
  type TerminalResult,
  type TerminalFailure,
} from "waffle/browser/runtime-terminals";
import type { Stream } from "waffle/core";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

export interface TerminalMetadata {
  terminalContext: TerminalContext;
  terminalInput: SharedArrayBuffer;
}

export class TerminalOperationError extends Error {
  constructor(readonly code: TerminalFailure) {
    super(`Terminal operation failed: ${code}`);
  }
}
function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new TerminalOperationError(result.code);
  return result.value;
}
type Discard =
  | { kind: "group"; group: TerminalGroup }
  | {
      kind: "member" | "selected" | "raw" | "restored";
      group: TerminalGroup;
      member: TerminalMember;
    };
function drain(stream: Stream, available: () => number): boolean {
  const bytes = new Uint8Array(4096);
  while (available()) {
    const count = stream.tryRead!([bytes]);
    if (count === -6) return false;
    if (count <= 0) throw new Error(`Terminal discard read failed: ${count}`);
  }
  return true;
}

type ProducerOptions = {
  controller: WorkerProcessTransport;
  geometry: TerminalGeometry;
  checkActive(): void;
  capacity?: number;
  initialMode?: TerminalMode;
};

export function createTerminalProducer(options: ProducerOptions) {
  options.checkActive();
  const input = createTerminalInput({ capacity: options.capacity });
  const display = createTerminalSession(options);
  const policy = createTerminalInputPolicy({ input });
  try {
    return acquireTerminalProducer(options, input, display, policy);
  } catch (error) {
    input.close();
    display.close("failed");
    throw error;
  }
}

function acquireTerminalProducer(
  options: ProducerOptions,
  input: ReturnType<typeof createTerminalInput>,
  display: ReturnType<typeof createTerminalSession>,
  policy: ReturnType<typeof createTerminalInputPolicy>,
) {
  const authority = must(
    claimTerminalAuthority({
      identity: display.identity,
      process: options.controller,
      checkActive: options.checkActive,
      policy,
    }),
  );
  let editor = must(authority.createGroup({ initialMode: options.initialMode ?? "raw" }));
  let root = must(authority.admitExisting({ group: editor, pid: options.controller.pid }));
  let lease = must(authority.acquire({ group: editor, expected: null }));
  const reader = attachTerminal({
    context: display.inherit(),
    process: options.controller,
    checkActive: options.checkActive,
    policy,
  });
  const stream = reader.resolve(0);
  let discard: Discard | undefined;
  const metadata = (terminalContext: TerminalContext): TerminalMetadata => ({
    terminalContext,
    terminalInput: input.buffer,
  });
  const track = <T extends { readonly lease: TerminalLease | null }>(result: TerminalResult<T>) => {
    if (result.kind === "ok" && result.value.lease) lease = result.value.lease;
    return result;
  };
  return {
    get editor() {
      return editor;
    },
    get rootMember() {
      return root.member;
    },
    rootMetadata: metadata(display.inherit()),
    notification: input.notification,
    available: () => input.available(),
    wake: () => display.outputDrained(),
    metadata,
    createGroup: (initialMode: TerminalMode) => authority.createGroup({ initialMode }),
    planMember: (group: TerminalGroup, parent: TerminalMember) =>
      authority.planMember({ group, parent }),
    bindMember: (planned: TerminalMemberPlan, pid: number) =>
      track(authority.bindMember({ planned, pid })),
    admitExisting: (group: TerminalGroup, pid: number) =>
      track(authority.admitExisting({ group, pid })),
    removeMember: (member: TerminalMember) => track(authority.removeMember(member)),
    cancelPlan: (planned: TerminalMemberPlan) => authority.cancelPlan(planned),
    startBackground: (group: TerminalGroup) => authority.startBackground(group),
    select(group: TerminalGroup): TerminalResult<void> {
      const selected = authority.transfer({ from: lease, to: group });
      if (selected.kind === "error") return selected;
      lease = selected.value;
      return { kind: "ok", value: undefined };
    },
    restoreEditor(): TerminalResult<void> {
      const next = authority.createGroup({ initialMode: "raw" });
      if (next.kind === "error") return next;
      const member = authority.admitExisting({ group: next.value, pid: options.controller.pid });
      if (member.kind === "error") return member;
      const selected = authority.transfer({ from: lease, to: next.value });
      if (selected.kind === "error") return selected;
      lease = selected.value;
      must(authority.removeMember(root.member));
      must(authority.retireGroup({ group: editor, reason: "completed" }));
      editor = next.value;
      root = member.value;
      return { kind: "ok", value: undefined };
    },
    discardInput(restore: TerminalGroup): boolean {
      if (!discard)
        discard = { kind: "group", group: must(authority.createGroup({ initialMode: "cooked" })) };
      if (discard.kind === "group")
        discard = {
          ...discard,
          kind: "member",
          member: must(
            authority.admitExisting({ group: discard.group, pid: options.controller.pid }),
          ).member,
        };
      if (discard.kind === "member") {
        lease = must(authority.transfer({ from: lease, to: discard.group }));
        discard = { ...discard, kind: "selected" };
      }
      if (discard.kind === "selected") {
        const controls = terminalControls(stream)!;
        const snapshot = must(controls.snapshot());
        must(controls.setMode({ expected: snapshot.selection, mode: "raw" }));
        discard = { ...discard, kind: "raw" };
      }
      if (discard.kind === "raw") {
        if (!drain(stream, () => input.available())) return false;
        lease = must(authority.transfer({ from: lease, to: restore }));
        discard = { ...discard, kind: "restored" };
      }
      must(authority.removeMember(discard.member));
      must(authority.retireGroup({ group: discard.group, reason: "cancelled" }));
      discard = undefined;
      return true;
    },
    retireGroup: (group: TerminalGroup, reason: TerminalReason) =>
      authority.retireGroup({ group, reason }),
    /** The caller retains and retries bytes.subarray(result.accepted) on failure.
     * This producer never copies an unaccepted tail into a second input queue. */
    pushKeyboard(bytes: Uint8Array) {
      options.checkActive();
      return pushTerminalInput(display, input, bytes);
    },
    resize(geometry: TerminalGeometry) {
      options.checkActive();
      return display.resize(geometry);
    },
    cancelInput() {
      input.cancel();
      display.outputDrained();
    },
    resumeInput() {
      input.resume();
      display.outputDrained();
    },
    closeInput() {
      input.close();
      display.outputDrained();
    },
    dispose(reason: TerminalReason = "disposed") {
      reader.dispose();
      input.close();
      display.close(reason);
    },
  };
}
