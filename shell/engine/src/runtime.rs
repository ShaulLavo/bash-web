//! Original runtime_proc adapter. Every task operation is immediate; only the
//! embedding's reactor turn calls the blocking `poll` import. Descriptors from
//! preview1 path_open, runtime pipes and inherited stdio share one namespace.
use crate::{
    executor::{Cancel, Executor, JoinHandle},
    io::{Endpoint, FdTable, FileMetadata, FileSystem, HostEndpoint, IoError, OpenOptions},
    process::{GroupId, ProcessError, ProcessHost, ProcessId, SpawnRequest},
};
use futures::{
    FutureExt,
    future::{LocalBoxFuture, WeakShared},
};
use serde::Serialize;
pub use support::{PollEvent, Subscription};
#[cfg(test)]
use support::{decode_descriptor_kind, decode_filestat, decode_permissions};
use waffle_program_support::runtime as support;

type WaitFuture = LocalBoxFuture<'static, Result<(), ProcessError>>;
type WaitRegistry = RefCell<BTreeMap<GroupId, WeakShared<WaitFuture>>>;

use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    rc::{Rc, Weak},
};

#[cfg(target_os = "wasi")]
mod wasi;
#[cfg(target_os = "wasi")]
pub use wasi::WasiAbi;

const AGAIN: i32 = 6;
// runtime/proc/signals.ts: DEFAULT=0, IGNORE=1, HANDLE=2. This is a
// disposition, not the signal number or the self-signal operation (mode 3).
#[cfg(any(target_os = "wasi", test))]
const SIGNAL_DISPOSITION_HANDLE: i32 = 2;
#[cfg(any(target_os = "wasi", test))]
fn register_interrupt_handler(signal: impl FnOnce(i32, i32) -> i32) -> Result<(), i32> {
    register_handler(SIGINT, signal)
}
#[cfg(any(target_os = "wasi", test))]
fn register_handler(number: i32, signal: impl FnOnce(i32, i32) -> i32) -> Result<(), i32> {
    match signal(number, SIGNAL_DISPOSITION_HANDLE) {
        result if result < 0 => Err(-result),
        _ => Ok(()),
    }
}
const SIGINT: i32 = 2;
/// Handled only by a shell whose prompt the page redraws; it wakes the prompt reader.
pub const SIGWINCH: i32 = 28;

#[derive(Clone, Debug, Serialize)]
pub struct Binding {
    pub child: u32,
    pub parent: u32,
}
#[derive(Clone, Debug, Serialize)]
pub struct RuntimeSpawn {
    pub executable: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub job: i32,
    pub fds: Vec<Binding>,
}
/// The runtime_proc waits share one eight-byte little-endian terminal record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitResult {
    Exited(i32),
    Signaled(i32),
    StartFailed(i32),
}
impl WaitResult {
    pub fn decode(bytes: [u8; 8]) -> Result<Self, i32> {
        let kind = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let value = i32::from_le_bytes(bytes[4..].try_into().unwrap());
        match kind {
            0 => Ok(Self::Exited(value)),
            1 => Ok(Self::Signaled(value)),
            2 => Ok(Self::StartFailed(value)),
            _ => Err(28),
        }
    }
}
/// Injectable boundary keeps native engine tests independent of WASM imports.
/// Errnos are positive WASI errnos here; the WASM adapter decodes negative results.
/// `wait_job` confirms descendant teardown and reaps runtime-owned tombstones.
pub trait Abi: support::Abi {
    fn access_start(&self, path: &str, cwd: &str) -> Result<u32, i32>;
    fn access_take(&self, request: u32) -> Result<(), i32>;
    fn access_cancel(&self, request: u32);
    fn spawn(&self, request: &RuntimeSpawn) -> Result<u32, i32>;
    fn job_of(&self, pid: u32) -> Result<u32, i32>;
    /// Zero means entry committed; positive values are startup errnos.
    /// Negative ABI results are represented as Err, including pending EAGAIN.
    fn start_status(&self, pid: u32) -> Result<i32, i32>;
    fn wait(&self, pid: u32) -> Result<WaitResult, i32>;
    /// Nonblocking runtime wait_job with NOHANG=1. EAGAIN until all members exit.
    fn wait_job(&self, job: u32) -> Result<WaitResult, i32>;
    fn kill(&self, pid: u32, signal: i32) -> Result<(), i32>;
    fn kill_job(&self, job: u32, signal: i32) -> Result<(), i32>;
}
struct Group {
    // Runtime jobs seal when their last member exits. A shell group may start
    // later commands, so each direct child owns a job (including its descendants).
    runtime_jobs: Vec<u32>,
    background: bool,
    closing: bool,
    cleanup_failed: bool,
}

