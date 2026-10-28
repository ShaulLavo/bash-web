import type { ProcessService, Runtime } from "waffle";
import type { RuntimeRootOptions } from "waffle/browser/process-broker";
import type {
  TerminalGroup,
  TerminalMember,
  TerminalResult,
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
import { createTerminalProducer, TerminalOperationError } from "./terminal-producer";

const outputs = new WeakMap<Runtime, Map<string, SharedArrayBuffer>>();
export function shellTerminalOutput(runtime: Runtime, transport: WorkerProcessTransport) {
  return outputs.get(runtime)?.get(workerProcessDirectoryId(transport));
}
function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(`Terminal control failed: ${result.code}`);
  return result.value;
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
function pending(cell: State["jobPending"]): boolean {
  try {
    return controlLoad(cell) !== 0;
  } catch (error) {
    if (error instanceof ProcessError && error.errno === ProcessErrno.SRCH) return false;
    throw error;
  }
}
function tryDiscard(
  producer: ReturnType<typeof createTerminalProducer>,
  group: TerminalGroup,
): boolean {
  try {
    return producer.discardInput(group);
  } catch (error) {
    if (error instanceof TerminalOperationError && error.code === "AGAIN") return false;
    throw error;
  }
}
function completed(result: TerminalResult<unknown>, retry: () => void): boolean {
  if (result.kind === "ok") return true;
  if (result.code === "AGAIN") {
    retry();
    return false;
  }
  throw new TerminalOperationError(result.code);
}
function liveState(state: State | undefined): boolean {
  if (!state) return false;
  try {
    return !readOutcome(state.signals.outcome);
  } catch (error) {
    if (error instanceof ProcessError && error.errno === ProcessErrno.SRCH) return false;
    throw error;
  }
}

export function createTerminalController(
  runtime: Runtime,
  root: WorkerProcessTransport,
  bridge: SharedBridge,
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
  const directory = workerProcessDirectoryId(root);
  let destinations = outputs.get(runtime);
  if (!destinations) outputs.set(runtime, (destinations = new Map()));
  destinations.set(directory, bridge.buffer);
  const ownedDestinations = destinations;
  let editor: Group = {
    group: producer.editor,
    members: new Map(),
    jobs: new Map(),
    rootMember: producer.rootMember,
    active: true,
  };
  let selected = editor;
  let foreground: Group | undefined;
  let disposed = false;
  let interruptTarget: Group | undefined;
  let deferred: Group | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const groups = new Map<number, Group>([[state.job, editor]]);
  const members = new Map<number, Group>();
  const states = new Map<number, State>();
  const exited = new Set<number>();
  const resetEditor = () => {
    editor.active = false;
    editor = {
      group: producer.editor,
      members: new Map(),
      jobs: new Map(),
      rootMember: producer.rootMember,
      active: true,
    };
    groups.set(state.job, editor);
  };
  const disconnect = bridge.connectInput({
    push(bytes) {
      const result = producer.pushKeyboard(bytes);
      return result.kind === "ok" ? result.value : result.accepted;
    },
    available: producer.available,
    wake: producer.wake,
    close: producer.closeInput,
    resize: (columns, rows) => {
      must(producer.resize({ columns, rows }));
    },
    interrupt() {
      interruptTarget = selected;
    },
    discard: () => discardInput(),
  });
  const wakeInput = () => {
    if (!disposed) {
      bridge.signal();
      watch();
    }
  };
  const watch = () => {
    if (disposed) return;
    const sequence = Atomics.load(producer.notification, 0);
    const wait = Atomics.waitAsync(producer.notification, 0, sequence);
    if (wait.async) void wait.value.then(wakeInput);
    else queueMicrotask(watch);
  };
  watch();

  const createGroup = (process: State): Group => {
    const group = must(producer.createGroup("cooked"));
    const record: Group = { group, members: new Map(), jobs: new Map(), active: true };
    if (process.jobForeground && process.jobOwner === root.pid) {
      record.rootMember = must(producer.admitExisting(group, root.pid)).member;
      foreground = record;
    }
    return record;
  };
  const prepareDescendant: NonNullable<RuntimeRootOptions["prepareDescendant"]> = (descendant) => {
    const transport = runtime.disposed ? undefined : service?.transportFor(descendant.pid);
    if (!transport) throw new Error("Terminal descendant has no admitted transport");
    const process = workerProcessState(transport);
    let record = groups.get(descendant.job);
    if (!record && process.jobForeground && process.jobOwner === root.pid && foreground?.active)
      record = foreground;
    const created = !record;
    if (!record) record = createGroup(process);
    groups.set(descendant.job, record);
    record.jobs.set(descendant.job, process.jobPending);
    const admitted = must(producer.admitExisting(record.group, descendant.pid));
    record.members.set(descendant.pid, admitted.member);
    members.set(descendant.pid, record);
    states.set(descendant.pid, process);
    if (!created) return undefined;
    record.restore = selected;
    const paused = Atomics.load(bridge.state, control.cancel) === 2;
    if (process.jobForeground && paused) deferred = record;
    if (!process.jobForeground || paused) {
      must(producer.startBackground(record.group));
      return undefined;
    }
    must(producer.select(record.group));
    selected = record;
    return undefined;
  };
  let service: ProcessService | undefined;
  const empty = (record: Group) =>
    record.members.size === 0 && !Array.from(record.jobs.values()).some(pending);
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
  const retryDiscard = () => {
    if (retry || disposed) return;
    retry = setTimeout(retryWork, 1);
  };
  const cleanupOne = (pid: number) => {
    const record = members.get(pid);
    if (!record) {
      exited.delete(pid);
      return;
    }
    if (!completed(producer.removeMember(record.members.get(pid)!), retryDiscard)) return;
    members.delete(pid);
    states.delete(pid);
    record.members.delete(pid);
    exited.delete(pid);
  };
  const retryWork = () => {
    retry = undefined;
    if (disposed) return;
    bridge.discardInput();
    for (const pid of exited) cleanupOne(pid);
    for (const group of new Set(groups.values())) retire(group);
    bridge.signal();
  };
  const finishDiscard = () => {
    if (disposed) return;
    for (const group of new Set(groups.values())) retire(group);
    if (interruptTarget && !interruptTarget.rootMember && empty(interruptTarget))
      bridge.acknowledgeInputDiscard();
    producer.wake();
  };
  const discardInput = (): boolean => {
    const target = resumeTarget(selected);
    if (!tryDiscard(producer, target.group)) {
      retryDiscard();
      return false;
    }
    if (target === editor) {
      resetEditor();
    }
    selected = target.active ? target : editor;
    if (deferred?.active) {
      must(producer.select(deferred.group));
      selected = deferred;
    }
    deferred = undefined;
    queueMicrotask(finishDiscard);
    return true;
  };
  const retire = (record: Group) => {
    if (Atomics.load(bridge.state, control.cancel) === 2) return;
    if (
      record === editor ||
      !record.active ||
      record.members.size ||
      Array.from(record.jobs.values()).some(pending)
    )
      return;
    if (selected === record && !restore(record)) return;
    if (record.rootMember && !completed(producer.removeMember(record.rootMember), retryDiscard))
      return;
    if (!completed(producer.retireGroup(record.group, "completed"), retryDiscard)) return;
    record.active = false;
    for (const job of record.jobs.keys()) groups.delete(job);
    if (
      interruptTarget === record &&
      !record.rootMember &&
      Atomics.load(bridge.state, control.cancel) === 1
    )
      bridge.acknowledgeInputDiscard();
  };
  const restore = (record: Group) => {
    let previous = record.restore;
    while (previous && !previous.active) previous = previous.restore;
    if (previous && previous !== editor) {
      must(producer.select(previous.group));
      selected = previous;
      return true;
    }
    if (!completed(producer.restoreEditor(), retryDiscard)) return false;
    resetEditor();
    selected = editor;
    return true;
  };
  return {
    metadata: producer.rootMetadata,
    prepareDescendant,
    bind(processes: ProcessService) {
      service = processes;
    },
    foregroundJobs() {
      const target = bridge.cancelled() && interruptTarget ? interruptTarget : selected;
      if (target.rootMember) return;
      return empty(target) ? [] : Array.from(target.jobs.keys());
    },
    exited(pid: number) {
      if (disposed) return;
      if (pid === root.pid || readOutcome(state.signals.outcome)) {
        this.dispose();
        return;
      }
      exited.add(pid);
      cleanupOne(pid);
      for (const group of new Set(groups.values())) retire(group);
      bridge.signal();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(retry);
      producer.dispose();
      disconnect();
      groups.clear();
      members.clear();
      states.clear();
      exited.clear();
    },
    retired() {
      ownedDestinations.delete(directory);
    },
  };
}
