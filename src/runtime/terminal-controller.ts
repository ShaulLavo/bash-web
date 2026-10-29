import type { ProcessService, RootDescendantPreparation, Runtime } from "waffle";
import type { RuntimeDescendant } from "waffle/browser/process-broker";
import type {
  TerminalGroup,
  TerminalMember,
  TerminalResult,
  TerminalGeometry,
  TerminalControlTurn,
} from "waffle/browser/runtime-terminals";
import { controlLoad } from "waffle/proc/control";
import { readOutcome } from "waffle/proc/outcome";
import { ProcessError, ProcessErrno } from "waffle/proc/types";
import {
  workerProcessDirectoryId,
  workerProcessState,
  type WorkerProcessTransport,
} from "waffle/proc/worker-client";
import { SharedBridge, control } from "../bridge";
import {
  createTerminalProducer,
  TerminalOperationError,
  terminalResult,
  terminalValue,
  type TerminalProducerTurn,
} from "./terminal-producer";
import { createTerminalTasks } from "./terminal-control-tasks";

const outputs = new WeakMap<object, Map<string, SharedArrayBuffer>>();
export function shellTerminalOutput(runtime: Runtime, transport: WorkerProcessTransport) {
  return outputs.get(runtime)?.get(workerProcessDirectoryId(transport));
}
type State = ReturnType<typeof workerProcessState>;
type Group = {
  group: TerminalGroup;
  members: Map<number, TerminalMember>;
  jobs: Map<number, State["jobPending"]>;
  rootMember?: TerminalMember;
  restore?: Group;
  active: boolean;
};
type Drain = {
  kind: "drain" | "restore";
  group: TerminalGroup;
  member: TerminalMember;
  consumed: number;
  restore: Group;
};
function pending(cell: State["jobPending"]): boolean {
  try {
    return controlLoad(cell) !== 0;
  } catch (error) {
    if (error instanceof ProcessError && error.errno === ProcessErrno.SRCH) return false;
    throw error;
  }
}
function liveState(state: State | undefined): boolean {
  if (!state) return false;
  try {
    return !readOutcome(state.signals.outcome);
  } catch (error) {
    if (
      error instanceof ProcessError &&
      (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD)
    )
      return false;
    throw error;
  }
}
const empty = (record: Group) =>
  record.members.size === 0 && !Array.from(record.jobs.values()).some(pending);