const MAX_RETAINED_PROCESSES: usize = 4096;
const INPUT_UNIT_BYTES: usize = 4096;

struct InputSlot {
    used: Rc<Cell<usize>>,
    units: usize,
    bytes: usize,
}
impl InputSlot {
    fn grow(&mut self, bytes: usize, children: usize) -> Result<(), ProcessError> {
        let total = self
            .bytes
            .checked_add(bytes)
            .ok_or(ProcessError::ProcessLimit)?;
        let units = total.div_ceil(INPUT_UNIT_BYTES);
        let extra = units - self.units;
        if self
            .used
            .get()
            .saturating_add(extra)
            .saturating_add(children)
            .saturating_add(1)
            > MAX_RETAINED_PROCESSES
        {
            return Err(ProcessError::ProcessLimit);
        }
        self.used.set(self.used.get() + extra);
        self.units = units;
        self.bytes = total;
        Ok(())
    }
    fn restore(&mut self, bytes: usize) {
        let units = bytes.div_ceil(INPUT_UNIT_BYTES);
        self.used.set(self.used.get() - (self.units - units));
        self.bytes = bytes;
        self.units = units;
    }
}
impl Drop for InputSlot {
    fn drop(&mut self) {
        self.used.set(self.used.get() - self.units);
    }
}

struct PreparedInput {
    source: Endpoint,
    reader: Endpoint,
    cancel: Cancel,
    future: LocalBoxFuture<'static, Result<(), IoError>>,
    slot: InputSlot,
    users: Vec<GroupId>,
}

