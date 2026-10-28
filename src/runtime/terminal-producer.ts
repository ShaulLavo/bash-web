import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  attachTerminal,
  terminalControls,
  TERMINAL_SESSION_LIMITS,
  type TerminalContext,
  type TerminalGeometry,
  type TerminalGroup,
  type TerminalLease,
  type TerminalMember,
  type TerminalMode,
  type TerminalReason,
  type TerminalResult,
  type TerminalFailure,
  type TerminalControlReceipt,
  type TerminalControlTurn,
} from "waffle/browser/runtime-terminals";
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
export function terminalValue<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new TerminalOperationError(result.code);
  return result.value;
}
export function terminalResult<T>(work: () => T): TerminalResult<T> {
  try {
    return { kind: "ok", value: work() };
  } catch (error) {
    if (error instanceof TerminalOperationError) return { kind: "error", code: error.code };
    throw error;
  }
}
type Editor = { group: TerminalGroup; member: TerminalMember };
type Selection = NonNullable<
  Extract<NonNullable<TerminalControlReceipt["state"]>, { kind: "open" }>["selection"]
>;
type Cache =
  | { kind: "open"; editor: Editor; selection: Selection | null }
  | { kind: "closed"; code: TerminalFailure };
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
  const authority = terminalValue(
    claimTerminalAuthority({
      identity: display.identity,
      process: options.controller,
      checkActive: options.checkActive,
      policy,
    }),
  );
  const editor = terminalValue(
    authority.createGroup({ initialMode: options.initialMode ?? "raw" }),
  );
  const root = terminalValue(
    authority.admitExisting({ group: editor, pid: options.controller.pid }),
  );
  let cache: Cache = {
    kind: "open",
    editor: { group: editor, member: root.member },
    selection: {
      group: editor,
      rootMember: root.member,
      lease: terminalValue(authority.acquire({ group: editor, expected: null })),
    },
  };
  let lastReceipt: TerminalControlReceipt | undefined;
  const reader = attachTerminal({
    context: display.inherit(),
    process: options.controller,
    checkActive: options.checkActive,
    policy,
  });
  const stream = reader.resolve(0);
  const current = () => {
    if (cache.kind === "closed") throw new TerminalOperationError(cache.code);
    return cache;
  };
  const reconcile = (receipt: TerminalControlReceipt, next = current().editor): void => {
    const state = receipt.state;
    if (!state) return;
    lastReceipt = receipt;
    if (state.kind === "closed") {
      cache = { kind: "closed", code: state.code };
      return;
    }
    if (receipt.group(next.group) !== "active" || receipt.member(next.member) !== "bound") {
      cache = { kind: "closed", code: "STALE" };
      return;
    }
    cache = { kind: "open", editor: next, selection: state.selection };
  };
  const metadata = (terminalContext: TerminalContext): TerminalMetadata => ({
    terminalContext,
    terminalInput: input.buffer,
  });
  return {
    authority,
    get editor() {
      return current().editor.group;
    },
    get rootMember() {
      return current().editor.member;
    },
    rootMetadata: metadata(display.inherit()),
    available: () => input.available(),
    canPush: (count: number) =>
      Math.min(count, TERMINAL_SESSION_LIMITS.inputBytesPerTurn) <=
      input.capacity - input.available(),
    observe: () => input.observe(),
    memberStatus: (member: TerminalMember) => lastReceipt?.member(member) ?? "unknown",
    wake: () => display.outputDrained(),
    metadata,
    reconcile(receipt: TerminalControlReceipt): undefined {
      if (cache.kind === "open") reconcile(receipt, cache.editor);
    },
    begin(turn: TerminalControlTurn) {
      let next = current().editor;
      let lease: TerminalLease | null = current().selection?.lease ?? null;
      const track = <T extends { readonly lease: TerminalLease | null }>(
        result: TerminalResult<T>,
      ) => {
        if (result.kind === "ok" && result.value.lease) lease = result.value.lease;
        return result;
      };
      const select = (group: TerminalGroup): TerminalResult<void> => {
        if (!lease) return { kind: "error", code: "STALE" };
        const result = authority.transfer({ from: lease, to: group });
        if (result.kind === "error") return result;
        lease = result.value;
        return { kind: "ok", value: undefined };
      };
      return {
        get editor() {
          return next.group;
        },
        get rootMember() {
          return next.member;
        },
        createGroup: (mode: TerminalMode) => authority.createGroup({ initialMode: mode }),
        planMember: authority.planMember.bind(authority),
        bindMember: (planned: Parameters<typeof authority.bindMember>[0]) =>
          track(authority.bindMember(planned)),
        admitExisting: (group: TerminalGroup, pid: number) =>
          track(authority.admitExisting({ group, pid })),
        removeMember: (member: TerminalMember) => track(authority.removeMember(member)),
        cancelPlan: authority.cancelPlan.bind(authority),
        startBackground: authority.startBackground.bind(authority),
        retireGroup: (group: TerminalGroup, reason: TerminalReason) =>
          authority.retireGroup({ group, reason }),
        select,
        replaceEditor(group: TerminalGroup, member: TerminalMember) {
          next = { group, member };
        },
        restoreEditor(): TerminalResult<void> {
          return terminalResult(() => {
            const group = terminalValue(authority.createGroup({ initialMode: "raw" }));
            const member = terminalValue(
              authority.admitExisting({ group, pid: options.controller.pid }),
            ).member;
            terminalValue(select(group));
            terminalValue(authority.removeMember(next.member));
            terminalValue(authority.retireGroup({ group: next.group, reason: "completed" }));
            next = { group, member };
          });
        },
        raw(): TerminalResult<void> {
          return terminalResult(() => {
            const controls = terminalControls(stream)!;
            const snapshot = terminalValue(controls.snapshot());
            terminalValue(controls.setMode({ expected: snapshot.selection, mode: "raw" }));
          });
        },
        read(chunks: readonly Uint8Array[]) {
          return stream.tryRead!(chunks);
        },
        publish(operation: (receipt: TerminalControlReceipt) => undefined = () => {}) {
          turn.publish((receipt) => {
            reconcile(receipt, next);
            operation(receipt);
          });
        },
      };
    },
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

type TerminalProducer = ReturnType<typeof createTerminalProducer>;
export type TerminalProducerTurn = ReturnType<TerminalProducer["begin"]>;