export function createTerminalController(
  runtime: Pick<Runtime, "disposed">,
  root: WorkerProcessTransport,
  bridge: SharedBridge,
  failed: (error: unknown) => void,
) {
  const state = workerProcessState(root);
  const producer = createTerminalProducer({
    controller: root,
    geometry: {
      columns: Math.max(2, Atomics.load(bridge.state, control.cols)),
      rows: Math.max(2, Atomics.load(bridge.state, control.rows)),
    },
    checkActive() {
      if (runtime.disposed || readOutcome(state.signals.outcome))
        throw new Error("Shell terminal root stopped");
    },
  });
  const tasks = createTerminalTasks((error) => {
    if (runtime.disposed || !liveState(state)) {
      tasks.stop();
      return;
    }
    failed(error);
  });
  const directory = workerProcessDirectoryId(root);
  let destinations = outputs.get(runtime);
  if (!destinations) outputs.set(runtime, (destinations = new Map()));
  destinations.set(directory, bridge.buffer);
  const ownedDestinations = destinations;
  const makeEditor = (): Group => ({
    group: producer.editor,
    members: new Map(),
    jobs: new Map(),
    rootMember: producer.rootMember,
    active: true,
  });
  let editor = makeEditor();
  let selected = editor;
  let foreground: Group | undefined;
  let interruptTarget: Group | undefined;
  let delegated: { group: Group; generation: bigint } | undefined;
  let deferred: Group | undefined;
  let geometry: TerminalGeometry | undefined;
  let resizing = false;
  let waking = false;
  let cleaning = false;
  let discarding = false;
  let discarded = false;
  let discardAgain = false;
  let quiescence: Promise<void> | undefined;
  let service: Pick<ProcessService, "transportFor"> | undefined;
  const groups = new Map<number, Group>([[state.job, editor]]);
  const members = new Map<number, Group>();
  const states = new Map<number, State>();
  const exited = new Set<number>();
  const resetEditor = () => {
    editor.active = false;
    editor = makeEditor();
    groups.set(state.job, editor);
  };
  const execute = async <T>(
    work: (journal: TerminalProducerTurn, turn: TerminalControlTurn) => TerminalResult<T>,
  ): Promise<T> => {
    const result = await producer.authority.control<T>((turn) => work(producer.begin(turn), turn), {
      signal: tasks.signal,
      settled: producer.reconcile,
    });
    return terminalValue(result);
  };
  const requestWake = () => {
    if (waking) return;
    waking = true;
    void tasks.run(async () => {
      try {
        await execute((journal) => {
          journal.publish();
          return { kind: "ok", value: undefined };
        });
        bridge.signal();
      } finally {
        waking = false;
      }
    });
  };
  const resize = () => {
    if (resizing) return;
    resizing = true;
    void tasks.run(async () => {
      let completed = false;
      try {
        await execute((journal) => {
          if (!geometry) return { kind: "ok", value: undefined };
          const captured = geometry;
          const result = producer.resize(captured);
          if (result.kind === "error") return result;
          journal.publish(() => {
            if (geometry === captured) geometry = undefined;
          });
          return { kind: "ok", value: undefined };
        });
        completed = true;
      } finally {
        resizing = false;
        if (completed && geometry) resize();
      }
    });
  };
  const createGroup = (journal: TerminalProducerTurn, process: State): Group => {
    const group = terminalValue(journal.createGroup("raw"));
    const record: Group = { group, members: new Map(), jobs: new Map(), active: true };
    if (process.jobForeground && process.jobOwner === root.pid)
      record.rootMember = terminalValue(journal.admitExisting(group, root.pid)).member;
    return record;
  };
  const prepareGranted = (descendant: RuntimeDescendant, turn: TerminalControlTurn) =>
    terminalResult(() => {
      const transport = runtime.disposed ? undefined : service?.transportFor(descendant.pid);
      if (!transport) throw new TerminalOperationError("PROCESS_GONE");
      const process = workerProcessState(transport);
      const journal = producer.begin(turn);
      const previous = groups.get(descendant.job);
      const reusable =
        !previous && process.jobForeground && process.jobOwner === root.pid && foreground?.active
          ? foreground
          : previous;
      const created = !reusable;
      const record = reusable ?? createGroup(journal, process);
      const member = terminalValue(journal.admitExisting(record.group, descendant.pid)).member;
      const paused = Atomics.load(bridge.state, control.cancel) === 2;
      const selecting = created && process.jobForeground && !paused;
      if (created)
        terminalValue(
          selecting ? journal.select(record.group) : journal.startBackground(record.group),
        );
      journal.publish(() => {
        record.jobs.set(descendant.job, process.jobPending);
        record.members.set(descendant.pid, member);
        groups.set(descendant.job, record);
        members.set(descendant.pid, record);
        states.set(descendant.pid, process);
        if (!created) return;
        record.restore = selected;
        if (record.rootMember) foreground = record;
        if (process.jobForeground && paused) deferred = record;
        if (selecting) selected = record;
      });
    });
  const preparation: RootDescendantPreparation = {
    terminal: producer.authority,
    run: prepareGranted,
    settled(_descendant, completion) {
      // Rollback never published local membership. Committed ownership reaches ordinary exit.
      producer.reconcile(completion.receipt);
    },
  };
  const resumeTarget = (record: Group): Group => {
    let target = record;
    const live = (pid: number) => liveState(states.get(pid));
    while (
      target !== editor &&
      (!target.active || !Array.from(target.members.keys()).every(live) || empty(target))
    )
      target = target.restore ?? editor;
    return target;
  };
  const selectRestoreTarget = (journal: TerminalProducerTurn, record: Group): Group => {
    let target = resumeTarget(record);
    while (target !== editor) {
      const result = journal.select(target.group);
      if (result.kind === "ok") return target;
      if (result.code !== "PROCESS_GONE" || !liveState(state)) terminalValue(result);
      // A rejected ancestor can have exited since resumeTarget sampled it.
      target = resumeTarget(target.restore ?? editor);
    }
    return target;
  };
  const retireOne = (record: Group) =>
    execute((journal) =>
      terminalResult(() => {
        if (Atomics.load(bridge.state, control.cancel) === 2) return;
        if (record === editor || !record.active || !empty(record)) return;
        let target: Group | undefined;
        let restoredEditor = false;
        if (selected === record) {
          target = selectRestoreTarget(journal, record.restore ?? editor);
          restoredEditor = target === editor;
          if (restoredEditor)
            terminalValue(
              journal.restoreEditor(
                Atomics.load(bridge.state, control.phase) === 2 ? "cooked" : "raw",
              ),
            );
        }
        if (record.rootMember) terminalValue(journal.removeMember(record.rootMember));
        terminalValue(journal.retireGroup(record.group, "completed"));
        journal.publish(() => {
          if (restoredEditor) resetEditor();
          if (target) selected = restoredEditor ? editor : target;
          record.active = false;
          for (const job of record.jobs.keys()) groups.delete(job);
          if (interruptTarget === record && !record.rootMember) bridge.acknowledgeInputDiscard();
        });
      }),
    );
  const retireGroups = async () => {
    for (const record of new Set(groups.values())) await retireOne(record);
  };
  const cleanupOne = (pid: number) =>
    execute((journal) =>
      terminalResult(() => {
        const record = members.get(pid);
        const member = record?.members.get(pid);
        const status = member ? producer.memberStatus(member) : "unknown";
        if (member && status !== "removed" && status !== "stale")
          terminalValue(journal.removeMember(member));
        journal.publish(() => {
          record?.members.delete(pid);
          members.delete(pid);
          states.delete(pid);
          exited.delete(pid);
        });
      }),
    );
  const cleanExited = () => {
    if (cleaning) return;
    cleaning = true;
    void tasks.run(async () => {
      let completed = false;
      try {
        while (exited.size) await cleanupOne(exited.values().next().value!);
        await retireGroups();
        bridge.signal();
        completed = true;
      } finally {
        cleaning = false;
        if (completed && exited.size) cleanExited();
      }
    });
  };
  const setupDiscard = (): Promise<Drain> =>
    execute((journal) =>
      terminalResult(() => {
        const restore = bridge.cancelled() && interruptTarget ? editor : resumeTarget(selected);
        const group = terminalValue(journal.createGroup("cooked"));
        const member = terminalValue(journal.admitExisting(group, root.pid)).member;
        terminalValue(journal.select(group));
        terminalValue(journal.mode("raw"));
        const cursor: Drain = { kind: "drain", group, member, consumed: 0, restore };
        journal.publish();
        return cursor;
      }),
    );
  const drain = async (cursor: Drain) => {
    const bytes = new Uint8Array(4096);
    while (cursor.kind === "drain") {
      const observed = producer.observe();
      const count = await execute((journal) => {
        const count = producer.available() ? journal.read([bytes]) : 0;
        if (count > 0) cursor.consumed += count;
        if (count < 0 && count !== -6) return { kind: "error", code: "CLOSED" };
        journal.publish(() => {
          if (count === 0) cursor.kind = "restore";
        });
        return { kind: "ok", value: count };
      });
      if (count === -6) terminalValue(await observed.wait({ signal: tasks.signal }));
    }
  };
  const restoreDiscard = (cursor: Drain) =>
    execute((journal) =>
      terminalResult(() => {
        const target = selectRestoreTarget(journal, cursor.restore);
        const replacing = target === editor;
        const removed = replacing
          ? { group: journal.editor, member: journal.rootMember }
          : { group: cursor.group, member: cursor.member };
        if (replacing) journal.replaceEditor(cursor.group, cursor.member);
        terminalValue(journal.removeMember(removed.member));
        terminalValue(journal.retireGroup(removed.group, "cancelled"));
        const next = deferred?.active ? deferred : undefined;
        if (next) terminalValue(journal.select(next.group));
        journal.publish(() => {
          if (replacing) resetEditor();
          selected = next ?? (replacing ? editor : target);
          deferred = undefined;
        });
      }),
    );
  const finishDiscard = () => {
    if (discardAgain) return;
    discarded = true;
    bridge.discardInput();
    if (interruptTarget && !interruptTarget.rootMember && empty(interruptTarget))
      bridge.acknowledgeInputDiscard();
  };
  const afterDiscard = (completed: boolean) => {
    discarding = false;
    if (!completed) return;
    if (discardAgain) {
      discardAgain = false;
      discardInput();
      return;
    }
    if (delegated) resumeDelegated();
  };
  const discardInput = (): boolean => {
    if (discarded) {
      discarded = false;
      return true;
    }
    if (discarding) return false;
    discarding = true;
    void tasks.run(async () => {
      let completed = false;
      try {
        const cursor = await setupDiscard();
        await drain(cursor);
        await restoreDiscard(cursor);
        finishDiscard();
        await retireGroups();
        bridge.signal();
        completed = true;
      } finally {
        afterDiscard(completed);
      }
    });
    return false;
  };
  const restoreDelegated = (journal: TerminalProducerTurn) =>
    terminalResult(() => {
      const receipt = delegated;
      if (!receipt) return;
      if (bridge.readPrompt()?.generation !== receipt.generation) {
        delegated = undefined;
        return;
      }
      const target = resumeTarget(receipt.group);
      const reselect = target !== editor && target !== selected;
      if (reselect) {
        const result = journal.select(target.group);
        if (result.kind === "error" && result.code !== "PROCESS_GONE") terminalValue(result);
      }
      if (target === editor && Atomics.load(bridge.state, control.phase) === 2)
        terminalValue(journal.mode("cooked"));
      journal.publish(() => {
        if (reselect) selected = target;
        delegated = undefined;
        bridge.acknowledgeInputDiscard();
      });
    });
  const resumeDelegated = () => {
    void tasks.run(async () => {
      await execute(restoreDelegated);
      bridge.signal();
    });
  };
  const interruptDelegated = (generation: bigint) => {
    if (!tasks.accepting || bridge.closed()) return;
    if (bridge.readPrompt()?.generation !== generation) return;
    const group = foreground?.active ? foreground : interruptTarget;
    if (!group) return;
    delegated = { group, generation };
    if (discarding) return;
    resumeDelegated();
  };
  const disconnect = bridge.connectInput({
    push(bytes) {
      const result = producer.pushKeyboard(bytes);
      if (
        result.kind === "error" &&
        result.code === "AGAIN" &&
        producer.canPush(bytes.length - result.accepted)
      )
        requestWake();
      return result.kind === "ok" ? result.value : result.accepted;
    },
    available: producer.available,
    wake: producer.wake,
    close: producer.closeInput,
    resize(columns, rows) {
      geometry = { columns, rows };
      resize();
    },
    interrupt() {
      interruptTarget = selected;
      delegated = undefined;
      if (discarding) discardAgain = true;
    },
    discard: discardInput,
  });
  void tasks.run(async () => {
    while (tasks.accepting) {
      const observed = producer.observe();
      terminalValue(await observed.wait({ signal: tasks.signal }));
      bridge.signal();
    }
  });
  return {
    metadata: producer.rootMetadata,
    prepareDescendant: preparation,
    bind(processes: Pick<ProcessService, "transportFor">) {
      service = processes;
    },
    interruptDelegated,
    foregroundJobs() {
      const target = bridge.cancelled() && interruptTarget ? interruptTarget : selected;
      if (target.rootMember) return;
      return empty(target) ? [] : Array.from(target.jobs.keys());
    },
    exited(pid: number) {
      if (!tasks.accepting) return;
      if (pid === root.pid || readOutcome(state.signals.outcome)) {
        tasks.stop();
        return;
      }
      exited.add(pid);
      cleanExited();
    },
    stop: tasks.stop,
    quiesce() {
      return (quiescence ??= (async () => {
        await tasks.join();
        producer.dispose();
        disconnect();
        groups.clear();
        members.clear();
        states.clear();
        exited.clear();
      })());
    },
    retired() {
      ownedDestinations.delete(directory);
    },
  };
}