struct InputPump {
    cancel: Cancel,
    join: JoinHandle<Result<(), IoError>>,
    _slot: InputSlot,
    reader: Weak<dyn HostEndpoint>,
    users: Vec<GroupId>,
}
impl InputPump {
    fn reserve_user(&mut self, group: GroupId, children: usize) -> Result<(), ProcessError> {
        if self.users.contains(&group) || self.users.len() < self.users.capacity() {
            return Ok(());
        }
        let bytes = self._slot.bytes;
        self._slot.grow(std::mem::size_of::<GroupId>(), children)?;
        if self.users.try_reserve_exact(1).is_err() {
            self._slot.restore(bytes);
            return Err(ProcessError::ProcessLimit);
        }
        Ok(())
    }
    fn unowned(&self) -> bool {
        self.users.is_empty() && self.reader.strong_count() == 0
    }
}
impl Drop for InputPump {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn input_future(source: Endpoint, writer: Endpoint, cancel: Cancel) -> Result<(), IoError> {
    let mut buffer = [0; 1024];
    loop {
        let count = source.read_cancelled(&mut buffer, &cancel).await?;
        if count == 0 {
            return Ok(());
        }
        writer.write_all(&buffer[..count], &cancel).await?;
    }
}

fn input_future_bytes<F>(_: &impl FnOnce(Endpoint, Endpoint, Cancel) -> F) -> usize {
    std::mem::size_of::<F>()
}
struct Child {
    group: GroupId,
    job: Option<u32>,
    /// A member of the shell's own job: signalled by PID, never reaped as a job.
    joined: bool,
    status: Cell<Option<Result<crate::process::ChildExit, i32>>>,
}
struct State {
    abi: Rc<dyn Abi>,
    executor: Executor,
    support: support::Runtime,
    next_group: Cell<GroupId>,
    groups: RefCell<BTreeMap<GroupId, Group>>,
    children: RefCell<BTreeMap<ProcessId, Rc<Child>>>,
    waits: WaitRegistry,
    input_slots: Rc<Cell<usize>>,
    inputs: RefCell<Vec<InputPump>>,
    job_control: Cell<bool>,
    window_changed: Cell<bool>,
}
#[derive(Clone)]
pub struct Runtime(Rc<State>);
impl Runtime {
    pub fn new(abi: Rc<dyn Abi>, executor: Executor) -> Self {
        Self(Rc::new(State {
            support: support::Runtime::new(abi.clone()),
            abi,
            executor,
            next_group: Cell::new(1),
            groups: RefCell::new(BTreeMap::new()),
            children: RefCell::new(BTreeMap::new()),
            waits: RefCell::new(BTreeMap::new()),
            input_slots: Rc::new(Cell::new(0)),
            inputs: RefCell::new(Vec::new()),
            job_control: Cell::new(true),
            window_changed: Cell::new(false),
        }))
    }
    /// Without job control (`sh -c`, scripts), foreground commands stay in the shell's
    /// own job, as POSIX keeps them in its process group, so a signal to the caller's
    /// job reaches them. Only a job-control shell gives each command a new job.
    pub fn set_job_control(&self, enabled: bool) {
        self.0.job_control.set(enabled);
    }
    /// Own one fd binding. Endpoint clones share it; the final clone closes it.
    pub fn endpoint(&self, fd: u32) -> Endpoint {
        self.0.support.endpoint(fd)
    }
    pub fn stdio(&self) -> Result<FdTable, IoError> {
        self.0.support.stdio()
    }
    pub fn take_stdio(&self) -> Result<FdTable, IoError> {
        self.0.support.take_stdio()
    }
    fn access_future(
        &self,
        path: String,
        cwd: String,
    ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        let runtime = self.clone();
        async move {
            let request = runtime
                .0
                .abi
                .access_start(&path, &cwd)
                .map_err(ProcessError::Runtime)?;
            let guard = AccessGuard {
                runtime: runtime.clone(),
                request,
                retired: Cell::new(false),
            };
            loop {
                match runtime.0.abi.access_take(request) {
                    Ok(()) => {
                        guard.retired.set(true);
                        return Ok(());
                    }
                    Err(AGAIN) => runtime.0.support.ready(5, request).await,
                    Err(errno) => {
                        guard.retired.set(true);
                        return Err(ProcessError::Runtime(errno));
                    }
                }
            }
        }
        .boxed_local()
    }
    /// Drive only BETWEEN executor turns. With timeout 0 this never blocks;
    /// timeout -1 parks until host readiness or a signal. No task calls poll.
    pub fn poll(&self, timeout: i32) -> Result<usize, i32> {
        self.0
            .inputs
            .borrow_mut()
            .retain(|input| !input.join.is_finished());
        self.0.support.poll(timeout)
    }
    /// Dequeues handled signals until an interrupt or none is left. A SIGWINCH taken
    /// here, including at a budget checkpoint, is kept for `take_window_change`.
    pub fn take_interrupt(&self) -> bool {
        loop {
            match self.0.abi.interrupted() {
                SIGWINCH => self.0.window_changed.set(true),
                signal => return signal == SIGINT,
            }
        }
    }
    pub fn take_window_change(&self) -> bool {
        self.0.window_changed.take()
    }
    fn group(&self, background: bool) -> GroupId {
        let id = self.0.next_group.get();
        self.0
            .next_group
            .set(id.checked_add(1).expect("group id exhausted"));
        self.0.groups.borrow_mut().insert(
            id,
            Group {
                runtime_jobs: Vec::new(),
                background,
                closing: false,
                cleanup_failed: false,
            },
        );
        id
    }
    pub fn retained_count(&self) -> usize {
        self.0.children.borrow().len()
    }
    fn retained_slots(&self) -> usize {
        let jobs: usize = self
            .0
            .groups
            .borrow()
            .values()
            // A sweep may heal the last ABI job after a failed drain. Its
            // logical group/input ownership still needs a successful retry;
            // do not release the final admission slot before that teardown.
            .map(|group| {
                group
                    .runtime_jobs
                    .len()
                    .max(usize::from(group.cleanup_failed))
            })
            .sum();
        // Joined children and metadata failures own a direct pid without a runtime job ID.
        jobs.saturating_add(
            self.0
                .children
                .borrow()
                .values()
                .filter(|child| child.job.is_none())
                .count(),
        )
    }
    fn try_reap_job(&self, group: GroupId, job: u32) -> Result<(), i32> {
        if !self
            .0
            .groups
            .borrow()
            .get(&group)
            .is_some_and(|group| group.runtime_jobs.contains(&job))
        {
            return Ok(());
        }
        self.0.abi.wait_job(job)?;
        if let Some(group) = self.0.groups.borrow_mut().get_mut(&group) {
            group.runtime_jobs.retain(|retained| *retained != job);
        }
        // An admission sweep can consume a job observed by a parked group drain.
        // Wake those observers locally: polling its now-reaped ABI ID is invalid.
        self.0.support.notify(4, job);
        Ok(())
    }

