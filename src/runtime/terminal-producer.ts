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
  type TerminalAuthority,
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
type EditorState = {
  group: TerminalGroup;
  member: TerminalMember;
  lease: TerminalLease;
  next?: Discard;
};
function restoreEditor(
  state: EditorState,
  authority: TerminalAuthority,
  pid: number,
): TerminalResult<void> {
  try {
    if (!state.next)
      state.next = { kind: "group", group: must(authority.createGroup({ initialMode: "raw" })) };
    if (state.next.kind === "group")
      state.next = {
        ...state.next,
        kind: "member",
        member: must(authority.admitExisting({ group: state.next.group, pid })).member,
      };
    if (state.next.kind === "member") {
      state.lease = must(authority.transfer({ from: state.lease, to: state.next.group }));
      state.next = { ...state.next, kind: "selected" };
    }
    must(authority.removeMember(state.member));
    must(authority.retireGroup({ group: state.group, reason: "completed" }));
    state.group = state.next.group;
    state.member = state.next.member;
    state.next = undefined;
    return { kind: "ok", value: undefined };
  } catch (error) {
    if (error instanceof TerminalOperationError) return { kind: "error", code: error.code };
    throw error;
  }
}
function finishDiscard(
  state: EditorState,
  authority: TerminalAuthority,
  discard: Exclude<Discard, { kind: "group" }>,
  restore: TerminalGroup,
): Exclude<Discard, { kind: "group" }> {
  if (restore === state.group) {
    const previous = { group: state.group, member: state.member };
    state.group = discard.group;
    state.member = discard.member;
    return { ...previous, kind: "restored" };
  }
  state.lease = must(authority.transfer({ from: state.lease, to: restore }));
  return { ...discard, kind: "restored" };
}
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
  const root = must(authority.admitExisting({ group: editor, pid: options.controller.pid }));
  const state: EditorState = {
    group: editor,
    member: root.member,
    lease: must(authority.acquire({ group: editor, expected: null })),
  };
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
    if (result.kind === "ok" && result.value.lease) state.lease = result.value.lease;
    return result;
  };
  return {
    terminal: authority,
    get editor() {
      return state.group;
    },
    get rootMember() {
      return state.member;
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
      const selected = authority.transfer({ from: state.lease, to: group });
      if (selected.kind === "error") return selected;
      state.lease = selected.value;
      return { kind: "ok", value: undefined };
    },
    restoreEditor(): TerminalResult<void> {
      return restoreEditor(state, authority, options.controller.pid);
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
        state.lease = must(authority.transfer({ from: state.lease, to: discard.group }));
        discard = { ...discard, kind: "selected" };
      }
      if (discard.kind === "selected") {
        const controls = terminalControls(stream)!;
        const snapshot = must(controls.snapshot());
        must(controls.setMode({ expected: snapshot.selection, mode: "raw" }));
        discard = { ...discard, kind: "raw" };
      }
      if (discard.kind === "raw" && !drain(stream, () => input.available())) return false;
      if (discard.kind === "raw") {
        discard = finishDiscard(state, authority, discard, restore);
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
