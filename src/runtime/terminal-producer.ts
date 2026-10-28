import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalContext,
  type TerminalGeometry,
  type TerminalGroup,
  type TerminalLease,
  type TerminalMember,
  type TerminalMemberPlan,
  type TerminalMode,
  type TerminalReason,
  type TerminalResult,
} from "waffle/browser/runtime-terminals";
import type { WorkerProcessTransport } from "waffle/proc/worker-client";

export interface TerminalMetadata {
  terminalContext: TerminalContext;
  terminalInput: SharedArrayBuffer;
}

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(`Terminal acquisition failed: ${result.code}`);
  return result.value;
}

type ProducerOptions = {
  controller: WorkerProcessTransport;
  geometry: TerminalGeometry;
  checkActive(): void;
  capacity?: number;
  initialMode?: TerminalMode;
};

/** Root-only producer. Activation in createShell awaits runtime descendant admission.
 * No metadata is published to shipping workers until that handshake is available. */
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
  const editor = must(authority.createGroup({ initialMode: options.initialMode ?? "raw" }));
  const root = must(authority.admitExisting({ group: editor, pid: options.controller.pid }));
  let lease = must(authority.acquire({ group: editor, expected: null }));
  const metadata = (terminalContext: TerminalContext): TerminalMetadata => ({
    terminalContext,
    terminalInput: input.buffer,
  });
  const track = <T extends { readonly lease: TerminalLease | null }>(result: TerminalResult<T>) => {
    if (result.kind === "ok" && result.value.lease) lease = result.value.lease;
    return result;
  };
  return {
    editor,
    rootMember: root.member,
    rootMetadata: metadata(root.context),
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
      input.close();
      display.close(reason);
    },
  };
}