    fn reap_finished_jobs(&self) {
        // One NOHANG attempt per residual job, bounded by the admission limit.
        // Never reap a job before its direct child's status has been consumed:
        // wait_job also removes that child's runtime-owned tombstone.
        let direct: BTreeSet<_> = self
            .0
            .children
            .borrow()
            .values()
            .filter_map(|child| child.job)
            .collect();
        let jobs: Vec<_> = self
            .0
            .groups
            .borrow()
            .iter()
            .flat_map(|(&id, group)| {
                group
                    .runtime_jobs
                    .iter()
                    .filter(|job| !direct.contains(job))
                    .map(move |&job| (id, job))
            })
            .collect();
        for (group, job) in jobs {
            // EAGAIN and errors both retain the cleanup/signal handle for retry.
            let _ = self.try_reap_job(group, job);
        }
    }

    fn prepare_input(
        &self,
        source: &Endpoint,
        payload: usize,
    ) -> Result<PreparedInput, ProcessError> {
        self.reap_finished_jobs();
        // Include retained payload, the concrete pump, queue/task metadata and
        // vector slots. Input owners share the existing bounded process slots.
        let bytes = payload
            .checked_add(input_future_bytes(&input_future))
            .and_then(|n| {
                n.checked_add(INPUT_UNIT_BYTES + 16 * std::mem::size_of::<PreparedInput>())
            })
            .ok_or(ProcessError::ProcessLimit)?;
        let units = bytes.div_ceil(INPUT_UNIT_BYTES);
        let used = self
            .0
            .input_slots
            .get()
            .checked_add(units)
            .ok_or(ProcessError::ProcessLimit)?;
        if used.saturating_add(self.retained_slots()).saturating_add(1) > MAX_RETAINED_PROCESSES {
            return Err(ProcessError::ProcessLimit);
        }
        self.0.input_slots.set(used);
        let slot = InputSlot {
            used: self.0.input_slots.clone(),
            units,
            bytes,
        };
        let (reader, writer) = self.pipe().map_err(|_| ProcessError::Runtime(8))?;
        let cancel = Cancel::new();
        let mut users = Vec::new();
        users
            .try_reserve_exact(1)
            .map_err(|_| ProcessError::ProcessLimit)?;
        let future = input_future(source.buffered_source(), writer, cancel.clone());
        Ok(PreparedInput {
            source: source.clone(),
            reader,
            cancel,
            future: future.boxed_local(),
            slot,
            users,
        })
    }

    fn input_binding(
        &self,
        endpoint: &Endpoint,
        inputs: &mut Vec<PreparedInput>,
    ) -> Result<u32, ProcessError> {
        if let Some(fd) = endpoint.runtime_fd() {
            return Ok(fd);
        }
        let payload = endpoint
            .buffered_input_bytes()
            .ok_or(ProcessError::Runtime(8))?;
        if let Some(input) = inputs.iter().find(|input| input.source.same_open(endpoint)) {
            return Ok(input.reader.runtime_fd().expect("host pipe descriptor"));
        }
        let input = self.prepare_input(endpoint, payload)?;
        inputs
            .try_reserve_exact(1)
            .map_err(|_| ProcessError::ProcessLimit)?;
        let fd = input.reader.runtime_fd().expect("host pipe descriptor");
        inputs.push(input);
        Ok(fd)
    }
}
struct AccessGuard {
    runtime: Runtime,
    request: u32,
    retired: Cell<bool>,
}
impl Drop for AccessGuard {
    fn drop(&mut self) {
        if !self.retired.get() {
            self.runtime.0.abi.access_cancel(self.request);
            self.retired.set(true);
        }
    }
}

impl FileSystem for Runtime {
    fn open_dir<'a>(
        &'a self,
        path: &'a str,
    ) -> LocalBoxFuture<'a, Result<Rc<dyn crate::io::Directory>, IoError>> {
        self.0.support.open_dir(path)
    }
    fn stat<'a>(
        &'a self,
        path: &'a str,
        follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
        self.0.support.stat(path, follow_symlinks)
    }
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), IoError>> {
        self.0.support.mkdir(path, parents)
    }
    fn pipe(&self) -> Result<(Endpoint, Endpoint), IoError> {
        self.0.support.pipe()
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        self.0.support.open(path, options)
    }
}
impl ProcessHost for Runtime {
    fn access(
        &self,
        path: String,
        cwd: String,
    ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        self.access_future(path, cwd)
    }
    fn allocate_group(&self) -> GroupId {
        self.group(false)
    }
    fn allocate_background_group(&self) -> GroupId {
        self.group(true)
    }
    fn interrupted(&self) -> bool {
        self.take_interrupt()
    }
    fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError> {
        self.reap_finished_jobs();
        self.0
            .inputs
            .borrow_mut()
            .retain(|input| !input.join.is_finished());
        if self
            .retained_slots()
            .saturating_add(self.0.input_slots.get())
            >= MAX_RETAINED_PROCESSES
        {
            return Err(ProcessError::ProcessLimit);
        }
        // The ABI's caller is always the shell. A synthetic parent would silently
        // change signal authority and is not representable by this ABI.
        if let Some(parent) = request.parent {
            return Err(ProcessError::InvalidParent(parent));
        }
        let background = self
            .0
            .groups
            .borrow()
            .get(&request.group)
            .filter(|group| !group.closing)
            .map(|group| group.background)
            .ok_or(ProcessError::GroupClosed(request.group))?;
        if request.executable.is_empty() {
            return Err(ProcessError::UnknownCommand(String::new()));
        }
        let mut inputs = Vec::new();
        let mut fds = Vec::new();
        fds.try_reserve_exact(request.fds.iter().count())
            .map_err(|_| ProcessError::ProcessLimit)?;
        for (&child, endpoint) in request.fds.iter() {
            fds.push(Binding {
                child,
                parent: self.input_binding(endpoint, &mut inputs)?,
            });
        }
        self.0
            .inputs
            .borrow_mut()
            .retain(|input| !input.join.is_finished());
        self.0
            .inputs
            .borrow_mut()
            .try_reserve_exact(inputs.len())
            .map_err(|_| ProcessError::ProcessLimit)?;
        for input in self.0.inputs.borrow_mut().iter_mut() {
            let used = request.fds.iter().any(|(_, endpoint)| {
                endpoint
                    .host_owner()
                    .is_some_and(|owner| owner.ptr_eq(&input.reader))
            });
            if used {
                input.reserve_user(request.group, self.retained_slots())?;
            }
        }
        let joined = !background && !self.0.job_control.get();
        let job = match (background, joined) {
            (true, _) => -1,
            (false, true) => self.0.abi.job_of(0).map_err(ProcessError::Runtime)? as i32,
            (false, false) => 0,
        };
        let spec = RuntimeSpawn {
            executable: request.executable,
            argv: request.argv,
            env: request.env,
            cwd: request.cwd,
            job,
            fds,
        };
        let pid = self.0.abi.spawn(&spec).map_err(ProcessError::Runtime)?;
        // Spawn has synchronously retained inherited endpoints. Dropping request's
        // descriptor table now cannot close the child's open descriptions.
        let runtime_job = match if joined {
            Ok(None)
        } else {
            self.0.abi.job_of(pid).map(Some)
        } {
            Ok(job) => job,
            Err(errno) => {
                // Do not strand a reserved process when host metadata fails.
                let _ = self.0.abi.kill(pid, 9);
                self.0.children.borrow_mut().insert(
                    pid as u64,
                    Rc::new(Child {
                        group: request.group,
                        job: None,
                        joined: false,
                        status: Cell::new(None),
                    }),
                );
                self.abandon_group(request.group, 9);
                return Err(ProcessError::Runtime(errno));
            }
        };
        if let Some(runtime_job) = runtime_job {
            self.0
                .groups
                .borrow_mut()
                .get_mut(&request.group)
                .unwrap()
                .runtime_jobs
                .push(runtime_job);
        }
        // Only a successful spawn starts writers. Failure before this point
        // drops unpolled futures and closes both pipe ends synchronously.
        // Cache the exported open description so later builtin/external reads
        // and aliases share the pipe's actual read position, not pump read-ahead.
        for input in inputs {
            input.source.export_buffer(&input.reader);
            let reader = input.reader.host_owner().expect("host input reader");
            let mut users = input.users;
            users.push(request.group);
            let pump = InputPump {
                cancel: input.cancel,
                join: self.0.executor.spawn(input.future),
                _slot: input.slot,
                reader,
                users,
            };
            self.0.inputs.borrow_mut().push(pump);
        }
        for input in self.0.inputs.borrow_mut().iter_mut() {
            let used = request.fds.iter().any(|(_, endpoint)| {
                endpoint
                    .host_owner()
                    .is_some_and(|owner| owner.ptr_eq(&input.reader))
            });
            if used && !input.users.contains(&request.group) {
                input.users.push(request.group);
            }
        }
        self.0.children.borrow_mut().insert(
            pid as u64,
            Rc::new(Child {
                group: request.group,
                job: runtime_job,
                joined,
                status: Cell::new(None),
            }),
        );
        Ok(pid as u64)
    }
    fn wait_start(&self, pid: ProcessId) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        let runtime = self.clone();
        async move {
            if !runtime.0.children.borrow().contains_key(&pid) {
                return Err(ProcessError::UnknownProcess(pid));
            }
            loop {
                match runtime.0.abi.start_status(pid as u32) {
                    Ok(0) => return Ok(()),
                    Ok(errno) => return Err(ProcessError::StartFailed(errno)),
                    Err(AGAIN) => runtime.0.support.ready(6, pid as u32).await,
                    Err(errno) => return Err(ProcessError::Runtime(errno)),
                }
            }
        }
        .boxed_local()
    }
    fn wait(
        &self,
        pid: ProcessId,
    ) -> LocalBoxFuture<'static, Result<crate::process::ChildExit, ProcessError>> {
        let child = self.0.children.borrow().get(&pid).cloned();
        let runtime = self.clone();
        async move {
            let child = child.ok_or(ProcessError::UnknownProcess(pid))?;
            loop {
                if let Some(status) = child.status.get() {
                    return status.map_err(ProcessError::StartFailed);
                }
                match runtime.0.abi.wait(pid as u32) {
                    Ok(result) => {
                        let status = match result {
                            WaitResult::Exited(code) => Ok(crate::process::ChildExit::Exited(code)),
                            WaitResult::Signaled(signal) => {
                                Ok(crate::process::ChildExit::Signaled(signal))
                            }
                            WaitResult::StartFailed(errno) => Err(errno),
                        };
                        child.status.set(Some(status));
                        runtime.0.children.borrow_mut().remove(&pid);
                        if let Some(job) = child.job {
                            let _ = runtime.try_reap_job(child.group, job);
                        }
                        return status.map_err(ProcessError::StartFailed);
                    }
                    Err(AGAIN) => runtime.0.support.ready(2, pid as u32).await,
                    Err(errno) => return Err(ProcessError::Runtime(errno)),
                }
            }
        }
        .boxed_local()
    }
    fn signal_child(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
        let child = self
            .0
            .children
            .borrow()
            .get(&pid)
            .cloned()
            .ok_or(ProcessError::UnknownProcess(pid))?;
        let result = match child.job {
            Some(job) => self.0.abi.kill_job(job, signal),
            None => self.0.abi.kill(pid as u32, signal),
        };
        result.map_err(ProcessError::Runtime)
    }
    fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
        if !self.0.children.borrow().contains_key(&pid) {
            return Err(ProcessError::UnknownProcess(pid));
        }
        self.0
            .abi
            .kill(pid as u32, signal)
            .map_err(ProcessError::Runtime)
    }
    fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError> {
        // runtime_proc accepts signals 1..64, not signal-zero existence probes.
        // An invalid request must not close admission to an otherwise live group.
        if !(1..=64).contains(&signal) {
            return Err(ProcessError::InvalidSignal);
        }
        let jobs = self.0.groups.borrow_mut().get_mut(&group).map(|group| {
            group.closing = true;
            group.runtime_jobs.clone()
        });
        let joined: Vec<_> = self
            .0
            .children
            .borrow()
            .iter()
            .filter(|(_, child)| child.group == group && child.joined)
            .map(|(&pid, _)| pid as u32)
            .collect();
        let mut error = None;
        for job in jobs.into_iter().flatten() {
            if let Err(errno) = self.0.abi.kill_job(job, signal) {
                // One failed delivery must not strand later children/descendants.
                error.get_or_insert(ProcessError::Runtime(errno));
            }
        }
        for pid in joined {
            if let Err(errno) = self.0.abi.kill(pid, signal) {
                error.get_or_insert(ProcessError::Runtime(errno));
            }
        }
        error.map_or(Ok(()), Err)
    }
    fn wait_direct_group(
        &self,
        group: GroupId,
    ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        let direct: Vec<_> = self
            .0
            .children
            .borrow()
            .iter()
            .filter(|(_, child)| child.group == group)
            .map(|(&pid, _)| self.wait(pid))
            .collect();
        Box::pin(async move {
            for result in futures::future::join_all(direct).await {
                // A typed startup failure is a consumed terminal child result,
                // not a failure to observe/reap that child. `wait(pid)` reports
                // it to the command; group waits own only lifecycle cleanup.
                if let Err(error) = result
                    && !matches!(error, ProcessError::StartFailed(_))
                {
                    return Err(error);
                }
            }
            Ok(())
        })
    }
    fn detach_group(&self, group: GroupId) -> JoinHandle<Result<(), ProcessError>> {
        // Reap already-empty groups synchronously; a pending drain remains
        // shared and is then driven by the host-owned executor task.
        let ready = self.wait_group(group).now_or_never();
        match ready {
            Some(result) => JoinHandle::ready(result),
            None => self.0.executor.spawn(self.wait_group(group)),
        }
    }
    fn wait_group(&self, group: GroupId) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        // Observers share a drain, but the cache must not own a future that
        // captures this host. Detach/abandon own their strong handles separately.
        // Prune dropped observations so dead weak entries cannot accumulate.
        self.0
            .waits
            .borrow_mut()
            .retain(|_, wait| wait.upgrade().is_some());
        if let Some(wait) = self
            .0
            .waits
            .borrow()
            .get(&group)
            .and_then(WeakShared::upgrade)
        {
            return wait.boxed_local();
        }
        let runtime = self.clone();
        let owner = self.clone();
        let drain = async move {
            let mut error = None;
            let mut failed_jobs = Vec::new();
            loop {
                let batch: Vec<_> = runtime
                    .0
                    .children
                    .borrow()
                    .iter()
                    .filter(|(_, child)| child.group == group)
                    .map(|(&pid, _)| runtime.wait(pid))
                    .collect();
                if batch.is_empty() {
                    let jobs: Vec<_> = runtime
                        .0
                        .groups
                        .borrow()
                        .get(&group)
                        .into_iter()
                        .flat_map(|group| group.runtime_jobs.iter().copied())
                        .filter(|job| !failed_jobs.contains(job))
                        .collect();
                    if jobs.is_empty() {
                        if let Some(error) = error {
                            return Err(error);
                        }
                        runtime
                            .0
                            .inputs
                            .borrow_mut()
                            .retain(|input| !input.join.is_finished());
                        for input in runtime.0.inputs.borrow_mut().iter_mut() {
                            input.users.retain(|owner| *owner != group);
                        }
                        runtime.shutdown_io().await;
                        let children = runtime
                            .0
                            .children
                            .borrow()
                            .values()
                            .any(|child| child.group == group);
                        let jobs = runtime
                            .0
                            .groups
                            .borrow()
                            .get(&group)
                            .is_some_and(|group| !group.runtime_jobs.is_empty());
                        if children || jobs {
                            continue;
                        }
                        runtime.0.groups.borrow_mut().remove(&group);
                        return Ok(());
                    }
                    // Each job owns its own readiness subscription. A lingering
                    // member of an earlier job must not retain later empty jobs.
                    let waits = jobs.into_iter().map(|job| {
                        let runtime = runtime.clone();
                        async move {
                            loop {
                                match runtime.try_reap_job(group, job) {
                                    Ok(()) => return (job, Ok(())),
                                    Err(AGAIN) => runtime.0.support.ready(4, job).await,
                                    Err(errno) => return (job, Err(errno)),
                                }
                            }
                        }
                    });
                    for (job, result) in futures::future::join_all(waits).await {
                        if let Err(errno) = result {
                            failed_jobs.push(job);
                            error.get_or_insert(ProcessError::Runtime(errno));
                        }
                    }
                    // A shell task may have admitted more children while a prior
                    // child's descendant confirmation was pending. Recheck both
                    // children and jobs before releasing the logical group.
                } else {
                    for result in futures::future::join_all(batch).await {
                        if let Err(error) = result
                            && !matches!(error, ProcessError::StartFailed(_))
                        {
                            return Err(error);
                        }
                    }
                }
            }
        };
        let wait = async move {
            let result = drain.await;
            if result.is_err()
                && let Some(group) = owner.0.groups.borrow_mut().get_mut(&group)
            {
                group.cleanup_failed = true;
            }
            owner.0.waits.borrow_mut().remove(&group);
            result
        }
        .boxed_local()
        .shared();
        self.0
            .waits
            .borrow_mut()
            .insert(group, wait.downgrade().expect("new drain is unpolled"));
        wait.boxed_local()
    }
    fn abandon_group(&self, group: GroupId, signal: i32) {
        let _ = self.kill_group(group, signal);
        let wait = self.wait_group(group);
        self.0.executor.spawn(async move {
            let _ = wait.await;
        });
    }
    fn shutdown_io(&self) -> LocalBoxFuture<'static, ()> {
        let runtime = self.clone();
        async move {
            loop {
                let input = {
                    let mut inputs = runtime.0.inputs.borrow_mut();
                    inputs
                        .iter()
                        .position(InputPump::unowned)
                        .map(|index| inputs.swap_remove(index))
                };
                let Some(input) = input else { break };
                input.cancel.cancel();
                let _ = input.join.clone().await;
            }
            runtime
                .0
                .inputs
                .borrow_mut()
                .retain(|input| !input.join.is_finished());
        }
        .boxed_local()
    }
}

#[cfg(test)]
mod tests;
