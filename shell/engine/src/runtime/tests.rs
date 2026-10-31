use super::*;
use crate::io::DescriptorKind;
use crate::{
    Limits, Session,
    executor::Cancel,
    io::{self, Capture, MemoryFs},
    process::{ChildExit, ProcessGroup},
};
use std::collections::BTreeSet;
use support::Abi as _;
use waffle_program_support::runtime::io_error;

/// The calling shell's own job, as runtime_proc.job_of(0) reports it.
const SHELL_JOB: u32 = 7;

struct FakeChild {
    job: u32,
    startup: Rc<Cell<Option<Result<(), i32>>>>,
    status: Rc<Cell<Option<WaitResult>>>,
    collected: Cell<bool>,
    cancel: Cancel,
    signal: Rc<Cell<i32>>,
}
type WasiDirectoryEntries = Rc<Vec<(u64, Vec<u8>)>>;

struct Fake {
    executor: Executor,
    fds: RefCell<BTreeMap<u32, Endpoint>>,
    directories: RefCell<BTreeMap<u32, Rc<dyn io::Directory>>>,
    wasi_directories: RefCell<BTreeMap<u32, WasiDirectoryEntries>>,
    named_wasi_directories: RefCell<BTreeMap<String, WasiDirectoryEntries>>,
    readdir_calls: RefCell<Vec<(u32, u64, usize)>>,
    inherited: RefCell<Vec<u32>>,
    next_fd: Cell<u32>,
    next_pid: Cell<u32>,
    children: RefCell<BTreeMap<u32, FakeChild>>,
    requests: RefCell<Vec<RuntimeSpawn>>,
    closed: RefCell<Vec<u32>>,
    polls: RefCell<Vec<(i32, Vec<Subscription>)>>,
    reads: RefCell<Vec<(u32, usize)>>,
    read_limit: Cell<usize>,
    signals: RefCell<Vec<(bool, u32, i32)>>,
    held_jobs: RefCell<BTreeSet<u32>>,
    reaped_jobs: RefCell<Vec<u32>>,
    kill_job_errors: RefCell<BTreeMap<u32, i32>>,
    wait_job_errors: RefCell<BTreeMap<u32, i32>>,
    wait_job_calls: RefCell<Vec<u32>>,
    descendant_gates: RefCell<BTreeMap<u32, Cancel>>,
    spawn_errors: RefCell<BTreeMap<String, i32>>,
    outcomes: RefCell<BTreeMap<String, WaitResult>>,
    startup_gate: RefCell<Option<Cancel>>,
    failure_cleanup_gate: RefCell<Option<Cancel>>,
    access_next: Cell<u32>,
    access_requests: RefCell<BTreeMap<u32, Option<Result<(), i32>>>>,
    access_paths: RefCell<Vec<(u32, String, String)>>,
    access_results: RefCell<BTreeMap<String, Option<Result<(), i32>>>>,
    access_cancelled: RefCell<Vec<u32>>,
    access_start_error: Cell<Option<i32>>,
    interrupt: Cell<i32>,
    interrupt_after: Cell<Option<usize>>,
    consumed_interrupts: Cell<usize>,
    parse_gate: Cancel,
    eof_ack: Cancel,
    descendant_gate: Cancel,
    fs: MemoryFs,
    output: Capture,
}
impl Fake {
    fn new(executor: Executor) -> Rc<Self> {
        let (stdout, output) = io::capture(4 * 1024 * 1024);
        Rc::new(Self {
            executor,
            fds: RefCell::new(BTreeMap::from([
                (0, Endpoint::null()),
                (1, stdout),
                (2, Endpoint::null()),
            ])),
            directories: RefCell::new(BTreeMap::new()),
            wasi_directories: RefCell::new(BTreeMap::new()),
            named_wasi_directories: RefCell::new(BTreeMap::new()),
            readdir_calls: RefCell::new(Vec::new()),
            inherited: RefCell::new(vec![0, 1, 2]),
            next_fd: Cell::new(10),
            next_pid: Cell::new(100),
            children: RefCell::new(BTreeMap::new()),
            requests: RefCell::new(Vec::new()),
            closed: RefCell::new(Vec::new()),
            polls: RefCell::new(Vec::new()),
            reads: RefCell::new(Vec::new()),
            read_limit: Cell::new(usize::MAX),
            signals: RefCell::new(Vec::new()),
            held_jobs: RefCell::new(BTreeSet::new()),
            reaped_jobs: RefCell::new(Vec::new()),
            kill_job_errors: RefCell::new(BTreeMap::new()),
            wait_job_errors: RefCell::new(BTreeMap::new()),
            wait_job_calls: RefCell::new(Vec::new()),
            descendant_gates: RefCell::new(BTreeMap::new()),
            spawn_errors: RefCell::new(BTreeMap::new()),
            outcomes: RefCell::new(BTreeMap::new()),
            startup_gate: RefCell::new(None),
            failure_cleanup_gate: RefCell::new(None),
            access_next: Cell::new(1),
            access_requests: RefCell::new(BTreeMap::new()),
            access_paths: RefCell::new(Vec::new()),
            access_results: RefCell::new(BTreeMap::new()),
            access_cancelled: RefCell::new(Vec::new()),
            access_start_error: Cell::new(None),
            interrupt: Cell::new(0),
            interrupt_after: Cell::new(None),
            consumed_interrupts: Cell::new(0),
            parse_gate: Cancel::new(),
            eof_ack: Cancel::new(),
            descendant_gate: Cancel::new(),
            fs: MemoryFs::new(4 * 1024 * 1024),
            output,
        })
    }
    /// A held job, or one with a member that has not exited.
    fn job_live(&self, job: u32) -> bool {
        self.held_jobs.borrow().contains(&job)
            || self
                .children
                .borrow()
                .values()
                .any(|child| child.job == job && child.status.get().is_none())
    }
    fn retained_child(&self, pid: u32) -> Result<std::cell::Ref<'_, FakeChild>, i32> {
        let child =
            std::cell::Ref::filter_map(self.children.borrow(), |children| children.get(&pid))
                .map_err(|_| 12)?;
        if child.collected.get() || self.reaped_jobs.borrow().contains(&child.job) {
            return Err(12);
        }
        Ok(child)
    }
    fn child_status(&self, pid: u32) -> Option<i32> {
        self.children
            .borrow()
            .get(&pid)?
            .status
            .get()
            .map(|result| match result {
                WaitResult::Exited(code) => code,
                WaitResult::Signaled(signal) => 128 + signal,
                WaitResult::StartFailed(errno) => panic!("unexpected startup failure {errno}"),
            })
    }
    fn fd(&self, endpoint: Endpoint) -> u32 {
        let fd = self.next_fd.get();
        self.next_fd.set(fd + 1);
        self.fds.borrow_mut().insert(fd, endpoint);
        fd
    }
}

fn fake_directory_record(next_cookie: u64, name: &[u8]) -> Vec<u8> {
    let mut record = vec![0; 24 + name.len()];
    record[..8].copy_from_slice(&next_cookie.to_le_bytes());
    record[16..20].copy_from_slice(&(name.len() as u32).to_le_bytes());
    record[24..].copy_from_slice(name);
    record
}

fn fake_wasi_page(
    entries: &[(u64, Vec<u8>)],
    cookie: u64,
    output: &mut [u8],
) -> Result<usize, i32> {
    let start = if cookie == 0 {
        0
    } else {
        entries
            .iter()
            .position(|(next, _)| *next == cookie)
            .map(|index| index + 1)
            .ok_or(28)?
    };
    let mut used = 0;
    for (next, name) in &entries[start..] {
        let record = fake_directory_record(*next, name);
        let remaining = output.len() - used;
        if remaining == 0 {
            break;
        }
        let count = remaining.min(record.len());
        output[used..used + count].copy_from_slice(&record[..count]);
        used += count;
        if count < record.len() {
            break;
        }
    }
    Ok(used)
}

impl Fake {
    fn read_wasi_page(&self, fd: u32, cookie: u64, output: &mut [u8]) -> Result<usize, i32> {
        let entries = self.wasi_directories.borrow().get(&fd).cloned().ok_or(8)?;
        let used = fake_wasi_page(&entries, cookie, output)?;
        self.readdir_calls.borrow_mut().push((fd, cookie, used));
        Ok(used)
    }
}

impl support::Abi for Fake {
    fn inherited_fds(&self) -> Vec<u32> {
        self.inherited.borrow().clone()
    }
    fn pipe(&self) -> Result<(u32, u32), i32> {
        let (read, write) = io::pipe();
        Ok((self.fd(read), self.fd(write)))
    }
    fn fd_kind(&self, fd: u32) -> Result<DescriptorKind, i32> {
        self.fds
            .borrow()
            .get(&fd)
            .ok_or(8)?
            .descriptor_kind()
            .map_err(|_| 8)
    }
    fn dup(&self, fd: u32) -> Result<u32, i32> {
        let endpoint = self.fds.borrow().get(&fd).cloned().ok_or(8)?;
        Ok(self.fd(endpoint))
    }
    fn close(&self, fd: u32) {
        self.closed.borrow_mut().push(fd);
        self.fds.borrow_mut().remove(&fd);
        self.directories.borrow_mut().remove(&fd);
        self.wasi_directories.borrow_mut().remove(&fd);
    }
    fn mkdir(&self, path: &str, allow_existing: bool) -> Result<(), i32> {
        self.fs
            .mkdir(path, allow_existing)
            .map_err(|error| match error {
                IoError::AlreadyExists => 20,
                IoError::NotDirectory => 54,
                _ => 44,
            })
    }
    fn stat(&self, path: &str, follow_symlinks: bool) -> Result<FileMetadata, i32> {
        self.fs
            .stat(path, follow_symlinks)
            .map_err(|error| match error {
                IoError::NotFound => 44,
                IoError::NotDirectory => 54,
                IoError::Unsupported => 58,
                _ => 28,
            })
    }
    fn open_dir(&self, path: &str) -> Result<u32, i32> {
        if let Some(entries) = self.named_wasi_directories.borrow().get(path).cloned() {
            let fd = self.next_fd.get();
            self.next_fd.set(fd + 1);
            self.wasi_directories.borrow_mut().insert(fd, entries);
            return Ok(fd);
        }
        let directory = FileSystem::open_dir(&self.fs, path)
            .now_or_never()
            .unwrap()
            .map_err(|error| match error {
                IoError::NotFound => 44,
                IoError::NotDirectory => 54,
                _ => 28,
            })?;
        let fd = self.next_fd.get();
        self.next_fd.set(fd + 1);
        self.directories.borrow_mut().insert(fd, directory);
        Ok(fd)
    }
    fn read_dir(&self, fd: u32, cookie: u64, output: &mut [u8]) -> Result<usize, i32> {
        if self.wasi_directories.borrow().contains_key(&fd) {
            return self.read_wasi_page(fd, cookie, output);
        }
        if output.len() < 24 {
            return Err(48);
        }
        let directory = self.directories.borrow().get(&fd).cloned().ok_or(8)?;
        let entry = directory
            .read_entry(cookie, &mut output[24..])
            .now_or_never()
            .unwrap()
            .map_err(|error| match error {
                IoError::LimitExceeded => 48,
                _ => 28,
            })?;
        let Some(entry) = entry else {
            return Ok(0);
        };
        let length = entry.name.len();
        output[..8].copy_from_slice(&entry.next_cookie.to_le_bytes());
        output[16..20].copy_from_slice(&(length as u32).to_le_bytes());
        Ok(24 + length)
    }
    fn open(&self, path: &str, options: &OpenOptions) -> Result<u32, i32> {
        let Some(fd) = io::descriptor_number(path) else {
            return Ok(self.fd(self.fs.open(path, options).map_err(|_| 44)?));
        };
        let mut fds = FdTable::default();
        fds.insert(fd, self.fds.borrow().get(&fd).cloned().ok_or(44)?);
        let endpoint = io::open_path(path, &fds, options)
            .map_err(|_| 44)?
            .open(&self.fs, options)
            .now_or_never()
            .unwrap()
            .map_err(|_| 44)?;
        Ok(self.fd(endpoint))
    }
    fn read(&self, fd: u32, output: &mut [u8]) -> Result<usize, i32> {
        self.reads.borrow_mut().push((fd, output.len()));
        let length = output.len().min(self.read_limit.get());
        let output = &mut output[..length];
        let endpoint = self.fds.borrow().get(&fd).cloned().ok_or(8)?;
        endpoint
            .read(output)
            .now_or_never()
            .ok_or(AGAIN)?
            .map_err(|error| if error == IoError::BrokenPipe { 64 } else { 8 })
    }
    fn write(&self, fd: u32, input: &[u8]) -> Result<usize, i32> {
        let endpoint = self.fds.borrow().get(&fd).cloned().ok_or(8)?;
        endpoint
            .write(input)
            .now_or_never()
            .ok_or(AGAIN)?
            .map_err(|error| if error == IoError::BrokenPipe { 64 } else { 8 })
    }
    fn poll(
        &self,
        subscriptions: &[Subscription],
        timeout: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32> {
        self.polls
            .borrow_mut()
            .push((timeout, subscriptions.to_vec()));
        let ready = subscriptions.iter().filter(|sub| match sub.kind {
            5 => self
                .access_requests
                .borrow()
                .get(&sub.id)
                .is_some_and(Option::is_some),
            6 => self.start_status(sub.id) != Err(AGAIN),
            _ => true,
        });
        let mut count = 0;
        for (slot, sub) in output.iter_mut().zip(ready) {
            count += 1;
            *slot = PollEvent {
                userdata: sub.userdata,
                kind: sub.kind,
                flags: 0,
            };
        }
        Ok(count)
    }
    fn interrupted(&self) -> i32 {
        if let Some(remaining) = self.interrupt_after.get() {
            self.interrupt_after.set(remaining.checked_sub(1));
            if remaining == 1 {
                self.interrupt_after.set(None);
                self.interrupt.set(2);
            }
        }
        let signal = self.interrupt.replace(0);
        if signal == 2 {
            self.consumed_interrupts
                .set(self.consumed_interrupts.get() + 1);
        }
        signal
    }
}

impl Abi for Fake {
    fn access_start(&self, path: &str, cwd: &str) -> Result<u32, i32> {
        if let Some(errno) = self.access_start_error.get() {
            return Err(errno);
        }
        if self.access_requests.borrow().len() >= 64 {
            return Err(AGAIN);
        }
        let id = self.access_next.get();
        self.access_next.set(id + 1);
        let result = self
            .access_results
            .borrow()
            .get(path)
            .copied()
            .unwrap_or(Some(Ok(())));
        self.access_requests.borrow_mut().insert(id, result);
        self.access_paths
            .borrow_mut()
            .push((id, path.to_owned(), cwd.to_owned()));
        Ok(id)
    }
    fn access_take(&self, request: u32) -> Result<(), i32> {
        let result = self
            .access_requests
            .borrow()
            .get(&request)
            .copied()
            .ok_or(8)?;
        let result = result.ok_or(AGAIN)?;
        self.access_requests.borrow_mut().remove(&request);
        result
    }
    fn access_cancel(&self, request: u32) {
        self.access_cancelled.borrow_mut().push(request);
        self.access_requests.borrow_mut().remove(&request);
    }
    fn spawn(&self, request: &RuntimeSpawn) -> Result<u32, i32> {
        let errors = self.spawn_errors.borrow();
        let errno = errors.get(&request.executable).or_else(|| {
            request
                .executable
                .rsplit_once('/')
                .and_then(|(_, name)| errors.get(name))
        });
        if let Some(&errno) = errno {
            return Err(errno);
        }
        // The real runtime seals a job when its pending membership reaches zero,
        // even before wait_job reaps it. Do not hide illegal sequential joins.
        if request.job > 0 {
            let job = request.job as u32;
            if self.reaped_jobs.borrow().contains(&job) || !(job == SHELL_JOB || self.job_live(job))
            {
                return Err(12);
            }
        }
        let pid = self.next_pid.get();
        self.next_pid.set(pid + 1);
        let job = if request.job <= 0 {
            pid + 900
        } else {
            request.job as u32
        };
        let mut fds = FdTable::default();
        for binding in &request.fds {
            fds.insert(
                binding.child,
                self.fds.borrow().get(&binding.parent).cloned().ok_or(8)?,
            );
        }
        self.requests.borrow_mut().push(request.clone());
        let status = Rc::new(Cell::new(None));
        let startup = Rc::new(Cell::new(None));
        let cancel = Cancel::new();
        let signal = Rc::new(Cell::new(15));
        self.children.borrow_mut().insert(
            pid,
            FakeChild {
                job,
                startup: startup.clone(),
                status: status.clone(),
                collected: Cell::new(false),
                cancel: cancel.clone(),
                signal: signal.clone(),
            },
        );
        let requested_name = request
            .executable
            .rsplit_once('/')
            .map_or(request.executable.as_str(), |(_, name)| name);
        if matches!(requested_name, "inherit" | "inherit-fail" | "inherit-sleep") {
            // A process-service member, not a shell-known direct pid. It retains
            // real inherited descriptors and exits independently of its parent.
            let descendant = self.next_pid.get();
            self.next_pid.set(descendant + 1);
            let status = Rc::new(Cell::new(None));
            let cancel = Cancel::new();
            let signal = Rc::new(Cell::new(15));
            self.children.borrow_mut().insert(
                descendant,
                FakeChild {
                    job,
                    startup: Rc::new(Cell::new(Some(Ok(())))),
                    status: status.clone(),
                    collected: Cell::new(false),
                    cancel: cancel.clone(),
                    signal: signal.clone(),
                },
            );
            let inherited = fds.clone();
            let gate = self.descendant_gate.clone();
            let member_gate = Cancel::new();
            self.descendant_gates
                .borrow_mut()
                .insert(descendant, member_gate.clone());
            self.executor.spawn(async move {
                let result = cancel
                    .run(futures::future::select(
                        gate.cancelled().boxed_local(),
                        member_gate.cancelled().boxed_local(),
                    ))
                    .await;
                drop(inherited);
                status.set(Some(if result.is_ok() {
                    WaitResult::Exited(23)
                } else {
                    WaitResult::Signaled(signal.get())
                }));
            });
        }
        let outcome = self.outcomes.borrow().get(&request.executable).copied();
        let argv = request.argv.clone();
        let command = argv[0]
            .rsplit_once('/')
            .map_or(argv[0].as_str(), |(_, name)| name)
            .to_owned();
        let parse_gate = self.parse_gate.clone();
        let eof_ack = self.eof_ack.clone();
        let startup_gate = self.startup_gate.borrow().clone();
        let failure_cleanup_gate = self.failure_cleanup_gate.borrow().clone();
        self.executor.spawn(async move {
            if let Some(gate) = startup_gate
                && cancel.run(gate.cancelled()).await.is_err()
            {
                startup.set(Some(Err(11)));
                drop(fds);
                status.set(Some(WaitResult::Signaled(signal.get())));
                return;
            }
            startup.set(Some(match outcome {
                Some(WaitResult::StartFailed(errno)) => Err(errno),
                _ => Ok(()),
            }));
            if let Some(outcome) = outcome {
                drop(fds);
                if let Some(gate) = failure_cleanup_gate {
                    let _ = cancel.run(gate.cancelled()).await;
                }
                status.set(Some(outcome));
                return;
            }
            if argv[0] == "producer" {
                // A producer can close both outputs before exiting. The shell
                // must not retain their diagnostic-only copies during wait.
                drop(fds);
                let result = cancel.run(eof_ack.cancelled()).await;
                status.set(Some(if result.is_ok() {
                    WaitResult::Exited(0)
                } else {
                    WaitResult::Signaled(signal.get())
                }));
                return;
            }
            if command == "handled-int" {
                cancel.cancelled().await;
                status.set(Some(WaitResult::Exited(argv[1].parse().unwrap())));
                return;
            }
            let run = async {
                let output = fds.get(1).ok_or(1)?;
                match command.as_str() {
                    "emit" => {
                        for _ in 0..64 {
                            output
                                .write_all(b"runtime bytes\n", &cancel)
                                .await
                                .map_err(|_| 1)?;
                        }
                    }
                    "runtime-cat" | "eof-ack" => {
                        let input = fds.get(0).ok_or(1)?;
                        let mut buffer = [0; 97];
                        loop {
                            let count = input
                                .read_cancelled(&mut buffer, &cancel)
                                .await
                                .map_err(|_| 1)?;
                            if count == 0 {
                                if argv[0] == "eof-ack" {
                                    eof_ack.cancel();
                                }
                                break;
                            }
                            output
                                .write_all(&buffer[..count], &cancel)
                                .await
                                .map_err(|_| 1)?;
                        }
                    }
                    "take-one" => {
                        let mut byte = [0];
                        let count = fds
                            .get(0)
                            .ok_or(1)?
                            .read_cancelled(&mut byte, &cancel)
                            .await
                            .map_err(|_| 1)?;
                        output
                            .write_all(&byte[..count], &cancel)
                            .await
                            .map_err(|_| 1)?;
                    }
                    "sleep" | "inherit-sleep" => futures::future::pending::<()>().await,
                    "parse-gate" => parse_gate.cancelled().await,
                    _ => {}
                }
                Ok::<i32, i32>(if command == "inherit-fail" { 7 } else { 0 })
            };
            let result = cancel.run(run).await;
            status.set(Some(match result {
                Ok(Ok(code)) | Ok(Err(code)) => WaitResult::Exited(code),
                Err(_) => WaitResult::Signaled(signal.get()),
            }));
        });
        Ok(pid)
    }
    fn job_of(&self, pid: u32) -> Result<u32, i32> {
        if pid == 0 {
            return Ok(SHELL_JOB);
        }
        self.children
            .borrow()
            .get(&pid)
            .map(|child| child.job)
            .ok_or(71)
    }
    fn start_status(&self, pid: u32) -> Result<i32, i32> {
        let child = self.retained_child(pid)?;
        match child.startup.get() {
            None => Err(AGAIN),
            Some(Ok(())) => Ok(0),
            Some(Err(11)) => Err(11),
            Some(Err(errno)) => Ok(errno),
        }
    }

    fn wait(&self, pid: u32) -> Result<WaitResult, i32> {
        let child = self.retained_child(pid)?;
        let status = child.status.get().ok_or(AGAIN)?;
        child.collected.set(true);
        Ok(status)
    }
    fn wait_job(&self, job: u32) -> Result<WaitResult, i32> {
        self.wait_job_calls.borrow_mut().push(job);
        if self.reaped_jobs.borrow().contains(&job)
            || !self
                .children
                .borrow()
                .values()
                .any(|child| child.job == job)
        {
            return Err(12);
        }
        if let Some(&errno) = self.wait_job_errors.borrow().get(&job) {
            return Err(errno);
        }
        if self.job_live(job) {
            return Err(AGAIN);
        }
        let result = self
            .children
            .borrow()
            .values()
            .find(|child| child.job == job)
            .and_then(|child| child.status.get())
            .ok_or(AGAIN)?;
        self.reaped_jobs.borrow_mut().push(job);
        Ok(result)
    }
    fn kill(&self, pid: u32, signal: i32) -> Result<(), i32> {
        self.signals.borrow_mut().push((false, pid, signal));
        let children = self.children.borrow();
        let child = children.get(&pid).ok_or(71)?;
        child.signal.set(signal);
        child.cancel.cancel();
        Ok(())
    }
    fn kill_job(&self, job: u32, signal: i32) -> Result<(), i32> {
        self.signals.borrow_mut().push((true, job, signal));
        if let Some(&errno) = self.kill_job_errors.borrow().get(&job) {
            return Err(errno);
        }
        for child in self
            .children
            .borrow()
            .values()
            .filter(|child| child.job == job)
        {
            child.signal.set(signal);
            child.cancel.cancel();
        }
        Ok(())
    }
}
fn setup() -> (Executor, Rc<Fake>, Runtime) {
    let executor = Executor::new();
    let fake = Fake::new(executor.clone());
    let runtime = Runtime::new(fake.clone(), executor.clone());
    (executor, fake, runtime)
}
fn runtime_session(executor: &Executor, runtime: &Runtime) -> Rc<Session> {
    runtime_session_with_limits(executor, runtime, Limits::default())
}
fn runtime_session_with_limits(
    executor: &Executor,
    runtime: &Runtime,
    limits: Limits,
) -> Rc<Session> {
    runtime_session_with_fds_and_limits(executor, runtime, runtime.stdio().unwrap(), limits)
}
fn runtime_session_with_fds(executor: &Executor, runtime: &Runtime, fds: FdTable) -> Rc<Session> {
    runtime_session_with_fds_and_limits(executor, runtime, fds, Limits::default())
}
fn runtime_session_with_fds_and_limits(
    executor: &Executor,
    runtime: &Runtime,
    fds: FdTable,
    limits: Limits,
) -> Rc<Session> {
    let host = Rc::new(runtime.clone());
    let session = Rc::new(Session::new(executor.clone(), host.clone(), host, limits));
    session.set_descriptors(fds).unwrap();
    session
}
fn shutdown_session(executor: &Executor, runtime: &Runtime, fake: &Fake, session: Rc<Session>) {
    finish(
        executor,
        runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_input_released(runtime);
    assert_no_runtime_waiters(executor, runtime, fake);
}
fn wait_status(executor: &Executor, runtime: &Runtime, pid: u64) -> Result<i32, ProcessError> {
    finish(executor, runtime, executor.spawn(runtime.wait(pid))).map(ChildExit::status)
}
fn wait_status_now(runtime: &Runtime, pid: u64) -> Option<Result<i32, ProcessError>> {
    runtime
        .wait(pid)
        .now_or_never()
        .map(|result| result.map(ChildExit::status))
}
fn inherited_input(
    executor: &Executor,
    runtime: &Runtime,
    fake: &Fake,
) -> (GroupId, Endpoint, u64, u32) {
    let group = runtime.allocate_group();
    let mut spec = request(runtime, "inherit", group);
    let source = Endpoint::bytes(vec![b'x'; io::PIPE_CAPACITY * 3]);
    spec.fds.insert(0, source.clone());
    let direct = runtime.spawn(spec).unwrap();
    executor.drive(64);
    assert_eq!(wait_status_now(runtime, direct), Some(Ok(0)));
    let job = fake.job_of(direct as u32).unwrap();
    (group, source, direct, job)
}
fn release_after_detach_error(
    executor: &Executor,
    runtime: &Runtime,
    fake: &Fake,
    group: GroupId,
    direct: u64,
    job: u32,
) {
    fake.wait_job_errors.borrow_mut().insert(job, 63);
    assert_eq!(
        runtime.detach_group(group).now_or_never(),
        Some(Err(ProcessError::Runtime(63)))
    );
    fake.wait_job_errors.borrow_mut().remove(&job);
    fake.descendant_gates.borrow()[&(direct as u32 + 1)].cancel();
    executor.drive(64);
}
fn finish_group_and_check_idle(
    executor: &Executor,
    runtime: &Runtime,
    fake: &Fake,
    group: GroupId,
) {
    assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(runtime.0.waits.borrow().is_empty());
    assert_no_runtime_waiters(executor, runtime, fake);
}
fn assert_no_runtime_waiters(executor: &Executor, runtime: &Runtime, fake: &Fake) {
    assert_eq!(runtime.0.support.waiter_count(), 0);
    assert!(fake.access_requests.borrow().is_empty());
    assert_host_idle(executor, fake);
}
fn assert_host_idle(executor: &Executor, fake: &Fake) {
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
    assert_eq!(executor.drive(64).pending, 0);
}
fn finish_sibling(executor: &Executor, runtime: &Runtime, fake: &Fake, group: GroupId, pid: u64) {
    runtime.kill_group(group, 15).unwrap();
    assert_eq!(wait_status(executor, runtime, pid), Ok(143));
    finish_group_and_check_idle(executor, runtime, fake, group);
}
fn assert_input_released(runtime: &Runtime) {
    assert!(runtime.0.inputs.borrow().is_empty());
    assert_eq!(runtime.0.input_slots.get(), 0);
}
fn request(runtime: &Runtime, name: &str, group: GroupId) -> SpawnRequest {
    SpawnRequest {
        executable: name.into(),
        argv: vec![name.into()],
        env: BTreeMap::new(),
        cwd: "/home/guest".into(),
        fds: runtime.stdio().unwrap(),
        group,
        parent: None,
    }
}
fn finish<T: Clone + 'static>(
    executor: &Executor,
    runtime: &Runtime,
    job: crate::executor::JoinHandle<T>,
) -> T {
    for _ in 0..10_000 {
        executor.drive(64);
        if job.is_finished() {
            return job.now_or_never().unwrap();
        }
        runtime.poll(0).unwrap();
    }
    panic!("fake runtime failed to finish");
}
fn park_group_wait(
    executor: &Executor,
    runtime: &Runtime,
    group: GroupId,
) -> JoinHandle<Result<(), ProcessError>> {
    let pending = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert!(!pending.is_finished());
    pending
}
fn wait_record(kind: u32, value: i32) -> [u8; 8] {
    let mut bytes = [0; 8];
    bytes[..4].copy_from_slice(&kind.to_le_bytes());
    bytes[4..].copy_from_slice(&value.to_le_bytes());
    bytes
}

#[test]
fn typed_wait_result_preserves_each_start_failure_errno() {
    for errno in [48, 6, 29, 44, 2, 45, 54, 28, 63] {
        assert_eq!(
            WaitResult::decode(wait_record(2, errno)),
            Ok(WaitResult::StartFailed(errno)),
            "startup errno {errno}"
        );
    }
}

#[test]
fn typed_wait_result_keeps_real_exits_signals_and_unknown_kinds_distinct() {
    for code in [0, 7, 126, 127, 255] {
        assert_eq!(
            WaitResult::decode(wait_record(0, code)),
            Ok(WaitResult::Exited(code))
        );
    }
    assert_eq!(
        WaitResult::decode(wait_record(1, 9)),
        Ok(WaitResult::Signaled(9))
    );
    for kind in [3, u32::MAX] {
        assert_eq!(WaitResult::decode(wait_record(kind, 44)), Err(28));
    }
}

#[test]
fn typed_start_failure_is_consumed_and_reaped_even_when_errno_is_again() {
    for errno in [48, 6, 29, 44, 2, 45, 54, 28, 63] {
        let (executor, fake, runtime) = setup();
        let group = runtime.allocate_group();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
        let pid = runtime
            .spawn(request(&runtime, "/startup-tool", group))
            .unwrap();
        let first = runtime.wait(pid);
        let second = runtime.wait(pid);
        executor.drive(64);
        assert_eq!(
            first.now_or_never(),
            Some(Err(ProcessError::StartFailed(errno)))
        );
        assert_eq!(
            second.now_or_never(),
            Some(Err(ProcessError::StartFailed(errno)))
        );
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(fake.reaped_jobs.borrow().len(), 1);
        assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
        assert_eq!(runtime.0.support.waiter_count(), 0);
        assert_eq!(executor.drive(64).pending, 0);
    }
}

#[test]
fn typed_start_failure_job_wait_preserves_leader_result_after_child_collection() {
    for outcome in [
        WaitResult::Exited(126),
        WaitResult::Exited(127),
        WaitResult::Signaled(9),
        WaitResult::StartFailed(48),
        WaitResult::StartFailed(6),
        WaitResult::StartFailed(29),
        WaitResult::StartFailed(44),
        WaitResult::StartFailed(2),
        WaitResult::StartFailed(45),
        WaitResult::StartFailed(54),
        WaitResult::StartFailed(28),
    ] {
        let executor = Executor::new();
        let fake = Fake::new(executor.clone());
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), outcome);
        let pid = fake
            .spawn(&RuntimeSpawn {
                executable: "/startup-tool".into(),
                argv: vec!["/startup-tool".into()],
                env: BTreeMap::new(),
                cwd: "/home/guest".into(),
                job: 0,
                fds: Vec::new(),
            })
            .unwrap();
        let job = fake.job_of(pid).unwrap();
        executor.drive(64);
        assert_eq!(fake.wait(pid), Ok(outcome));
        assert_eq!(fake.wait_job(job), Ok(outcome));
        assert_eq!(fake.wait_job(job), Err(12));
        assert_eq!(executor.drive(64).pending, 0);
    }
}

#[test]
fn typed_start_failure_spawn_errors_stay_synchronous_without_child_or_job() {
    for errno in [6, 48, 28] {
        let (executor, fake, runtime) = setup();
        let group = runtime.allocate_group();
        fake.spawn_errors
            .borrow_mut()
            .insert("/startup-tool".into(), errno);
        assert_eq!(
            runtime.spawn(request(&runtime, "/startup-tool", group)),
            Err(ProcessError::Runtime(errno))
        );
        assert!(fake.children.borrow().is_empty());
        assert!(fake.requests.borrow().is_empty());
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
        assert_eq!(executor.drive(64).pending, 0);
    }
}

#[test]
fn typed_wait_diagnostic_does_not_retain_closed_pipeline_writer() {
    for command in [
        "producer 2>&1 | eof-ack; echo done:$?",
        "producer | eof-ack; echo done:$?",
        "producer 2>/dev/null | eof-ack; echo done:$?",
    ] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(&executor, &runtime, session.start(command).unwrap()),
            0
        );
        assert_eq!(fake.output.bytes(), b"done:0\n", "{command}");
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn child_start_readiness_is_non_consuming_and_precedes_terminal_cleanup() {
    for outcome in [WaitResult::Exited(127), WaitResult::StartFailed(44)] {
        let (executor, fake, runtime) = setup();
        let gate = Cancel::new();
        let cleanup = Cancel::new();
        *fake.startup_gate.borrow_mut() = Some(gate.clone());
        *fake.failure_cleanup_gate.borrow_mut() = Some(cleanup.clone());
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), outcome);
        let group = runtime.allocate_group();
        let pid = runtime
            .spawn(request(&runtime, "/startup-tool", group))
            .unwrap();
        let started = executor.spawn(runtime.wait_start(pid));
        executor.drive(64);
        assert!(!started.is_finished());
        assert_eq!(fake.start_status(pid as u32), Err(AGAIN));
        assert_eq!(runtime.0.support.waiter_count(), 1);
        gate.cancel();
        let expected = match outcome {
            WaitResult::StartFailed(errno) => Err(ProcessError::StartFailed(errno)),
            _ => Ok(()),
        };
        assert_eq!(finish(&executor, &runtime, started), expected);
        assert_eq!(
            finish(&executor, &runtime, executor.spawn(runtime.wait_start(pid))),
            expected
        );
        assert_eq!(fake.wait(pid as u32), Err(AGAIN));
        assert!(
            !fake
                .children
                .borrow()
                .get(&(pid as u32))
                .unwrap()
                .collected
                .get()
        );
        cleanup.cancel();
        let expected = match outcome {
            WaitResult::Exited(code) => Ok(code),
            WaitResult::StartFailed(errno) => Err(ProcessError::StartFailed(errno)),
            _ => unreachable!(),
        };
        assert_eq!(wait_status(&executor, &runtime, pid), expected);
        assert_eq!(fake.start_status(pid as u32), Err(12));
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group)),
        )
        .unwrap();
        assert_eq!(runtime.retained_count(), 0);
    }
}

#[test]
fn start_failure_diagnostic_releases_pipe_before_failure_cleanup_fence() {
    let (executor, fake, runtime) = setup();
    let cleanup = Cancel::new();
    *fake.failure_cleanup_gate.borrow_mut() = Some(cleanup.clone());
    fake.outcomes
        .borrow_mut()
        .insert("/startup-tool".into(), WaitResult::StartFailed(45));
    let session = runtime_session(&executor, &runtime);
    let job = session
        .start("/startup-tool 2>&1 | eof-ack; echo complete")
        .unwrap();
    for _ in 0..100 {
        executor.drive(64);
        runtime.poll(0).unwrap();
        if fake.eof_ack.is_cancelled() {
            break;
        }
    }
    assert!(
        fake.eof_ack.is_cancelled(),
        "diagnostic pipe survived until terminal cleanup"
    );
    assert!(
        !job.is_finished(),
        "startup observation consumed the terminal fence"
    );
    assert_eq!(
        fake.output.bytes(),
        b"/usr/bin/bash: /startup-tool: Exec format error\n"
    );
    cleanup.cancel();
    assert_eq!(finish(&executor, &runtime, job), 0);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn cancelled_pending_start_preserves_terminal_signal_without_diagnostic() {
    let (executor, fake, runtime) = setup();
    let gate = Cancel::new();
    *fake.startup_gate.borrow_mut() = Some(gate);
    let group = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    let started = executor.spawn(runtime.wait_start(pid));
    executor.drive(64);
    runtime.kill(pid, 2).unwrap();
    assert_eq!(
        finish(&executor, &runtime, started),
        Err(ProcessError::Runtime(11))
    );
    assert_eq!(wait_status(&executor, &runtime, pid), Ok(130));
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(group)),
    )
    .unwrap();
    assert_eq!(runtime.retained_count(), 0);
}

#[test]
fn typed_and_synchronous_fork_failures_abort_the_whole_reader() {
    for synchronous in [false, true] {
        for errno in [6, 29, 48] {
            for command in [
                "/startup-tool; echo continued",
                "/startup-tool | true; echo continued",
                "true | /startup-tool; echo continued",
                "/startup-tool | true | true; echo continued",
                "{ /startup-tool | true; }; echo continued",
                "/startup-tool | sleep; echo continued",
                "/startup-tool | while true; do :; done; echo continued",
                "set -o lastpipe; /startup-tool | true; echo continued",
            ] {
                let (executor, fake, runtime) = setup();
                if synchronous {
                    fake.spawn_errors
                        .borrow_mut()
                        .insert("/startup-tool".into(), errno);
                } else {
                    fake.outcomes
                        .borrow_mut()
                        .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
                }
                let session = runtime_session(&executor, &runtime);
                assert_eq!(
                    finish(&executor, &runtime, session.start(command).unwrap()),
                    254,
                    "sync={synchronous} errno={errno} {command}"
                );
                assert!(fake.output.bytes().is_empty(), "{command}");
                shutdown_session(&executor, &runtime, &fake, session);
            }
        }
    }
}

#[test]
fn typed_start_failure_first_group_consumer_releases_cleanup_reservation() {
    for consumer in ["wait", "direct", "detach", "abandon"] {
        for errno in [44, 6, 48] {
            let (executor, fake, runtime) = setup();
            fake.outcomes
                .borrow_mut()
                .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
            for _ in 0..3 {
                let group = runtime.allocate_group();
                runtime
                    .spawn(request(&runtime, "/startup-tool", group))
                    .unwrap();
                let done = match consumer {
                    "direct" => executor.spawn({
                        let runtime = runtime.clone();
                        async move {
                            runtime.wait_direct_group(group).await?;
                            runtime.wait_group(group).await
                        }
                    }),
                    "detach" => runtime.detach_group(group),
                    "abandon" => {
                        runtime.abandon_group(group, 15);
                        executor.spawn(async { Ok(()) })
                    }
                    _ => executor.spawn(runtime.wait_group(group)),
                };
                assert_eq!(
                    finish(&executor, &runtime, done),
                    Ok(()),
                    "{consumer} {errno}"
                );
                executor.drive(64);
                assert_eq!(runtime.retained_count(), 0);
                assert_eq!(runtime.retained_slots(), 0, "{consumer} {errno}");
                assert!(runtime.0.groups.borrow().is_empty(), "{consumer} {errno}");
            }
            assert_eq!(executor.drive(64).pending, 0);
        }
    }
}

#[test]
fn typed_start_failure_keeps_redirected_stderr_until_diagnostic() {
    for (errno, status, message) in [
        (48, 254, "fork: Cannot allocate memory"),
        (6, 254, "fork: Resource temporarily unavailable"),
        (29, 254, "fork: Input/output error"),
        (44, 127, "/startup-tool: No such file or directory"),
        (2, 126, "/startup-tool: Permission denied"),
        (45, 126, "/startup-tool: Exec format error"),
        (54, 126, "/startup-tool: Not a directory"),
        (28, 126, "/startup-tool: Invalid argument"),
        (63, 126, "/startup-tool: Operation not permitted"),
        (20, 126, "/startup-tool: File exists"),
    ] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
        let (stderr, error_output) = io::capture(4096);
        fake.fds.borrow_mut().insert(2, stderr);
        let session = runtime_session(&executor, &runtime);
        let code = finish(
            &executor,
            &runtime,
            session
                .start("/startup-tool 2>/failure; echo continued:$?")
                .unwrap(),
        );
        assert_eq!(code, if status == 254 { 254 } else { 0 }, "errno {errno}");
        let diagnostic = format!("/usr/bin/bash: {message}\n");
        if status == 254 {
            assert_eq!(error_output.bytes(), diagnostic.as_bytes(), "errno {errno}");
            assert!(fake.fs.read_file("/failure").unwrap().is_empty());
        } else {
            assert!(error_output.bytes().is_empty(), "errno {errno}");
            assert_eq!(
                fake.fs.read_file("/failure").unwrap(),
                diagnostic.as_bytes(),
                "errno {errno}"
            );
        }
        let expected = if status == 254 {
            String::new()
        } else {
            format!("continued:{status}\n")
        };
        assert_eq!(fake.output.bytes(), expected.as_bytes(), "errno {errno}");
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(fake.reaped_jobs.borrow().len(), 1);
        assert_eq!(
            finish(&executor, &runtime, session.start("true").unwrap()),
            0
        );
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn start_failure_pipeline_delivers_diagnostic_before_eof() {
    for (errno, code) in [(44, 127), (2, 126), (45, 126)] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
        let (stderr, parent_output) = io::capture(4096);
        fake.fds.borrow_mut().insert(2, stderr);
        let session = runtime_session(&executor, &runtime);
        let command = "/startup-tool 2>&1 | runtime-cat; printf 'status:%s:%s\\n' \"$?\" \"${PIPESTATUS[*]}\"";
        let status = finish(&executor, &runtime, session.start(command).unwrap());
        let output = fake.output.bytes();
        shutdown_session(&executor, &runtime, &fake, session);
        assert_eq!(status, 0);
        assert!(
            parent_output.bytes().is_empty(),
            "diagnostic escaped redirected pipe"
        );
        assert_eq!(
            output,
            format!(
                "/usr/bin/bash: /startup-tool: {}\nstatus:0:{code} 0\n",
                ProcessError::StartFailed(errno)
            )
            .as_bytes()
        );
    }
}

#[test]
fn typed_exec_failure_uses_redirected_stderr_while_weak_endpoint_is_live() {
    for (errno, message) in [
        (44, "No such file or directory"),
        (2, "Permission denied"),
        (45, "Exec format error"),
    ] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
        let (stderr, error_output) = io::capture(4096);
        fake.fds.borrow_mut().insert(2, stderr);
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(
                &executor,
                &runtime,
                session
                    .start("exec 3>/failure; /startup-tool 2>&3; echo continued:$?",)
                    .unwrap()
            ),
            0
        );
        assert_eq!(
            fake.fs.read_file("/failure").unwrap(),
            format!("/usr/bin/bash: /startup-tool: {message}\n").as_bytes()
        );
        assert!(error_output.bytes().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn synchronous_fork_failure_uses_parent_stderr_and_not_command_redirection() {
    for errno in [6, 29, 48] {
        let (executor, fake, runtime) = setup();
        fake.spawn_errors
            .borrow_mut()
            .insert("/startup-tool".into(), errno);
        let (stderr, error_output) = io::capture(4096);
        fake.fds.borrow_mut().insert(2, stderr);
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(
                &executor,
                &runtime,
                session
                    .start("/startup-tool 2>/failure; echo continued",)
                    .unwrap()
            ),
            254
        );
        assert_eq!(
            error_output.bytes(),
            format!(
                "/usr/bin/bash: fork: {}\n",
                ProcessError::StartFailed(errno)
            )
            .as_bytes()
        );
        assert!(fake.fs.read_file("/failure").unwrap().is_empty());
        assert!(fake.output.bytes().is_empty());
        assert!(fake.requests.borrow().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn fork_failure_preserves_enclosing_parent_shell_stderr() {
    for synchronous in [false, true] {
        let (executor, fake, runtime) = setup();
        if synchronous {
            fake.spawn_errors
                .borrow_mut()
                .insert("/startup-tool".into(), 48);
        } else {
            fake.outcomes
                .borrow_mut()
                .insert("/startup-tool".into(), WaitResult::StartFailed(48));
        }
        let (stderr, error_output) = io::capture(4096);
        fake.fds.borrow_mut().insert(2, stderr);
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(
                &executor,
                &runtime,
                session
                    .start("{ /startup-tool 2>/child; echo hidden; } 2>/parent; echo continued",)
                    .unwrap()
            ),
            254
        );
        assert_eq!(
            fake.fs.read_file("/parent").unwrap(),
            b"/usr/bin/bash: fork: Cannot allocate memory\n"
        );
        assert!(fake.fs.read_file("/child").unwrap().is_empty());
        assert!(error_output.bytes().is_empty());
        assert!(fake.output.bytes().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn isolated_errexit_remains_local_to_ordinary_pipeline_stage() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session
                .start("set -e; { false; echo hidden; } | true; echo continued",)
                .unwrap()
        ),
        0
    );
    assert_eq!(fake.output.bytes(), b"continued\n");
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn typed_start_failure_real_exits_126_127_and_signals_have_no_startup_diagnostic() {
    for (outcome, status) in [
        (WaitResult::Exited(126), 126),
        (WaitResult::Exited(127), 127),
        (WaitResult::Signaled(9), 137),
    ] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), outcome);
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(
                &executor,
                &runtime,
                session
                    .start("/startup-tool 2>/failure; echo continued:$?")
                    .unwrap()
            ),
            0
        );
        assert!(fake.fs.read_file("/failure").unwrap().is_empty());
        assert_eq!(
            fake.output.bytes(),
            format!("continued:{status}\n").as_bytes()
        );
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn consuming_child_wait_keeps_job_pending_until_live_grandchild_finishes() {
    let executor = Executor::new();
    let fake = Fake::new(executor.clone());
    let pid = fake
        .spawn(&RuntimeSpawn {
            executable: "inherit".into(),
            argv: vec!["inherit".into()],
            env: BTreeMap::new(),
            cwd: "/home/guest".into(),
            job: 0,
            fds: vec![Binding {
                child: 1,
                parent: 1,
            }],
        })
        .unwrap();
    let job = fake.job_of(pid).unwrap();
    let grandchild = pid + 1;
    assert_eq!(fake.wait(pid), Err(AGAIN));
    executor.drive(64);
    assert_eq!(fake.wait(pid), Ok(WaitResult::Exited(0)));
    assert_eq!(fake.wait(pid), Err(12));
    assert_eq!(fake.wait(grandchild), Err(AGAIN));
    assert_eq!(fake.wait_job(job), Err(AGAIN));
    assert!(!fake.reaped_jobs.borrow().contains(&job));
    fake.descendant_gates.borrow()[&grandchild].cancel();
    executor.drive(64);
    assert_eq!(fake.wait_job(job), Ok(WaitResult::Exited(0)));
    assert_eq!(fake.wait_job(job), Err(12));
    assert_eq!(fake.wait(grandchild), Err(12));
    assert_eq!(executor.drive(64).pending, 0);
}

#[test]
fn without_job_control_foreground_children_join_the_shell_job() {
    let (executor, fake, runtime) = setup();
    runtime.set_job_control(false);
    let group = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    assert_eq!(fake.requests.borrow().last().unwrap().job, SHELL_JOB as i32);
    // The shell signals its own member by PID: never the job it belongs to itself.
    runtime.kill_group(group, 2).unwrap();
    assert_eq!(*fake.signals.borrow(), [(false, pid as u32, 2)]);
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(group)),
    )
    .unwrap();
    assert!(fake.wait_job_calls.borrow().is_empty());
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    let background = runtime.allocate_background_group();
    runtime
        .spawn(request(&runtime, "sleep", background))
        .unwrap();
    assert_eq!(fake.requests.borrow().last().unwrap().job, -1);
    runtime.kill_group(background, 9).unwrap();
}

#[test]
fn spawn_forwards_resolved_executable_separately_from_original_argv_zero() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let mut spec = request(&runtime, "/home/guest/done", group);
    spec.argv = vec!["done".into(), "ARG".into()];
    let pid = runtime.spawn(spec).unwrap();
    assert_eq!(
        fake.requests.borrow().last().unwrap().executable,
        "/home/guest/done"
    );
    assert_eq!(fake.requests.borrow().last().unwrap().argv, ["done", "ARG"]);
    assert_eq!(wait_status(&executor, &runtime, pid), Ok(0));
    finish_group_and_check_idle(&executor, &runtime, &fake, group);
}

#[test]
fn preview1_filestat_decodes_native_widths_and_preserves_missing_capabilities() {
    use crate::io::FileKind;
    let mut bytes = [0u8; 64];
    let values = [
        (0, 0x1020_3040_5060_7080u64),
        (8, 0x8090_a0b0_c0d0_e0f0),
        (24, 99),
        (32, 0x1_0000_0001),
        (40, 123_456_789),
        (48, 987_654_321),
    ];
    for (offset, value) in values {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    for (wire, kind) in [
        (0, FileKind::Unknown),
        (1, FileKind::BlockDevice),
        (2, FileKind::CharacterDevice),
        (3, FileKind::Directory),
        (4, FileKind::Regular),
        (5, FileKind::Socket),
        (6, FileKind::Socket),
        (7, FileKind::Symlink),
        (255, FileKind::Unknown),
    ] {
        bytes[16] = wire;
        let stat = decode_filestat(&bytes);
        assert_eq!(stat.kind, kind);
        assert_eq!(stat.device, Some(values[0].1));
        assert_eq!(stat.inode, Some(values[1].1));
        assert_eq!(stat.size, values[3].1);
        assert_eq!(stat.accessed_ns, Some(values[4].1));
        assert_eq!(stat.modified_ns, Some(values[5].1));
        assert_eq!(stat.mode, None);
        assert_eq!(stat.uid, None);
        assert_eq!(stat.gid, None);
        assert_eq!(stat.readable, None);
        assert_eq!(stat.writable, None);
        assert_eq!(stat.executable, None);
        assert_eq!(stat.owned_by_effective_uid, None);
        assert_eq!(stat.owned_by_effective_gid, None);
    }
    assert_eq!(io_error(58), IoError::Unsupported);
    assert_eq!(io_error(54), IoError::NotDirectory);
}
#[test]
fn filesystem_stat_does_not_allocate_runtime_descriptors() {
    use crate::io::FileKind;
    let (executor, fake, runtime) = setup();
    fake.fs.write_file("/file", b"contents").unwrap();
    let initial_fd = fake.next_fd.get();
    let runtime_task = runtime.clone();
    let result = finish(
        &executor,
        &runtime,
        executor.spawn(async move {
            let file = runtime_task.stat("/file", true).await.unwrap();
            assert_eq!(file.kind, FileKind::Regular);
            assert_eq!(file.size, 8);
            assert_eq!(file, runtime_task.stat("/file", false).await.unwrap());
            assert_eq!(
                runtime_task.stat("/", true).await.unwrap().kind,
                FileKind::Directory
            );
            assert_eq!(
                runtime_task.stat("/file/", true).await,
                Err(IoError::NotDirectory)
            );
            assert_eq!(
                runtime_task.stat("/missing", true).await,
                Err(IoError::NotFound)
            );
            assert_eq!(
                runtime_task.stat("relative", true).await,
                Err(IoError::InvalidPath)
            );
            file
        }),
    );
    assert_eq!(result, fake.fs.stat("/file", true).unwrap());
    assert_eq!(fake.next_fd.get(), initial_fd);
    assert!(fake.closed.borrow().is_empty());
    assert_eq!(fake.fds.borrow().len(), 3);
    assert_eq!(executor.drive(64).pending, 0);
}
#[test]
fn exact_sixteen_byte_wire_records() {
    let sub = Subscription {
        kind: 2,
        id: 0x12345678,
        userdata: 0x1020304050607080,
    };
    assert_eq!(
        sub.encode(),
        [
            2, 0, 0, 0, 0x78, 0x56, 0x34, 0x12, 0x80, 0x70, 0x60, 0x50, 0x40, 0x30, 0x20, 0x10
        ]
    );
    assert_eq!(
        PollEvent::decode([
            0x80, 0x70, 0x60, 0x50, 0x40, 0x30, 0x20, 0x10, 2, 0, 0, 0, 1, 0, 0, 0
        ]),
        PollEvent {
            userdata: sub.userdata,
            kind: 2,
            flags: 1
        }
    );
}
#[test]
fn groups_aggregate_fresh_jobs_and_background_does_not_join_foreground() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let background = runtime.allocate_background_group();
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    runtime.spawn(request(&runtime, "exit", group)).unwrap();
    runtime
        .spawn(request(&runtime, "exit", background))
        .unwrap();
    let requests = fake.requests.borrow();
    assert_eq!(requests[0].job, 0);
    assert_eq!(requests[1].job, 0);
    assert_eq!(requests[2].job, -1);
    assert_ne!(group, first + 900);
    drop(requests);
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(group)),
    )
    .unwrap();
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(background)),
    )
    .unwrap();
    assert_eq!(runtime.retained_count(), 0);
}
#[test]
fn nonblocking_eagain_wait_registration_is_removed_when_cancelled() {
    let (executor, fake, runtime) = setup();
    let (input, output) = runtime.pipe().unwrap();
    let cancel = Cancel::new();
    let child_cancel = cancel.clone();
    let job = executor.spawn(async move {
        let mut byte = [0];
        input.read_cancelled(&mut byte, &child_cancel).await
    });
    executor.drive(64);
    assert!(!job.is_finished());
    assert_eq!(runtime.0.support.waiter_count(), 1);
    assert!(fake.polls.borrow().is_empty(), "task must not call poll");
    cancel.cancel();
    executor.drive(64);
    assert_eq!(job.now_or_never(), Some(Err(IoError::Cancelled)));
    assert_eq!(runtime.0.support.waiter_count(), 0);
    drop(output);
    assert_eq!(fake.closed.borrow().len(), 2);
}
#[test]
fn a_cancelled_one_byte_read_leaves_every_byte_for_the_next_read() {
    let (executor, _fake, runtime) = setup();
    let (input, output) = runtime.pipe().unwrap();
    let read = |cancel: &Cancel| {
        let (input, cancel) = (input.clone(), cancel.clone());
        executor.spawn(async move {
            let mut byte = [0];
            input
                .read_cancelled(&mut byte, &cancel)
                .await
                .map(|_| byte[0])
        })
    };
    let first = Cancel::new();
    let parked = read(&first);
    executor.drive(64);
    first.cancel();
    executor.drive(64);
    assert_eq!(parked.now_or_never(), Some(Err(IoError::Cancelled)));
    // Data and the cancellation land in the same turn: cancellation wins the tie.
    let second = Cancel::new();
    let racing = read(&second);
    executor.drive(64);
    output.write(b"ab").now_or_never().unwrap().unwrap();
    second.cancel();
    executor.drive(64);
    assert_eq!(racing.now_or_never(), Some(Err(IoError::Cancelled)));
    for expected in *b"ab" {
        let next = read(&Cancel::new());
        executor.drive(64);
        assert_eq!(next.now_or_never(), Some(Ok(expected)));
    }
}
#[test]
fn partial_writes_epipe_and_dup_lifetime() {
    let (executor, fake, runtime) = setup();
    let (input, output) = runtime.pipe().unwrap();
    let duplicate = output.clone();
    let fd = output.runtime_fd().unwrap();
    drop(output);
    assert!(!fake.closed.borrow().contains(&fd));
    let data = vec![1; io::PIPE_CAPACITY + 7];
    assert_eq!(
        duplicate.write(&data).now_or_never(),
        Some(Ok(io::PIPE_CAPACITY))
    );
    let writer = duplicate.clone();
    let job = executor.spawn(async move { writer.write(b"blocked").await });
    executor.drive(64);
    assert!(!job.is_finished());
    drop(input);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert_eq!(job.now_or_never(), Some(Err(IoError::BrokenPipe)));
    drop(duplicate);
    assert!(fake.closed.borrow().contains(&fd));
}
#[test]
fn runtime_pipeline_builtins_external_and_fs_share_descriptor_namespace() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let script = "consume() { IFS= read -r value; printf '%s' \"$value\"; }; printf first | runtime-cat | runtime-cat | consume > /result; runtime-cat < /result 3>&1; emit | runtime-cat | runtime-cat";
    let job = session.start(script).unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"first".to_vec();
    for _ in 0..64 {
        expected.extend_from_slice(b"runtime bytes\n");
    }
    assert_eq!(fake.output.bytes(), expected);
    let requests = fake.requests.borrow();
    assert_eq!(requests.len(), 6);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request
                .executable
                .rsplit_once('/')
                .map_or(request.executable.as_str(), |(_, name)| name)
                == "runtime-cat")
            .count(),
        5
    );
    let inherited_extra = requests
        .iter()
        .find(|request| request.fds.iter().any(|binding| binding.child == 3))
        .unwrap();
    assert_eq!(
        inherited_extra
            .fds
            .iter()
            .find(|binding| binding.child == 3)
            .unwrap()
            .parent,
        inherited_extra
            .fds
            .iter()
            .find(|binding| binding.child == 1)
            .unwrap()
            .parent
    );
    assert!(
        requests
            .iter()
            .all(|request| request.fds.iter().all(|binding| binding.parent >= 10))
    );
    assert!(
        fake.polls
            .borrow()
            .iter()
            .flat_map(|(_, subs)| subs)
            .any(|sub| sub.kind == 2)
    );
    drop(requests);
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
}
#[test]
fn background_persists_and_foreground_interrupt_is_checked_in_budget() {
    let (executor, fake, runtime) = setup();
    let session = Rc::new(Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    ));
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    assert_eq!(
        finish(&executor, &runtime, session.start("sleep &").unwrap()),
        0
    );
    assert_eq!(session.background_jobs(), 1);
    let foreground = session.start("while true; do :; done").unwrap();
    executor.drive(32);
    fake.interrupt.set(2);
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    assert_eq!(session.background_jobs(), 1);
    assert!(
        fake.signals.borrow().is_empty(),
        "builtin foreground must not signal background job"
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert_eq!(runtime.retained_count(), 0);
    assert!(fake.signals.borrow().iter().any(|(job, _, _)| *job));
}

fn drive_until_spawn(executor: &Executor, runtime: &Runtime, fake: &Fake, count: usize) {
    for _ in 0..1000 {
        executor.drive(64);
        if fake.requests.borrow().len() >= count {
            return;
        }
        runtime.poll(0).unwrap();
    }
    panic!("expected {count} runtime children");
}

fn interrupt_during_isolated_eval_parse(executor: &Executor, runtime: &Runtime, fake: &Fake) {
    fake.parse_gate.cancel();
    executor.drive(64);
    runtime.poll(0).unwrap();
    // Re-arm waiting runtime children once, then make no further reactor turns.
    // The foreground wait can sample once; joining the background eval checks
    // only its own token. Further host probes therefore run inside its parser.
    fake.interrupt_after.set(Some(16));
    for _ in 0..2000 {
        executor.drive(64);
        if fake.consumed_interrupts.get() != 0 {
            assert_eq!(fake.consumed_interrupts.get(), 1);
            assert_eq!(fake.interrupt.get(), 0, "the ABI event is consuming");
            return;
        }
    }
    panic!("the synchronous eval parser did not consume the injected ABI event");
}

#[test]
fn background_eval_parser_routes_consuming_interrupt_to_the_current_foreground() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    session
        .state()
        .borrow_mut()
        .assign_parameter("source".into(), ":; ".repeat(32))
        .unwrap();
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session
                .start("{ parse-gate; eval \"$source\"; sleep; } &")
                .unwrap(),
        ),
        0,
    );
    drive_until_spawn(&executor, &runtime, &fake, 1);
    let foreground = session.start("sleep").unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 2);
    let foreground_pid = fake.next_pid.get() - 1;
    let foreground_job = fake.job_of(foreground_pid).unwrap();
    assert!(!foreground.is_finished());
    assert_eq!(fake.wait(foreground_pid), Err(AGAIN));
    interrupt_during_isolated_eval_parse(&executor, &runtime, &fake);
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    assert_eq!(fake.child_status(foreground_pid), Some(130));
    drive_until_spawn(&executor, &runtime, &fake, 3);
    assert_eq!(session.background_jobs(), 1);
    assert_eq!(runtime.retained_count(), 1);
    let background_pid = fake.next_pid.get() - 1;
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    assert_eq!(fake.requests.borrow().last().unwrap().job, -1);
    assert!(!fake.signals.borrow().is_empty());
    assert!(fake.signals.borrow().iter().all(|&(group, id, signal)| {
        signal == 2
            && id
                == if group {
                    foreground_job
                } else {
                    foreground_pid
                }
    }));
    assert_eq!(finish(&executor, &runtime, session.start(":").unwrap()), 0,);
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn nested_capture_eval_parser_interrupts_foreground_without_stopping_background() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    session
        .state()
        .borrow_mut()
        .assign_parameter("source".into(), ":; ".repeat(32))
        .unwrap();
    assert_eq!(
        finish(&executor, &runtime, session.start("sleep &").unwrap()),
        0,
    );
    drive_until_spawn(&executor, &runtime, &fake, 1);
    let background_pid = fake.next_pid.get() - 1;
    let foreground = session
        .start(r#"x=$(x=$(parse-gate; eval "$source"); echo "$x"); echo forbidden"#)
        .unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 2);
    let capture_pid = fake.next_pid.get() - 1;
    let capture_job = fake.job_of(capture_pid).unwrap();
    interrupt_during_isolated_eval_parse(&executor, &runtime, &fake);
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    assert_eq!(session.background_jobs(), 1);
    assert_eq!(runtime.retained_count(), 1);
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    assert!(fake.output.bytes().is_empty());
    assert!(fake.signals.borrow().iter().all(|&(group, id, signal)| {
        signal == 2 && id == if group { capture_job } else { capture_pid }
    }));
    assert_eq!(finish(&executor, &runtime, session.start(":").unwrap()), 0,);
    assert_eq!(fake.wait(background_pid), Err(AGAIN));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn wait_group_observes_descendants_and_abandoned_group_confirms_cleanup() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    let job = pid as u32 + 900;
    fake.held_jobs.borrow_mut().insert(job);
    let done = park_group_wait(&executor, &runtime, group);
    assert_eq!(runtime.0.support.waiter_count(), 1);
    fake.held_jobs.borrow_mut().remove(&job);
    runtime.poll(0).unwrap();
    finish(&executor, &runtime, done).unwrap();
    assert!(fake.reaped_jobs.borrow().contains(&job));
    let group = runtime.allocate_group();
    runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    drop(ProcessGroup::new(Rc::new(runtime.clone()), group));
    for _ in 0..10 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
}

#[test]
fn dropping_wait_observers_does_not_retain_runtime_or_readiness() {
    for polled in [false, true] {
        let (executor, fake, runtime) = setup();
        let group = runtime.allocate_group();
        runtime.spawn(request(&runtime, "inherit", group)).unwrap();
        executor.drive(64);
        let references = Rc::strong_count(&runtime.0);
        let wait = runtime.wait_group(group);
        if polled {
            assert!(wait.now_or_never().is_none());
        } else {
            drop(wait);
        }
        assert_eq!(Rc::strong_count(&runtime.0), references, "polled={polled}");
        assert_eq!(runtime.0.support.waiter_count(), 0);
        runtime.kill_group(group, 15).unwrap();
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group)),
        )
        .unwrap();
        assert_eq!(runtime.retained_count(), 0);
        assert!(runtime.0.groups.borrow().is_empty());
        assert!(runtime.0.waits.borrow().is_empty());
        assert_eq!(runtime.0.support.waiter_count(), 0);
        assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
        for unobserved in 100..116 {
            drop(runtime.wait_group(unobserved));
            assert_eq!(runtime.0.waits.borrow().len(), 1);
        }
        let weak = Rc::downgrade(&runtime.0);
        drop(runtime);
        assert!(weak.upgrade().is_none());
        assert_eq!(executor.drive(64).pending, 0);
    }
}

#[test]
fn dropping_detached_wait_observer_preserves_runtime_reaper() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let parent = runtime.spawn(request(&runtime, "inherit", group)).unwrap();
    executor.drive(64);
    assert_eq!(wait_status_now(&runtime, parent), Some(Ok(0)));
    drop(runtime.detach_group(group));
    fake.descendant_gate.cancel();
    for _ in 0..10 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(runtime.0.waits.borrow().is_empty());
    assert_eq!(runtime.0.support.waiter_count(), 0);
    assert!(fake.access_requests.borrow().is_empty());
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
    let weak = Rc::downgrade(&runtime.0);
    drop(runtime);
    assert!(weak.upgrade().is_none());
    assert_eq!(executor.drive(64).pending, 0);
}

#[test]
fn external_after_builtin_pipeline_starts_a_fresh_runtime_job() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let script = "consume() { while IFS= read -r value; do printf '%s\\n' \"$value\"; done; }; emit | consume > /complete; runtime-cat < /complete";
    let job = session.start(script).unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(fake.output.bytes(), b"runtime bytes\n".repeat(64));
    assert_eq!(fake.requests.borrow().len(), 2);
    assert!(
        fake.requests
            .borrow()
            .iter()
            .all(|request| request.job == 0)
    );
    assert_eq!(fake.reaped_jobs.borrow().len(), 2);
    assert!(runtime.0.groups.borrow().is_empty());
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
}

#[test]
fn background_brace_sequence_kill_and_wait_cover_later_runtime_members() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let job = session
        .start("{ emit; sleep; echo BAD_AFTER_JOB_KILL; } &")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    for _ in 0..100 {
        executor.drive(64);
        if fake.requests.borrow().len() == 2 {
            break;
        }
        runtime.poll(0).unwrap();
    }
    assert_eq!(
        fake.requests.borrow().len(),
        2,
        "later member must really spawn"
    );
    assert!(
        fake.requests
            .borrow()
            .iter()
            .all(|request| request.job == -1)
    );
    assert_eq!(
        fake.children
            .borrow()
            .values()
            .map(|child| child.status.get())
            .collect::<Vec<_>>(),
        vec![Some(WaitResult::Exited(0)), None],
        "first member exited before persistent later member started"
    );
    let members: Vec<_> = fake
        .children
        .borrow()
        .iter()
        .map(|(&pid, child)| (pid, child.job))
        .collect();
    let job = session
        .start("kill %1; wait %1; echo MEMBERS_REAPED")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"runtime bytes\n".repeat(64);
    expected.extend_from_slice(b"MEMBERS_REAPED\n");
    assert_eq!(
        fake.output.bytes(),
        expected,
        "no command after the killed member runs"
    );
    assert_eq!(session.background_jobs(), 0);
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_eq!(*fake.reaped_jobs.borrow(), vec![members[0].1, members[1].1]);
    // Explicit TERM remains TERM. The earlier empty runtime job was already
    // reaped, so it must not receive a later signal for this shell group.
    assert_eq!(
        *fake.signals.borrow(),
        vec![
            (true, members[1].1, 15),
            (true, members[1].1, 15),
            (false, members[1].0, 15),
        ]
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
}

#[test]
fn group_wait_includes_later_children_and_every_descendant_confirmation() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    executor.drive(64);
    let first_job = fake.job_of(first as u32).unwrap();
    let mut sealed = fake.requests.borrow()[0].clone();
    sealed.job = first_job as i32;
    assert_eq!(
        fake.spawn(&sealed),
        Err(12),
        "completed jobs cannot be joined"
    );

    fake.held_jobs.borrow_mut().insert(first_job);
    assert_eq!(wait_status(&executor, &runtime, first), Ok(0));
    let done = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    assert!(!done.is_finished());
    let later = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    assert_ne!(first_job, later_job);
    fake.held_jobs.borrow_mut().insert(later_job);
    executor.drive(64);
    fake.held_jobs.borrow_mut().remove(&first_job);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert!(
        !done.is_finished(),
        "later job's descendants still own the group"
    );
    assert_eq!(*fake.reaped_jobs.borrow(), vec![first_job]);
    fake.held_jobs.borrow_mut().remove(&later_job);
    runtime.poll(0).unwrap();
    assert_eq!(finish(&executor, &runtime, done), Ok(()));
    assert_eq!(*fake.reaped_jobs.borrow(), vec![first_job, later_job]);
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
}

#[test]
fn killing_dynamic_background_group_rejects_new_members_and_isolates_siblings() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_background_group();
    let foreground = runtime.allocate_group();
    let sibling = runtime.allocate_background_group();
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    let first_job = fake.job_of(first as u32).unwrap();
    fake.held_jobs.borrow_mut().insert(first_job);
    assert_eq!(wait_status(&executor, &runtime, first), Ok(0));
    let later = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    let foreground_pid = runtime
        .spawn(request(&runtime, "sleep", foreground))
        .unwrap();
    let sibling_pid = runtime.spawn(request(&runtime, "sleep", sibling)).unwrap();
    runtime.kill_group(group, 15).unwrap();
    assert_eq!(
        runtime.spawn(request(&runtime, "exit", group)),
        Err(ProcessError::GroupClosed(group))
    );
    assert_eq!(
        *fake.signals.borrow(),
        vec![(true, first_job, 15), (true, later_job, 15)]
    );
    let done = park_group_wait(&executor, &runtime, group);
    assert_eq!(fake.wait(foreground_pid as u32), Err(AGAIN));
    assert_eq!(fake.wait(sibling_pid as u32), Err(AGAIN));
    fake.held_jobs.borrow_mut().remove(&first_job);
    runtime.poll(0).unwrap();
    assert_eq!(finish(&executor, &runtime, done), Ok(()));
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job, first_job]);
    for group in [foreground, sibling] {
        runtime.kill_group(group, 9).unwrap();
        assert_eq!(
            finish(
                &executor,
                &runtime,
                executor.spawn(runtime.wait_group(group))
            ),
            Ok(())
        );
    }
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(
        fake.requests.borrow()[..2]
            .iter()
            .all(|request| request.job == -1)
    );
}

#[test]
fn group_fanout_continues_after_errors_and_invalid_signal_does_not_close_admission() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    assert_eq!(
        runtime.kill_group(group, 0),
        Err(ProcessError::InvalidSignal)
    );
    let first = runtime.spawn(request(&runtime, "exit", group)).unwrap();
    let first_job = fake.job_of(first as u32).unwrap();
    fake.wait_job_errors.borrow_mut().insert(first_job, 63);
    assert_eq!(wait_status(&executor, &runtime, first), Ok(0));
    let later = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    fake.kill_job_errors.borrow_mut().insert(first_job, 71);
    assert_eq!(
        runtime.kill_group(group, 15),
        Err(ProcessError::Runtime(71))
    );
    assert_eq!(
        *fake.signals.borrow(),
        vec![(true, first_job, 15), (true, later_job, 15)]
    );
    fake.wait_job_errors.borrow_mut().insert(first_job, 63);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group))
        ),
        Err(ProcessError::Runtime(63))
    );
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job]);
    assert!(
        runtime.0.groups.borrow().contains_key(&group),
        "failed confirmation keeps cleanup ownership"
    );
    fake.wait_job_errors.borrow_mut().remove(&first_job);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group))
        ),
        Ok(())
    );
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job, first_job]);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_eq!(runtime.retained_count(), 0);
}

#[test]
fn sigint_registration_calls_runtime_with_handle_not_ignore() {
    // Exercise the same registration path WasiAbi passes to proc_signal, not a
    // mock preconfigured with handled signals. Pin the numeric wire arguments.
    let mut registered = None;
    assert_eq!(
        register_interrupt_handler(|signal, disposition| {
            registered = Some((signal, disposition));
            0
        }),
        Ok(())
    );
    assert_eq!(registered, Some((2, 2)));
    assert_eq!(SIGNAL_DISPOSITION_HANDLE, 2);
    assert_eq!(
        register_interrupt_handler(|_, disposition| {
            assert_ne!(disposition, 1, "mode 1 silently ignores SIGINT");
            -28
        }),
        Err(28)
    );
}

#[test]
fn sigwinch_registration_handles_signal_28() {
    let mut registered = None;
    assert_eq!(
        register_handler(SIGWINCH, |signal, disposition| {
            registered = Some((signal, disposition));
            0
        }),
        Ok(())
    );
    assert_eq!(registered, Some((28, SIGNAL_DISPOSITION_HANDLE)));
}

#[test]
fn a_window_change_taken_at_a_checkpoint_is_kept_for_the_prompt_reader() {
    let (_executor, fake, runtime) = setup();
    assert!(!runtime.take_window_change());
    fake.interrupt.set(SIGWINCH);
    assert!(!runtime.take_interrupt(), "SIGWINCH is not an interrupt");
    assert!(runtime.take_window_change());
    assert!(!runtime.take_window_change(), "one wake per delivery");
    fake.interrupt.set(SIGINT);
    assert!(runtime.take_interrupt());
    assert!(!runtime.take_window_change());
}

#[test]
fn runtime_mkdir_and_grep_are_external_programs_not_shell_stand_ins() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let job = session
        .start("mkdir -p nested/deep; grep -n tick result; cat result; seq 2")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let requests = fake.requests.borrow();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.executable.as_str())
            .collect::<Vec<_>>(),
        [
            "/home/guest/mkdir",
            "/home/guest/grep",
            "/home/guest/cat",
            "/home/guest/seq"
        ]
    );
    assert_eq!(requests[0].argv, ["mkdir", "-p", "nested/deep"]);
    assert_eq!(requests[1].argv, ["grep", "-n", "tick", "result"]);
    assert!(fake.fs.read_file("/home/guest/nested/deep/result").is_err());
    assert!(fake.output.bytes().is_empty());
}

#[test]
fn inherited_shell_bootstrap_preserves_extra_and_sparse_logical_bindings() {
    let (executor, fake, runtime) = setup();
    fake.fs
        .write_file("/descriptor-data", b"shared-offset\nremaining")
        .unwrap();
    let file = fake
        .fs
        .open("/descriptor-data", &OpenOptions::default())
        .unwrap();
    let stdout = fake.fds.borrow().get(&1).unwrap().clone();
    fake.fds.borrow_mut().extend([
        (3, stdout),
        (4, file),
        (1_000_000, Endpoint::null()),
        (i32::MAX as u32, Endpoint::null()),
    ]);
    *fake.inherited.borrow_mut() = vec![0, 1, 2, 3, 4, 1_000_000, i32::MAX as u32];
    // A private physical descriptor must never become an inherited logical binding.
    let private = fake.fd(Endpoint::null());
    let fds = runtime.stdio().unwrap();
    assert_eq!(
        fds.iter().map(|(&fd, _)| fd).collect::<Vec<_>>(),
        *fake.inherited.borrow()
    );
    assert!(fds.get(private).is_none());
    let session = Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    );
    session.set_descriptors(fds).unwrap();
    let job = session
        .start("read -r -u 4 value; printf 'DIRECT_FD3:%s\\n' \"$value\" >&3")
        .unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(fake.output.bytes(), b"DIRECT_FD3:shared-offset\n");
    // The inherited file was duplicated, not reopened: its original offset moved too.
    let mut remaining = [0; 9];
    assert_eq!(fake.read(4, &mut remaining), Ok(remaining.len()));
    assert_eq!(&remaining, b"remaining");
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    assert_eq!(
        fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
        vec![0, 1, 2, 3, 4, private, 1_000_000, i32::MAX as u32]
    );
}

#[test]
fn empty_inherited_shell_bindings_do_not_recreate_stdio() {
    let (_executor, fake, runtime) = setup();
    fake.inherited.borrow_mut().clear();
    let fds = runtime.stdio().unwrap();
    assert_eq!(fds.iter().count(), 0);
    assert_eq!(fake.fds.borrow().len(), 3);
}

#[test]
fn noninteractive_shell_preserves_closed_stdio_and_requires_only_used_descriptors() {
    for (inherited, source, status, expected) in [
        (vec![0, 1], "printf CLOSED_STDERR_OK", 0, "CLOSED_STDERR_OK"),
        (vec![1, 2], "printf CLOSED_STDIN_OK", 0, "CLOSED_STDIN_OK"),
        (vec![0, 2], ":", 0, ""),
        (vec![0, 2], "printf inaccessible", 1, ""),
        (vec![], ":", 0, ""),
        (vec![], "printf inaccessible", 1, ""),
    ] {
        let (executor, fake, runtime) = setup();
        *fake.inherited.borrow_mut() = inherited.clone();
        fake.fds.borrow_mut().retain(|fd, _| inherited.contains(fd));
        let session = Session::new(
            executor.clone(),
            Rc::new(runtime.clone()),
            Rc::new(runtime.clone()),
            Limits::default(),
        );
        let fds = runtime.stdio().unwrap();
        assert_eq!(fds.iter().map(|(&fd, _)| fd).collect::<Vec<_>>(), inherited);
        session.set_descriptors(fds).unwrap();
        let job = session.start(source).unwrap();
        assert_eq!(finish(&executor, &runtime, job), status, "{source}");
        assert_eq!(fake.output.bytes(), expected.as_bytes(), "{source}");
        finish(
            &executor,
            &runtime,
            executor.spawn(async move { session.shutdown().await }),
        );
        assert_eq!(
            fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
            inherited
        );
    }
}

#[test]
fn substitution_descriptors_cross_the_actual_runtime_spawn_boundary() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let job = session.start("v=$(emit); printf '%s' \"$v\"; runtime-cat < <(printf streamed); pid=$!; wait \"$pid\"").unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let mut expected = b"runtime bytes\n".repeat(64);
    expected.pop();
    expected.extend_from_slice(b"streamed");
    assert_eq!(fake.output.bytes(), expected);
    let requests = fake.requests.borrow();
    assert_eq!(
        requests
            .iter()
            .map(|request| request.executable.as_str())
            .collect::<Vec<_>>(),
        ["/home/guest/emit", "/home/guest/runtime-cat"]
    );
    let consumer = &requests[1];
    let stdin = consumer
        .fds
        .iter()
        .find(|binding| binding.child == 0)
        .unwrap()
        .parent;
    // Reopening a pipe creates a new physical binding to the same stream.
    // The streamed output above and cleanup below verify shared ownership.
    assert_ne!(
        consumer
            .fds
            .iter()
            .find(|binding| binding.child == 63)
            .unwrap()
            .parent,
        stdin
    );
    assert!(
        requests
            .iter()
            .all(|request| request.fds.iter().all(|binding| binding.parent >= 10))
    );
    drop(requests);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_eq!(fake.reaped_jobs.borrow().len(), 2);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn large_heredoc_inputs_stream_after_spawn_and_aliases_share_read_position() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let payload = "x".repeat(io::PIPE_CAPACITY * 3);
    session
        .state()
        .borrow_mut()
        .assign_parameter("payload".into(), payload.clone())
        .unwrap();
    let job = session.start("runtime-cat <<< \"$payload\"; runtime-cat <<EOF\n$payload\nEOF\nf() { take-one; runtime-cat; }; f 3<<<abcd 0<&3").unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    let expected = format!("{payload}\n{payload}\nabcd\n");
    assert_eq!(fake.output.bytes(), expected.as_bytes());
    assert_eq!(fake.requests.borrow().len(), 4);
    let requests = fake.requests.borrow();
    let first = &requests[2];
    let next = &requests[3];
    let fd = first
        .fds
        .iter()
        .find(|binding| binding.child == 0)
        .unwrap()
        .parent;
    assert_eq!(
        first
            .fds
            .iter()
            .find(|binding| binding.child == 3)
            .unwrap()
            .parent,
        fd
    );
    assert_eq!(
        next.fds
            .iter()
            .find(|binding| binding.child == 0)
            .unwrap()
            .parent,
        fd
    );
    drop(requests);
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn failed_spawn_and_redirect_never_leave_a_buffered_input_writer() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    session
        .state()
        .borrow_mut()
        .assign_parameter("payload".into(), "x".repeat(io::PIPE_CAPACITY * 3))
        .unwrap();
    let baseline: Vec<_> = fake.fds.borrow().keys().copied().collect();
    let next_fd = fake.next_fd.get();
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session
                .start("runtime-cat <<< \"$payload\" < /missing")
                .unwrap()
        ),
        1
    );
    assert_eq!(
        fake.next_fd.get(),
        next_fd,
        "no pipe writer starts during redirection preparation"
    );
    fake.spawn_errors
        .borrow_mut()
        .insert("runtime-cat".into(), 44);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session.start("runtime-cat <<< \"$payload\"").unwrap()
        ),
        127
    );
    assert!(fake.requests.borrow().is_empty());
    assert_eq!(
        fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
        baseline
    );
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert!(runtime.0.inputs.borrow().is_empty());
    assert_eq!(executor.drive(64).pending, 0);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn buffered_input_admission_is_bounded_and_released_after_cancellation() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_background_group();
    let mut guard = ProcessGroup::new(Rc::new(runtime.clone()), group);
    let mut admitted = 0;
    for _ in 0..32 {
        let mut child = request(&runtime, "sleep", group);
        child
            .fds
            .insert(0, Endpoint::bytes(vec![b'x'; 1024 * 1024]));
        match runtime.spawn(child) {
            Ok(_) => admitted += 1,
            Err(error) => {
                assert_eq!(error, ProcessError::ProcessLimit);
                break;
            }
        }
    }
    assert!(admitted > 0 && admitted < 32);
    assert_eq!(fake.requests.borrow().len(), admitted);
    assert!(runtime.0.input_slots.get() > 0);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(async move { guard.terminate(15).await })
        ),
        Ok(())
    );
    assert!(
        fake.children
            .borrow()
            .values()
            .all(|child| child.status.get() == Some(WaitResult::Signaled(15)))
    );
    assert!(runtime.0.groups.borrow().is_empty());
    assert_input_released(&runtime);
    assert_eq!(runtime.retained_count(), 0);
    assert_host_idle(&executor, &fake);
}

#[test]
fn shutting_down_one_session_preserves_a_peer_buffered_reader() {
    let (executor, fake, runtime) = setup();
    let first = runtime_session(&executor, &runtime);
    let second = runtime_session(&executor, &runtime);
    let payload = vec![b'x'; io::PIPE_CAPACITY * 3];
    let input = Endpoint::bytes(payload.clone());
    let mut first_fds = runtime.stdio().unwrap();
    first_fds.insert(0, input.clone());
    first.set_descriptors(first_fds).unwrap();
    let mut second_fds = runtime.stdio().unwrap();
    second_fds.insert(0, input.clone());
    second.set_descriptors(second_fds).unwrap();
    drop(input);
    assert_eq!(
        finish(&executor, &runtime, first.start("take-one").unwrap()),
        0
    );
    assert!(
        runtime.0.input_slots.get() > 0,
        "the rest exceeds one pipe and still needs its writer"
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { first.shutdown().await }),
    );
    assert!(
        runtime.0.input_slots.get() > 0,
        "a peer still owns the open reader"
    );
    assert_eq!(
        finish(&executor, &runtime, second.start("runtime-cat").unwrap()),
        0
    );
    assert_eq!(fake.output.bytes(), payload);
    assert!(fake.signals.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, second);
}

#[test]
fn builtin_only_capture_and_process_substitution_groups_return_to_baseline() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let baseline: Vec<_> = fake.fds.borrow().keys().copied().collect();
    for _ in 0..64 {
        let job = session
            .start("v=$(printf x); : <(true); wait \"$!\"")
            .unwrap();
        assert_eq!(finish(&executor, &runtime, job), 0);
        assert!(runtime.0.groups.borrow().is_empty());
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(
            fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
            baseline
        );
    }
    assert!(fake.requests.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn capture_eof_can_precede_group_descendant_reaping_but_keeps_a_cleanup_owner() {
    for cancel in [false, true] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        let command = session.start("v=$(emit); echo CAPTURED").unwrap();
        for _ in 0..1000 {
            executor.drive(1);
            if !fake.requests.borrow().is_empty() {
                break;
            }
            runtime.poll(0).unwrap();
        }
        let job = fake
            .children
            .borrow()
            .values()
            .next()
            .expect("external capture actually spawned")
            .job;
        fake.held_jobs.borrow_mut().insert(job);
        assert_eq!(finish(&executor, &runtime, command), 0);
        assert_eq!(fake.output.bytes(), b"CAPTURED\n");
        assert_eq!(runtime.retained_count(), 0);
        assert_eq!(
            runtime.0.groups.borrow().len(),
            1,
            "the outliving descendant still has an owner"
        );
        if cancel {
            let closing = session.clone();
            let shutdown = executor.spawn(async move { closing.shutdown().await });
            executor.drive(128);
            runtime.poll(0).unwrap();
            executor.drive(128);
            assert!(fake.signals.borrow().contains(&(true, job, 2)));
            assert!(
                !shutdown.is_finished(),
                "delivery is not descendant exit confirmation"
            );
            fake.held_jobs.borrow_mut().remove(&job);
            runtime.poll(0).unwrap();
            finish(&executor, &runtime, shutdown);
        } else {
            assert!(fake.signals.borrow().is_empty());
            fake.held_jobs.borrow_mut().remove(&job);
            for _ in 0..100 {
                runtime.poll(0).unwrap();
                executor.drive(64);
                if runtime.0.groups.borrow().is_empty() {
                    break;
                }
            }
        }
        assert!(fake.reaped_jobs.borrow().contains(&job));
        assert!(runtime.0.groups.borrow().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn requested_signals_reach_children_substitutions_and_all_group_cleanup() {
    for (launch, selector) in [
        ("sleep &", "%1"),
        ("v=$(sleep) &", "%1"),
        (": <(sleep); pid=$!", "\"$pid\""),
    ] {
        runtime_signal_forms(launch, selector);
    }
}

fn runtime_signal_forms(launch: &str, selector: &str) {
    for (form, signal, status) in [
        ("", 15, 143),
        ("-s TERM", 15, 143),
        ("-15", 15, 143),
        ("-s INT", 2, 130),
        ("-2", 2, 130),
    ] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(&executor, &runtime, session.start(launch).unwrap()),
            0
        );
        for _ in 0..1000 {
            executor.drive(64);
            runtime.poll(0).unwrap();
            if !fake.requests.borrow().is_empty() {
                break;
            }
        }
        assert_eq!(
            fake.requests.borrow().len(),
            1,
            "the real runtime child must start: {launch}"
        );
        let (pid, group) = fake
            .children
            .borrow()
            .iter()
            .map(|(&pid, child)| (pid, child.job))
            .next()
            .unwrap();
        let source = format!("kill {form} {selector}; wait {selector}");
        assert_eq!(
            finish(&executor, &runtime, session.start(&source).unwrap()),
            status,
            "{launch}: {source}"
        );
        let signals = fake.signals.borrow();
        assert!(
            signals.contains(&(false, pid, signal)),
            "direct child delivery: {launch}: {source}"
        );
        assert!(
            signals.contains(&(true, group, signal)),
            "group delivery: {launch}: {source}"
        );
        assert!(
            signals.iter().all(|(_, _, actual)| *actual == signal),
            "{launch}: {source}"
        );
        drop(signals);
        assert!(runtime.0.groups.borrow().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn interrupt_and_shutdown_drain_live_capture_and_blocked_input_writers() {
    for source in ["v=$(sleep)", "sleep <<< \"$payload\""] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        session
            .state()
            .borrow_mut()
            .assign_parameter("payload".into(), "x".repeat(io::PIPE_CAPACITY * 3))
            .unwrap();
        let job = session.start(source).unwrap();
        for _ in 0..1000 {
            executor.drive(64);
            runtime.poll(0).unwrap();
            if !fake.requests.borrow().is_empty() {
                break;
            }
        }
        assert_eq!(fake.requests.borrow().len(), 1);
        assert!(!job.is_finished());
        session.interrupt();
        assert_eq!(finish(&executor, &runtime, job), 130);
        assert!(
            fake.signals
                .borrow()
                .iter()
                .all(|(_, _, signal)| *signal == 2)
        );
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

fn open_fake_wasi_directory(
    executor: &Executor,
    runtime: &Runtime,
    fake: &Fake,
    path: &str,
    entries: Vec<(u64, Vec<u8>)>,
) -> Rc<dyn io::Directory> {
    fake.named_wasi_directories
        .borrow_mut()
        .insert(path.to_owned(), Rc::new(entries));
    let guest = runtime.clone();
    let path = path.to_owned();
    let job = executor.spawn(async move { FileSystem::open_dir(&guest, &path).await });
    finish(executor, runtime, job).unwrap()
}

fn read_fake_wasi_entry(
    executor: &Executor,
    runtime: &Runtime,
    directory: Rc<dyn io::Directory>,
    cookie: u64,
) -> Result<Option<(u64, Vec<u8>)>, IoError> {
    let job = executor.spawn(async move {
        let mut output = vec![0; io::MAX_PATH_BYTES + 24];
        let entry = directory.read_entry(cookie, &mut output).await?;
        Ok(entry.map(|entry| {
            let name = output[entry.name].to_vec();
            (entry.next_cookie, name)
        }))
    });
    finish(executor, runtime, job)
}

fn fake_wasi_names(
    executor: &Executor,
    runtime: &Runtime,
    directory: Rc<dyn io::Directory>,
) -> Result<Vec<Vec<u8>>, IoError> {
    let mut cookie = 0;
    let mut names = Vec::new();
    loop {
        let Some((next, name)) =
            read_fake_wasi_entry(executor, runtime, directory.clone(), cookie)?
        else {
            return Ok(names);
        };
        assert_ne!(next, cookie);
        cookie = next;
        names.push(name);
    }
}

#[test]
fn runtime_directory_consumes_a_full_wasi_page_before_refilling() {
    let (executor, fake, runtime) = setup();
    let entries: Vec<_> = (0..1000)
        .map(|index| {
            (
                42 + (index as u64 + 1) * 7919,
                format!("n{index:08}").into_bytes(),
            )
        })
        .collect();
    let directory = open_fake_wasi_directory(
        &executor,
        &runtime,
        &fake,
        "/tmp/wasi-pages",
        entries.clone(),
    );
    let names = fake_wasi_names(&executor, &runtime, directory.clone()).unwrap();
    let expected: Vec<_> = entries.into_iter().map(|(_, name)| name).collect();
    assert_eq!(names, expected);
    let calls = fake.readdir_calls.borrow();
    assert_eq!(calls.len(), 10);
    assert_eq!(calls.iter().map(|(_, _, used)| used).sum::<usize>(), 33224);
    let fd = calls[0].0;
    drop(calls);
    drop(directory);
    assert!(fake.closed.borrow().contains(&fd));
}

#[test]
fn runtime_directory_retries_partial_headers_and_names_without_losing_entries() {
    let cases = [
        (
            vec![
                (11, vec![b'a'; 4000]),
                (29, vec![b'b'; 62]),
                (47, b"tail".to_vec()),
            ],
            3,
        ),
        (
            vec![
                (101, b"alpha".to_vec()),
                (202, "é中".as_bytes().to_vec()),
                (303, vec![b'x'; io::MAX_PATH_BYTES]),
                (404, b"last".to_vec()),
            ],
            4,
        ),
    ];
    for (entries, expected_calls) in cases {
        let (executor, fake, runtime) = setup();
        let directory = open_fake_wasi_directory(
            &executor,
            &runtime,
            &fake,
            "/tmp/wasi-partials",
            entries.clone(),
        );
        let names = fake_wasi_names(&executor, &runtime, directory).unwrap();
        let expected: Vec<_> = entries.into_iter().map(|(_, name)| name).collect();
        assert_eq!(names, expected);
        assert_eq!(fake.readdir_calls.borrow().len(), expected_calls);
    }
}

#[test]
fn runtime_directory_rejects_an_incomplete_first_record() {
    let (executor, fake, runtime) = setup();
    let directory = open_fake_wasi_directory(
        &executor,
        &runtime,
        &fake,
        "/tmp/wasi-incomplete",
        vec![(77, vec![b'x'; io::MAX_PATH_BYTES + 1])],
    );
    let result = read_fake_wasi_entry(&executor, &runtime, directory, 0);
    assert!(matches!(result, Err(IoError::LimitExceeded)));
    assert_eq!(fake.readdir_calls.borrow().len(), 1);
}

#[test]
fn runtime_directory_rejects_stalled_cookies_before_copying_names() {
    let (executor, fake, runtime) = setup();
    let directory = open_fake_wasi_directory(
        &executor,
        &runtime,
        &fake,
        "/tmp/wasi-stalled",
        vec![(101, b"first".to_vec()), (101, b"second".to_vec())],
    );
    let first = read_fake_wasi_entry(&executor, &runtime, directory.clone(), 0).unwrap();
    assert_eq!(first, Some((101, b"first".to_vec())));
    let second = read_fake_wasi_entry(&executor, &runtime, directory, 101);
    assert!(matches!(second, Err(IoError::LimitExceeded)));
    assert_eq!(fake.readdir_calls.borrow().len(), 1);
}

#[test]
fn runtime_directory_cancellation_closes_a_retained_page() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    fake.fs.mkdir("/tmp/wasi-cancel", true).unwrap();
    let entries = (0..100)
        .map(|index| (index + 1, format!("name-{index}").into_bytes()))
        .collect();
    fake.named_wasi_directories
        .borrow_mut()
        .insert("/tmp/wasi-cancel".into(), Rc::new(entries));
    let job = session
        .start("cd /tmp/wasi-cancel; for f in *; do echo \"$f\"; done")
        .unwrap();
    for _ in 0..1000 {
        executor.drive(1);
        runtime.poll(0).unwrap();
        if !fake.readdir_calls.borrow().is_empty() {
            break;
        }
    }
    assert_eq!(fake.readdir_calls.borrow().len(), 1);
    assert!(!job.is_finished());
    let fd = fake.readdir_calls.borrow()[0].0;
    session.interrupt();
    assert_eq!(finish(&executor, &runtime, job), 130);
    assert!(fake.wasi_directories.borrow().is_empty());
    assert!(fake.closed.borrow().contains(&fd));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn runtime_for_globs_stream_names_and_close_directory_descriptors() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    fake.fs.mkdir("/tmp/runtime-glob", true).unwrap();
    let source = r#"cd /tmp/runtime-glob; : >b.txt; : >a.txt; shopt -s nullglob; for f in *.missing *.txt; do echo "$f"; done"#;
    let job = session.start(source).unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(fake.output.bytes(), b"a.txt\nb.txt\n");
    assert!(fake.directories.borrow().is_empty());
    assert!(
        fake.closed.borrow().len() >= 4,
        "both redirect and directory descriptors close"
    );
    shutdown_session(&executor, &runtime, &fake, session);
    assert!(fake.directories.borrow().is_empty());
}

#[test]
fn runtime_argv_globs_sort_names_and_keep_protected_or_noglob_words() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    fake.fs.mkdir("/tmp/runtime-argv-glob", true).unwrap();
    let source = concat!(
        "cd /tmp/runtime-argv-glob; : >b; : >ab; : >a; : >.a\n",
        "echo a* '?' \\[ab] z*; v='* b'; echo $v \"$v\"\n",
        "shopt -s nullglob; echo start z* [q] end; shopt -u nullglob\n",
        "set -f; echo a* $v; set +f; echo [ab]",
    );
    let job = session.start(source).unwrap();
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(
        String::from_utf8_lossy(&fake.output.bytes()),
        "a ab ? [ab] z*\na ab b b * b\nstart end\na* * b\na b\n"
    );
    shutdown_session(&executor, &runtime, &fake, session);
    assert!(fake.directories.borrow().is_empty());
}

#[test]
fn natural_foreground_completion_does_not_wait_for_inherited_members() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let command = session.start("external-done; echo READY").unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 1);
    let job = fake.children.borrow().values().next().unwrap().job;
    fake.held_jobs.borrow_mut().insert(job);
    for _ in 0..8 {
        executor.drive(128);
        runtime.poll(0).unwrap();
    }
    assert_eq!(fake.output.bytes(), b"READY\n");
    assert!(command.is_finished(), "prompt must precede descendant exit");
    assert_eq!(command.now_or_never(), Some(0));
    assert!(fake.signals.borrow().is_empty());
    assert!(!fake.reaped_jobs.borrow().contains(&job));
    assert_eq!(session.background_jobs(), 0);
    fake.held_jobs.borrow_mut().remove(&job);
    for _ in 0..8 {
        runtime.poll(0).unwrap();
        executor.drive(128);
    }
    assert!(fake.reaped_jobs.borrow().contains(&job));
    assert!(runtime.0.groups.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, session);
}

fn inherited_member(fake: &Fake) -> (u32, u32) {
    let children = fake.children.borrow();
    let (&pid, child) = children.iter().next_back().expect("inherited member");
    assert_eq!(
        children.len(),
        2,
        "one direct child and one inherited process"
    );
    (pid, child.job)
}

#[test]
fn inherited_member_outlives_direct_foreground_but_not_runtime_reaping() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let (reader, writer) = runtime.pipe().unwrap();
    let mut fds = runtime.stdio().unwrap();
    fds.insert(3, writer);
    session.set_descriptors(fds).unwrap();
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session.start("inherit-fail; echo READY").unwrap()
        ),
        0
    );
    let (descendant, job) = inherited_member(&fake);
    assert_eq!(fake.wait(descendant), Err(AGAIN));
    assert_eq!(runtime.retained_count(), 0, "no shell-known child remains");
    assert_eq!(
        session.background_jobs(),
        0,
        "foreground never creates a %job"
    );
    assert_eq!(fake.output.bytes(), b"READY\n");
    assert!(fake.signals.borrow().is_empty());
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session.start("exec 3>&-; jobs; wait; wait %1").unwrap()
        ),
        127
    );
    let mut byte = [0];
    assert!(
        reader.read(&mut byte).now_or_never().is_none(),
        "member, not shell, keeps inherited writer open"
    );
    fake.descendant_gate.cancel();
    for _ in 0..16 {
        executor.drive(128);
        runtime.poll(0).unwrap();
    }
    assert_eq!(fake.child_status(descendant), Some(23));
    assert_eq!(reader.read(&mut byte).now_or_never(), Some(Ok(0)));
    assert!(fake.reaped_jobs.borrow().contains(&job));
    assert!(runtime.0.groups.borrow().is_empty());
    drop(reader);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn background_wait_jobs_and_kill_do_not_adopt_inherited_members() {
    for wait in ["wait \"$p\"", "wait %1", "wait"] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(
                &executor,
                &runtime,
                session.start("inherit-fail & p=$!").unwrap()
            ),
            0
        );
        let (descendant, job) = inherited_member(&fake);
        let command = format!(
            "while kill -0 \"$p\" 2>/dev/null; do :; done; {wait}; echo status=$?; jobs; jobs; wait \"$p\"; echo remembered=$?; wait %1; echo percent=$?"
        );
        assert_eq!(
            finish(&executor, &runtime, session.start(&command).unwrap()),
            0
        );
        let expected = if wait == "wait" {
            "status=0\nremembered=127\npercent=127\n"
        } else {
            "status=7\nremembered=7\npercent=127\n"
        };
        assert_eq!(fake.output.bytes(), expected.as_bytes(), "{wait}");
        assert_eq!(fake.wait(descendant), Err(AGAIN));
        assert_eq!(session.background_jobs(), 0);
        assert!(fake.signals.borrow().is_empty());
        assert!(!fake.reaped_jobs.borrow().contains(&job));
        // Runtime-only residual signal ownership survives removal from jobs.
        let group = *runtime.0.groups.borrow().keys().next().unwrap();
        runtime.kill_group(group, 15).unwrap();
        assert_eq!(
            finish(
                &executor,
                &runtime,
                executor.spawn(runtime.wait_group(group))
            ),
            Ok(())
        );
        assert_eq!(fake.child_status(descendant), Some(143));
        assert!(fake.reaped_jobs.borrow().contains(&job));
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn jobs_reports_direct_done_once_without_signaling_residual_members() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session.start("inherit & p=$!").unwrap()
        ),
        0
    );
    let (descendant, _) = inherited_member(&fake);
    let command = "while kill -0 \"$p\" 2>/dev/null; do :; done; kill %1; echo percentkill=$?; kill \"$p\" 2>/dev/null; echo numerickill=$?; jobs; jobs; wait \"$p\"; echo remembered=$?; wait %1; echo percent=$?";
    assert_eq!(
        finish(&executor, &runtime, session.start(command).unwrap()),
        0
    );
    assert_eq!(fake.output.bytes(), b"percentkill=0\nnumerickill=1\n[1]+  Done                       inherit\nremembered=0\npercent=127\n");
    assert_eq!(fake.wait(descendant), Err(AGAIN));
    assert!(fake.signals.borrow().is_empty());
    shutdown_session(&executor, &runtime, &fake, session);
    assert_eq!(fake.child_status(descendant), Some(130));
}

#[test]
fn later_foreground_interrupt_isolates_prior_residual_and_shared_peer_session() {
    let (executor, fake, runtime) = setup();
    let first = runtime_session(&executor, &runtime);
    let peer = runtime_session(&executor, &runtime);
    assert_eq!(
        finish(&executor, &runtime, first.start("inherit").unwrap()),
        0
    );
    let (descendant, residual_job) = inherited_member(&fake);
    assert_eq!(
        finish(&executor, &runtime, peer.start("sleep &").unwrap()),
        0
    );
    let command = first.start("sleep").unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 3);
    first.interrupt();
    assert_eq!(finish(&executor, &runtime, command), 130);
    assert_eq!(fake.wait(descendant), Err(AGAIN));
    assert!(
        !fake
            .signals
            .borrow()
            .iter()
            .any(|&(group, id, _)| group && id == residual_job)
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { first.shutdown().await }),
    );
    assert_eq!(fake.child_status(descendant), Some(130));
    assert_eq!(peer.background_jobs(), 1);
    assert_eq!(
        runtime.retained_count(),
        1,
        "peer process remains owned by peer"
    );
    shutdown_session(&executor, &runtime, &fake, peer);
}

#[test]
fn interrupt_and_shutdown_drain_real_inherited_members_and_input_pumps() {
    for source in ["inherit-sleep <<< \"$payload\"", "v=$(inherit-sleep)"] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        session
            .state()
            .borrow_mut()
            .assign_parameter("payload".into(), "x".repeat(io::PIPE_CAPACITY * 3))
            .unwrap();
        let command = session.start(source).unwrap();
        drive_until_spawn(&executor, &runtime, &fake, 1);
        let (descendant, job) = inherited_member(&fake);
        assert!(!command.is_finished());
        session.interrupt();
        assert_eq!(finish(&executor, &runtime, command), 130);
        assert_eq!(fake.child_status(descendant), Some(130));
        assert!(fake.signals.borrow().contains(&(true, job, 2)));
        assert!(fake.reaped_jobs.borrow().contains(&job));
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn inherited_completion_keeps_pipeline_status_and_pipefail_direct_only() {
    for (source, expected) in [
        ("inherit-fail | true", 0),
        ("set -o pipefail; inherit-fail | true", 7),
    ] {
        let (executor, fake, runtime) = setup();
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(&executor, &runtime, session.start(source).unwrap()),
            expected
        );
        let (descendant, _) = inherited_member(&fake);
        assert_eq!(session.state().borrow().pipeline_status(), vec![7, 0]);
        assert_eq!(fake.wait(descendant), Err(AGAIN));
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn completed_inherited_jobs_release_admission_during_one_foreground_group() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    for _ in 0..MAX_RETAINED_PROCESSES + 1 {
        let direct = runtime.spawn(request(&runtime, "inherit", group)).unwrap();
        executor.drive(64);
        assert_eq!(wait_status_now(&runtime, direct), Some(Ok(0)));
        let member = direct as u32 + 1;
        assert_eq!(fake.wait(member), Err(AGAIN));
        fake.descendant_gates.borrow()[&member].cancel();
        executor.drive(64);
        assert_eq!(fake.child_status(member), Some(23));
    }
    assert_eq!(runtime.retained_count(), 0);
    assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
    assert_eq!(fake.reaped_jobs.borrow().len(), MAX_RETAINED_PROCESSES + 1);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_host_idle(&executor, &fake);
}

#[test]
fn group_reaps_later_inherited_job_while_earlier_member_stays_live() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let first = runtime.spawn(request(&runtime, "inherit", group)).unwrap();
    let later = runtime.spawn(request(&runtime, "inherit", group)).unwrap();
    executor.drive(64);
    assert_eq!(wait_status_now(&runtime, first), Some(Ok(0)));
    assert_eq!(wait_status_now(&runtime, later), Some(Ok(0)));
    let first_job = fake.job_of(first as u32).unwrap();
    let later_job = fake.job_of(later as u32).unwrap();
    let done = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    let calls = fake.wait_job_calls.borrow().len();
    let idle = executor.drive(64);
    assert_eq!(idle.polls, 0, "pending jobs must park on ABI readiness");
    assert_eq!(fake.wait_job_calls.borrow().len(), calls);
    fake.descendant_gates.borrow()[&(later as u32 + 1)].cancel();
    executor.drive(64);
    runtime.poll(0).unwrap();
    executor.drive(64);
    assert_eq!(fake.wait(first as u32 + 1), Err(AGAIN));
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job]);
    assert!(!done.is_finished());
    assert_eq!(runtime.retained_slots(), 1);
    fake.descendant_gates.borrow()[&(first as u32 + 1)].cancel();
    assert_eq!(finish(&executor, &runtime, done), Ok(()));
    assert_eq!(*fake.reaped_jobs.borrow(), vec![later_job, first_job]);
    assert_eq!(runtime.0.support.waiter_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert_host_idle(&executor, &fake);
}

#[test]
fn detaching_empty_runtime_group_returns_ready_without_a_reaper_task() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let done = runtime.detach_group(group);
    assert!(done.is_finished());
    assert_eq!(done.now_or_never(), Some(Ok(())));
    assert_eq!(executor.drive(64).polls, 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(runtime.0.waits.borrow().is_empty());
    assert_eq!(runtime.0.support.waiter_count(), 0);
    assert!(fake.polls.borrow().is_empty());
}

#[test]
fn admission_sweep_preserves_unconsumed_direct_status_and_failed_job_handles() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    let first = runtime.spawn(request(&runtime, "done", group)).unwrap();
    executor.drive(64);
    let first_job = fake.job_of(first as u32).unwrap();
    let second = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    assert!(fake.reaped_jobs.borrow().is_empty());
    assert_eq!(runtime.retained_count(), 2);
    fake.wait_job_errors.borrow_mut().insert(first_job, 63);
    assert_eq!(wait_status_now(&runtime, first), Some(Ok(0)));
    let third = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
    assert!(
        runtime.0.groups.borrow()[&group]
            .runtime_jobs
            .contains(&first_job)
    );
    runtime.kill_group(group, 15).unwrap();
    assert!(fake.signals.borrow().contains(&(true, first_job, 15)));
    assert_eq!(
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group))
        ),
        Err(ProcessError::Runtime(63))
    );
    assert_eq!(fake.child_status(second as u32), Some(143));
    assert_eq!(fake.child_status(third as u32), Some(143));
    fake.wait_job_errors.borrow_mut().remove(&first_job);
    let sibling = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "done", sibling)).unwrap();
    assert!(fake.reaped_jobs.borrow().contains(&first_job));
    assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
    assert_eq!(wait_status(&executor, &runtime, pid), Ok(0));
    assert_eq!(runtime.wait_group(sibling).now_or_never(), Some(Ok(())));
    assert!(runtime.0.groups.borrow().is_empty());
    assert_host_idle(&executor, &fake);
}

#[test]
fn admission_sweep_wakes_parked_job_wait_without_releasing_its_input_pump() {
    let (executor, fake, runtime) = setup();
    let (group, source, direct, job) = inherited_input(&executor, &runtime, &fake);
    let done = executor.spawn(runtime.wait_group(group));
    executor.drive(64);
    assert_ne!(u64::from(job), group);
    let mut reaped_job = Box::pin(runtime.0.support.ready(4, job));
    assert!(reaped_job.as_mut().now_or_never().is_none());
    let mut unrelated = [
        (2, job),
        (4, u32::try_from(group).unwrap()),
        (4, job + 1),
        (5, job),
        (6, job),
    ]
    .map(|(kind, id)| Box::pin(runtime.0.support.ready(kind, id)));
    assert!(
        unrelated
            .iter_mut()
            .all(|wait| wait.as_mut().now_or_never().is_none())
    );
    fake.descendant_gates.borrow()[&(direct as u32 + 1)].cancel();
    executor.drive(64);
    let sibling = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "sleep", sibling)).unwrap();
    assert!(fake.reaped_jobs.borrow().contains(&job));
    assert!(!done.is_finished(), "sweep only wakes the cleanup owner");
    assert_eq!(reaped_job.as_mut().now_or_never(), Some(()));
    assert!(
        unrelated
            .iter_mut()
            .all(|wait| wait.as_mut().now_or_never().is_none())
    );
    drop(unrelated);
    assert_eq!(runtime.0.inputs.borrow().len(), 1);
    assert!(runtime.0.inputs.borrow()[0].users.contains(&group));
    assert!(runtime.0.input_slots.get() > 0);
    drop(source);
    executor.drive(128);
    assert_eq!(
        done.now_or_never(),
        Some(Ok(())),
        "no ABI poll of a reaped job is needed"
    );
    assert_input_released(&runtime);
    finish_sibling(&executor, &runtime, &fake, sibling, pid);
}

#[test]
fn healed_wait_errors_keep_logical_cleanup_bounded_until_successful_retry() {
    let (executor, fake, runtime) = setup();
    let mut failed = Vec::new();
    for attempt in 0..=MAX_RETAINED_PROCESSES {
        let group = runtime.allocate_group();
        let direct = runtime.spawn(request(&runtime, "inherit", group));
        if attempt == MAX_RETAINED_PROCESSES {
            assert_eq!(direct, Err(ProcessError::ProcessLimit));
            assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
            break;
        }
        let direct = direct.unwrap();
        executor.drive(64);
        assert_eq!(wait_status_now(&runtime, direct), Some(Ok(0)));
        let job = fake.job_of(direct as u32).unwrap();
        release_after_detach_error(&executor, &runtime, &fake, group, direct, job);
        failed.push(group);
    }
    assert_eq!(runtime.retained_count(), 0);
    assert_eq!(fake.reaped_jobs.borrow().len(), MAX_RETAINED_PROCESSES);
    assert_eq!(runtime.0.groups.borrow().len(), MAX_RETAINED_PROCESSES);
    assert_eq!(runtime.retained_slots(), MAX_RETAINED_PROCESSES);
    assert!(runtime.0.waits.borrow().is_empty());
    for group in failed {
        assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
    }
    assert_eq!(runtime.retained_slots(), 0);
    let group = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "done", group)).unwrap();
    assert_eq!(wait_status(&executor, &runtime, pid), Ok(0));
    finish_group_and_check_idle(&executor, &runtime, &fake, group);
}

#[test]
fn healed_wait_error_keeps_input_ownership_charged_until_retry_completes() {
    let (executor, fake, runtime) = setup();
    let (group, source, direct, job) = inherited_input(&executor, &runtime, &fake);
    release_after_detach_error(&executor, &runtime, &fake, group, direct, job);
    let sibling = runtime.allocate_group();
    let pid = runtime.spawn(request(&runtime, "sleep", sibling)).unwrap();
    assert!(fake.reaped_jobs.borrow().contains(&job));
    assert_eq!(
        runtime.retained_slots(),
        2,
        "healed ABI job is not full logical cleanup"
    );
    assert!(runtime.0.inputs.borrow()[0].users.contains(&group));
    drop(source);
    let retry = runtime.detach_group(group);
    assert!(
        !retry.is_finished(),
        "input-pump join still owns the failed slot"
    );
    assert_eq!(runtime.retained_slots(), 2);
    assert_eq!(finish(&executor, &runtime, retry), Ok(()));
    assert!(!runtime.0.groups.borrow().contains_key(&group));
    assert_eq!(runtime.retained_slots(), 1);
    assert_input_released(&runtime);
    finish_sibling(&executor, &runtime, &fake, sibling, pid);
}

#[test]
fn runtime_job_retention_is_bounded_and_empty_jobs_do_not_accumulate() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    for _ in 0..MAX_RETAINED_PROCESSES + 1 {
        let pid = runtime.spawn(request(&runtime, "done", group)).unwrap();
        executor.drive(64);
        assert_eq!(wait_status_now(&runtime, pid), Some(Ok(0)));
        assert!(runtime.0.groups.borrow()[&group].runtime_jobs.is_empty());
    }
    // Residual jobs, not just direct pid records, occupy the shared admission
    // budget. Populate only metadata here; member/signal behavior is tested above.
    runtime
        .0
        .groups
        .borrow_mut()
        .get_mut(&group)
        .unwrap()
        .runtime_jobs = (0..MAX_RETAINED_PROCESSES as u32).collect();
    fake.held_jobs
        .borrow_mut()
        .extend(0..MAX_RETAINED_PROCESSES as u32);
    let requests = fake.requests.borrow().len();
    assert_eq!(
        runtime.spawn(request(&runtime, "sleep", group)),
        Err(ProcessError::ProcessLimit)
    );
    assert_eq!(
        fake.requests.borrow().len(),
        requests,
        "failure precedes ABI reservation"
    );
    assert!(matches!(
        runtime.prepare_input(&Endpoint::bytes(b"x".to_vec()), 1),
        Err(ProcessError::ProcessLimit)
    ));
    assert_eq!(runtime.0.input_slots.get(), 0);
    assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
    runtime
        .0
        .groups
        .borrow_mut()
        .get_mut(&group)
        .unwrap()
        .runtime_jobs
        .clear();
    assert_eq!(runtime.wait_group(group).now_or_never(), Some(Ok(())));
    assert_eq!(runtime.retained_count(), 0);
    assert!(runtime.0.groups.borrow().is_empty());
    assert!(runtime.0.waits.borrow().is_empty());
    assert_host_idle(&executor, &fake);
}

#[test]
fn review_followup_pipeline_preserves_host_interrupt_probe() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let foreground = session.start("true | while true; do :; done").unwrap();
    for _ in 0..32 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    fake.interrupt.set(2);
    for _ in 0..128 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    let observed = foreground.is_finished();
    if !observed {
        session.interrupt();
    }
    let code = finish(&executor, &runtime, foreground);
    shutdown_session(&executor, &runtime, &fake, session);
    assert_eq!(code, 130);
    assert!(observed, "pipeline lost the host-provided interrupt probe");
    assert_eq!(fake.consumed_interrupts.get(), 1);
}

#[test]
fn review_followup_subshell_failure_does_not_close_enclosing_group() {
    for sibling in ["true", "sleep", "while true; do :; done"] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(48));
        let session = runtime_session(&executor, &runtime);
        let command = format!("( /startup-tool | {sibling} ); /ok; echo status:$?");
        let code = finish(&executor, &runtime, session.start(&command).unwrap());
        let ran_ok = fake
            .requests
            .borrow()
            .iter()
            .any(|request| request.executable == "/ok");
        let output = fake.output.bytes();
        shutdown_session(&executor, &runtime, &fake, session);
        assert_eq!(code, 0, "{command}");
        assert!(
            ran_ok,
            "isolated failed pipeline closed outer reader group: {command}"
        );
        assert_eq!(output, b"status:0\n", "{command}");
    }
}

#[test]
fn review_followup_successful_pipeline_substitution_keeps_interrupt_owner() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let foreground = session
        .start(": | : <(sleep); while true; do :; done")
        .unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 1);
    for _ in 0..64 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    let pid = fake
        .requests
        .borrow()
        .iter()
        .position(|request| request.executable.rsplit('/').next() == Some("sleep"))
        .map(|offset| offset as u32 + 100)
        .unwrap();
    session.interrupt();
    let code = finish(&executor, &runtime, foreground);
    for _ in 0..64 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    let retained = runtime.retained_count();
    let child_status = fake.child_status(pid);
    shutdown_session(&executor, &runtime, &fake, session);
    assert_eq!(code, 130);
    assert_eq!(
        retained, 0,
        "successful pipeline orphaned substitution cancellation"
    );
    assert_eq!(child_status, Some(130));
}

#[test]
fn review_followup_closed_stderr_does_not_use_core_fallback() {
    for (source, errno) in [("/startup-tool 2>&-", 44), ("{ /startup-tool; } 2>&-", 48)] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(errno));
        let (stderr, error_output) = io::capture(4096);
        fake.fds.borrow_mut().insert(2, stderr);
        let session = runtime_session(&executor, &runtime);
        let code = finish(&executor, &runtime, session.start(source).unwrap());
        let diagnostic = error_output.bytes();
        shutdown_session(&executor, &runtime, &fake, session);
        assert_eq!(code, if errno == 44 { 127 } else { 254 });
        assert!(
            diagnostic.is_empty(),
            "fallback reopened explicitly closed stderr: {source}"
        );
    }
}

#[test]
fn fork_failure_subshell_status_is_254_but_outer_reader_continues() {
    for source in [
        "( /startup-tool ); echo sub:$?; /ok; echo status:$?",
        "( /startup-tool | sleep ); echo sub:$?; /ok; echo status:$?",
        "( while /startup-tool; do :; done ); echo sub:$?; /ok; echo status:$?",
    ] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(48));
        let session = runtime_session(&executor, &runtime);
        assert_eq!(
            finish(&executor, &runtime, session.start(source).unwrap()),
            0,
            "{source}"
        );
        assert_eq!(fake.output.bytes(), b"sub:254\nstatus:0\n", "{source}");
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn subshell_pipeline_interrupt_preserves_foreground_group_and_stops_all_stages() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let source = "consume() { while IFS= read -r value; do :; done; }; ( sleep; true ) | consume";
    let foreground = session.start(source).unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 1);
    assert_eq!(
        runtime.0.groups.borrow().len(),
        1,
        "subshell must remain in the invoking foreground group"
    );
    session.interrupt();
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    for _ in 0..64 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    assert_eq!(runtime.retained_count(), 0);
    assert_eq!(fake.child_status(100), Some(130));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn successful_subshell_substitution_keeps_invocation_interrupt_owner() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let foreground = session
        .start("( : <(sleep) ); while true; do :; done")
        .unwrap();
    drive_until_spawn(&executor, &runtime, &fake, 1);
    for _ in 0..64 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    session.interrupt();
    assert_eq!(finish(&executor, &runtime, foreground), 130);
    for _ in 0..64 {
        executor.drive(64);
        runtime.poll(0).unwrap();
    }
    assert_eq!(runtime.retained_count(), 0);
    assert_eq!(fake.child_status(100), Some(130));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn aborted_subshell_leaves_descendants_to_enclosing_invocation_cleanup() {
    for interrupt in [false, true] {
        let (executor, fake, runtime) = setup();
        fake.outcomes
            .borrow_mut()
            .insert("/startup-tool".into(), WaitResult::StartFailed(48));
        let session = runtime_session(&executor, &runtime);
        let foreground = session
            .start("( inherit-sleep | /startup-tool ); echo sub:$?; /ok; parse-gate")
            .unwrap();
        drive_until_spawn(&executor, &runtime, &fake, 4);
        for _ in 0..64 {
            executor.drive(64);
            runtime.poll(0).unwrap();
        }
        assert_eq!(fake.output.bytes(), b"sub:254\n");
        // Known Bash difference: existing reader cancellation signals the direct
        // child with SIGINT; Bash would leave it running. Descendants stay alive
        // until enclosing invocation cleanup (see plan 004).
        assert_eq!(fake.child_status(100), Some(130));
        assert_eq!(
            fake.child_status(101),
            None,
            "local abort must not hunt descendants"
        );
        assert!(fake.signals.borrow().iter().all(|(group, _, _)| !group));
        assert_eq!(runtime.0.groups.borrow().len(), 1);
        if interrupt {
            session.interrupt();
        } else {
            // The inherited member exits on its own, then the outer script ends.
            fake.descendant_gates.borrow()[&101].cancel();
            fake.parse_gate.cancel();
        }
        let code = finish(&executor, &runtime, foreground);
        for _ in 0..64 {
            executor.drive(64);
            runtime.poll(0).unwrap();
        }
        let descendant_status = fake.child_status(101);
        let retained = runtime.retained_count();
        let groups = runtime.0.groups.borrow().len();
        shutdown_session(&executor, &runtime, &fake, session);
        assert_eq!(code, if interrupt { 130 } else { 0 });
        assert_eq!(descendant_status, Some(if interrupt { 130 } else { 23 }));
        assert_eq!(retained, 0, "orphaned member leaked a process slot");
        assert_eq!(groups, 0, "enclosing invocation did not reap its group");
        assert!(fake.fds.borrow().keys().all(|fd| *fd < 3));
    }
}

#[test]
fn access_requests_retire_success_errors_and_submission_failures_without_spawning() {
    let (_, fake, runtime) = setup();
    let unopened = runtime.access("unused".into(), "/captured".into());
    drop(unopened);
    assert!(fake.access_paths.borrow().is_empty());
    for (index, result) in [Ok(()), Err(2), Err(44), Err(54)].into_iter().enumerate() {
        let path = format!("./query-{index}");
        fake.access_results
            .borrow_mut()
            .insert(path.clone(), Some(result));
        assert_eq!(
            runtime
                .access(path.clone(), "/captured".into())
                .now_or_never(),
            Some(result.map_err(ProcessError::Runtime))
        );
        assert_eq!(fake.access_paths.borrow()[index].1, path);
        assert_eq!(fake.access_paths.borrow()[index].2, "/captured");
        assert!(fake.access_requests.borrow().is_empty());
        assert_eq!(runtime.0.support.waiter_count(), 0);
    }
    fake.access_start_error.set(Some(48));
    assert_eq!(
        runtime.access("failure".into(), "/".into()).now_or_never(),
        Some(Err(ProcessError::Runtime(48)))
    );
    assert!(fake.access_requests.borrow().is_empty());
    assert!(fake.access_cancelled.borrow().is_empty());
    assert!(fake.requests.borrow().is_empty());
}

#[test]
fn access_readiness_is_nonblocking_reactor_owned_and_cancel_removes_pending_or_ready_requests() {
    let (_, fake, runtime) = setup();
    fake.access_results
        .borrow_mut()
        .insert("pending".into(), None);
    let mut future = runtime.access("pending".into(), "/captured".into());
    assert!(future.as_mut().now_or_never().is_none());
    let id = fake.access_paths.borrow()[0].0;
    assert_eq!(runtime.0.support.waiter_count(), 1);
    assert!(
        fake.polls.borrow().is_empty(),
        "task must not call the reactor"
    );
    assert_eq!(runtime.poll(0), Ok(0));
    assert!(future.as_mut().now_or_never().is_none());
    fake.access_requests.borrow_mut().insert(id, Some(Err(2)));
    assert_eq!(runtime.poll(0), Ok(1));
    assert_eq!(
        future.as_mut().now_or_never(),
        Some(Err(ProcessError::Runtime(2)))
    );
    assert!(fake.access_requests.borrow().is_empty());
    assert_eq!(runtime.0.support.waiter_count(), 0);
    assert!(fake.access_cancelled.borrow().is_empty());
    for completed in [false, true] {
        let mut future = runtime.access("pending".into(), "/".into());
        assert!(future.as_mut().now_or_never().is_none());
        let id = fake.access_paths.borrow().last().unwrap().0;
        if completed {
            fake.access_requests.borrow_mut().insert(id, Some(Ok(())));
            assert_eq!(runtime.poll(0), Ok(1));
        }
        drop(future);
        assert_eq!(fake.access_cancelled.borrow().last(), Some(&id));
        assert!(fake.access_requests.borrow().is_empty());
        assert_eq!(runtime.0.support.waiter_count(), 0);
    }
    assert!(fake.requests.borrow().is_empty());
}

#[test]
fn access_host_bound_rejects_new_requests_and_releases_capacity_on_drop() {
    let (_, fake, runtime) = setup();
    fake.access_results
        .borrow_mut()
        .insert("pending".into(), None);
    let mut pending = Vec::new();
    for _ in 0..64 {
        let mut future = runtime.access("pending".into(), "/".into());
        assert!(future.as_mut().now_or_never().is_none());
        pending.push(future);
    }
    assert_eq!(
        runtime.access("pending".into(), "/".into()).now_or_never(),
        Some(Err(ProcessError::Runtime(AGAIN)))
    );
    assert_eq!(fake.access_requests.borrow().len(), 64);
    assert_eq!(runtime.0.support.waiter_count(), 64);
    drop(pending.pop());
    let mut replacement = runtime.access("pending".into(), "/".into());
    assert!(replacement.as_mut().now_or_never().is_none());
    drop(replacement);
    drop(pending);
    assert_eq!(fake.access_cancelled.borrow().len(), 65);
    assert!(fake.access_requests.borrow().is_empty());
    assert_eq!(runtime.0.support.waiter_count(), 0);
}

#[test]
fn stalled_path_query_keeps_background_and_peer_progress_and_interrupt_retires_request() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let peer = runtime_session(&executor, &runtime);
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session
                .start("{ parse-gate; echo background-progress; } &")
                .unwrap()
        ),
        0
    );
    drive_until_spawn(&executor, &runtime, &fake, 1);
    fake.access_results
        .borrow_mut()
        .insert("/home/guest/stalled".into(), None);
    let query = session.start("command -v stalled").unwrap();
    for _ in 0..1000 {
        executor.drive(64);
        if !fake.access_requests.borrow().is_empty() {
            break;
        }
        runtime.poll(0).unwrap();
    }
    assert_eq!(fake.access_requests.borrow().len(), 1);
    assert!(!query.is_finished());
    fake.parse_gate.cancel();
    assert_eq!(
        finish(
            &executor,
            &runtime,
            peer.start("echo peer-progress").unwrap()
        ),
        0
    );
    for _ in 0..100 {
        executor.drive(64);
        runtime.poll(0).unwrap();
        if String::from_utf8_lossy(&fake.output.bytes()).contains("background-progress") {
            break;
        }
    }
    let output = fake.output.bytes();
    assert!(String::from_utf8_lossy(&output).contains("background-progress"));
    assert!(String::from_utf8_lossy(&output).contains("peer-progress"));
    assert!(!query.is_finished());
    session.interrupt();
    assert_eq!(finish(&executor, &runtime, query), 130);
    assert!(fake.access_requests.borrow().is_empty());
    assert_eq!(fake.access_cancelled.borrow().len(), 1);
    assert!(
        fake.requests
            .borrow()
            .iter()
            .all(|request| !request.executable.ends_with("stalled"))
    );
    fake.access_results
        .borrow_mut()
        .remove("/home/guest/stalled");
    assert_eq!(
        finish(
            &executor,
            &runtime,
            session.start("command -v stalled").unwrap()
        ),
        0
    );
    finish(
        &executor,
        &runtime,
        executor.spawn(async move { session.shutdown().await }),
    );
    shutdown_session(&executor, &runtime, &fake, peer);
}

#[test]
fn descriptor_categories_are_not_preview1_filetypes() {
    for (wire, expected) in [
        (0, DescriptorKind::Other),
        (1, DescriptorKind::Pipe),
        (2, DescriptorKind::Terminal),
        (3, DescriptorKind::Regular),
        (4, DescriptorKind::Directory),
        (5, DescriptorKind::Other),
        (u32::MAX, DescriptorKind::Other),
    ] {
        assert_eq!(decode_descriptor_kind(wire), expected);
    }
}

#[test]
fn descriptor_queries_use_private_physical_handles_without_consuming_or_retaining_pipe_ends() {
    let (_executor, fake, runtime) = setup();
    let (read, write) = io::pipe();
    fake.fds.borrow_mut().insert(0, read);
    fake.fds.borrow_mut().insert(1, write);
    let mut table = runtime.stdio().unwrap();
    fake.close(0);
    fake.close(1);
    let read = table.remove(0).unwrap();
    let write = table.remove(1).unwrap();
    let next_fd = fake.next_fd.get();
    let closed = fake.closed.borrow().len();
    assert_eq!(read.descriptor_kind(), Ok(DescriptorKind::Pipe));
    assert_eq!(write.descriptor_kind(), Ok(DescriptorKind::Pipe));
    assert_eq!(fake.next_fd.get(), next_fd);
    assert_eq!(fake.closed.borrow().len(), closed);
    assert_eq!(write.write(b"payload").now_or_never(), Some(Ok(7)));
    assert_eq!(read.descriptor_kind(), Ok(DescriptorKind::Pipe));
    let mut payload = [0; 7];
    assert_eq!(read.read(&mut payload).now_or_never(), Some(Ok(7)));
    assert_eq!(&payload, b"payload");
    drop(write);
    assert_eq!(read.read(&mut payload).now_or_never(), Some(Ok(0)));
    let physical = read.runtime_fd().unwrap();
    fake.close(physical);
    assert_eq!(read.descriptor_kind(), Err(IoError::BadDescriptor));
    assert_eq!(fake.fd_kind(0), Err(8));
    drop(read);
    drop(table);
    assert_eq!(fake.fds.borrow().keys().copied().collect::<Vec<_>>(), [2]);
}

// This supplies classification only. Real terminal acceptance lives in the
// browser suite; querying a kind must never invoke these I/O methods.
struct KindOnly(DescriptorKind);
impl HostEndpoint for KindOnly {
    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        Ok(self.0)
    }
    fn read<'a>(&'a self, _output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        panic!("descriptor query read from the endpoint")
    }
    fn write<'a>(&'a self, _input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        panic!("descriptor query wrote to the endpoint")
    }
}

#[test]
fn descriptor_terminal_mock_preserves_numeric_range_and_remapped_bindings() {
    let (executor, fake, runtime) = setup();
    fake.fds.borrow_mut().insert(
        0,
        Endpoint::host(Rc::new(KindOnly(DescriptorKind::Terminal))),
    );
    let session = runtime_session(&executor, &runtime);
    fake.fds.borrow_mut().insert(0, Endpoint::null());
    let source = "test -t '-0'; echo $?; [ -t '+0' ]; echo $?; [[ -t ' 00 ' ]]; echo $?; [[ -t 4294967296 ]]; echo $?; test -t -4294967296; echo $?; [ -t -9223372036854775808 ]; echo $?; test -t 3 3<&0; echo $?; [[ -p /dev/stdin ]]; echo $?";
    assert_eq!(
        finish(&executor, &runtime, session.start(source).unwrap()),
        0
    );
    assert_eq!(fake.output.bytes(), b"0\n0\n0\n1\n1\n1\n0\n1\n");
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn runtime_permissions_keep_supported_denial_separate_from_unknown_bits() {
    let mut metadata = decode_filestat(&[0u8; 64]);
    let mut bytes = [0u8; 16];
    for (index, word) in [0o400u32, 0o600, 4, 6].into_iter().enumerate() {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
    }
    decode_permissions(&mut metadata, &bytes);
    assert_eq!(metadata.readable, Some(true));
    assert_eq!(metadata.writable, Some(false));
    assert_eq!(metadata.executable, None);
    let mode = metadata.mode.unwrap();
    assert_eq!(mode.test(0o400), Some(true));
    assert_eq!(mode.test(0o200), Some(false));
    assert_eq!(mode.test(0o1000), None);
    assert_eq!(mode.test(0o4000), None);
    bytes[..4].copy_from_slice(&0o7777u32.to_le_bytes());
    bytes[8..12].copy_from_slice(&7u32.to_le_bytes());
    decode_permissions(&mut metadata, &bytes);
    assert_eq!(metadata.mode.unwrap().test(0o2000), None);
    assert_eq!(metadata.executable, None);
    assert_eq!(metadata.uid, None);
    assert_eq!(metadata.owned_by_effective_uid, None);
}

mod inherited;
mod read_exact;

#[test]
fn handled_interrupt_preserves_child_status_after_cleanup() {
    for code in [0, 7] {
        handled_interrupt_result(&format!("handled-int {code}"), code, b"");
        handled_interrupt_result(&format!("handled-int {code}; echo AFTER"), 0, b"AFTER\n");
        handled_interrupt_result(&format!("{{ handled-int {code}; }}"), code, b"");
        handled_interrupt_result(
            &format!("while :; do :; done | handled-int {code}"),
            130,
            b"",
        );
    }
}

fn handled_interrupt_result(source: &str, expected: i32, expected_output: &[u8]) {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let command = session.start(source).unwrap();
    executor.drive(64);
    assert_eq!(fake.children.borrow().len(), 1);
    session.interrupt();
    let actual = finish(&executor, &runtime, command);
    let output = fake.output.bytes();
    shutdown_session(&executor, &runtime, &fake, session);
    assert_eq!(output, expected_output, "{source}");
    assert_eq!(actual, expected, "{source}");
}

#[test]
fn delivered_sigint_stops_a_default_child_loop() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let command = session.start("while :; do sleep; done").unwrap();
    executor.drive(64);
    session.interrupt();
    let actual = finish(&executor, &runtime, command);
    shutdown_session(&executor, &runtime, &fake, session);
    assert_eq!(actual, 130);
}

#[test]
fn terminal_child_delivery_is_non_closing_and_uses_its_runtime_job_only_when_owned() {
    for own_job in [false, true] {
        let (executor, fake, runtime) = setup();
        runtime.set_job_control(own_job);
        let group = runtime.allocate_group();
        let pid = runtime.spawn(request(&runtime, "sleep", group)).unwrap();
        executor.drive(64);
        let job = fake.children.borrow()[&(pid as u32)].job;
        runtime.signal_child(pid, 2).unwrap();
        runtime.signal_child(pid, 2).unwrap();
        let id = if own_job { job } else { pid as u32 };
        assert_eq!(*fake.signals.borrow(), vec![(own_job, id, 2); 2]);
        assert!(!runtime.0.groups.borrow()[&group].closing);
        let next = runtime.spawn(request(&runtime, "emit", group)).unwrap();
        let first = finish(&executor, &runtime, executor.spawn(runtime.wait(pid))).unwrap();
        assert_eq!(first, crate::process::ChildExit::Signaled(2));
        assert_eq!(
            finish(&executor, &runtime, executor.spawn(runtime.wait(next))).unwrap(),
            crate::process::ChildExit::Exited(0)
        );
        finish(
            &executor,
            &runtime,
            executor.spawn(runtime.wait_group(group)),
        )
        .unwrap();
        assert_eq!(runtime.retained_count(), 0);
    }
}

#[test]
fn delegated_waiting_interrupt_is_acknowledged_once_without_canceling_the_job() {
    let (executor, fake, runtime) = setup();
    runtime.set_job_control(true);
    let session = runtime_session(&executor, &runtime);
    let command = session.start("handled-int 7").unwrap();
    executor.drive(64);
    session.interrupt();
    assert!(session.take_delegated_interrupt());
    assert!(!session.take_delegated_interrupt());
    assert_eq!(fake.signals.borrow().len(), 1);
    assert!(fake.signals.borrow()[0].0);
    let code = finish(&executor, &runtime, command);
    shutdown_session(&executor, &runtime, &fake, session);
    assert_eq!(code, 7);
}

mod support_contract {
    use crate::{
        executor::{Cancel, Executor},
        io::{self, Endpoint, FdTable, IoError, MemoryFs, OpenOptions, PIPE_CAPACITY},
    };
    use futures::FutureExt;

    #[test]
    fn eof_requires_the_last_open_writer_description_to_close() {
        let executor = Executor::new();
        let (reader, writer) = io::pipe();
        let mut descriptors = FdTable::default();
        descriptors.insert(7, writer);
        let inherited = descriptors.clone();
        let read = executor.spawn(async move { reader.read(&mut [0]).await });
        assert_eq!(executor.drive(8).pending, 1);
        drop(descriptors.remove(7));
        assert_eq!(executor.drive(8).polls, 0);
        assert!(!read.is_finished());
        drop(inherited);
        assert_eq!(executor.drive(8).pending, 0);
        assert_eq!(read.now_or_never(), Some(Ok(0)));
    }

    #[test]
    fn full_pipe_parks_until_reader_drains_without_partial_atomic_records() {
        let executor = Executor::new();
        let (reader, writer) = io::pipe();
        assert_eq!(
            writer.write(&vec![b'x'; PIPE_CAPACITY - 1]).now_or_never(),
            Some(Ok(PIPE_CAPACITY - 1))
        );
        let write = executor.spawn(async move { writer.write(b"abc").await });
        assert_eq!(executor.drive(8).pending, 1);
        assert_eq!(executor.drive(8).polls, 0);
        assert_eq!(reader.read(&mut [0; 2]).now_or_never(), Some(Ok(2)));
        assert_eq!(executor.drive(8).pending, 0);
        assert_eq!(write.now_or_never(), Some(Ok(3)));
        let mut remaining = vec![0; PIPE_CAPACITY];
        assert_eq!(
            reader.read(&mut remaining).now_or_never(),
            Some(Ok(PIPE_CAPACITY))
        );
        assert_eq!(&remaining[PIPE_CAPACITY - 3..], b"abc");
    }

    #[test]
    fn closing_last_reader_wakes_a_blocked_writer_with_broken_pipe() {
        let executor = Executor::new();
        let (reader, writer) = io::pipe();
        assert_eq!(
            writer.write(&vec![0; PIPE_CAPACITY]).now_or_never(),
            Some(Ok(PIPE_CAPACITY))
        );
        let write = executor.spawn(async move { writer.write(b"x").await });
        executor.drive(8);
        let alias = reader.clone();
        drop(reader);
        assert_eq!(executor.drive(8).polls, 0);
        drop(alias);
        executor.drive(8);
        assert_eq!(write.now_or_never(), Some(Err(IoError::BrokenPipe)));
    }

    #[test]
    fn cancelling_parked_read_does_not_consume_later_bytes() {
        let executor = Executor::new();
        let (reader, writer) = io::pipe();
        let cancel = Cancel::new();
        let pending = reader.clone();
        let interrupted = cancel.clone();
        let read =
            executor.spawn(async move { pending.read_cancelled(&mut [0], &interrupted).await });
        executor.drive(8);
        cancel.cancel();
        executor.drive(8);
        assert_eq!(read.now_or_never(), Some(Err(IoError::Cancelled)));
        assert_eq!(writer.write(b"z").now_or_never(), Some(Ok(1)));
        let mut byte = [0];
        assert_eq!(reader.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"z");
    }

    #[test]
    fn child_abort_is_local_and_parent_cancel_wakes_descendants() {
        let executor = Executor::new();
        let parent = Cancel::new();
        let first = parent.child();
        let sibling = parent.child();
        first.cancel();
        assert!(!parent.is_cancelled());
        assert!(!sibling.is_cancelled());
        let read = executor.spawn(async move { sibling.cancelled().await });
        executor.drive(8);
        assert!(!read.is_finished());
        parent.cancel();
        executor.drive(8);
        assert!(read.is_finished());
    }

    #[test]
    fn weak_descriptor_observation_does_not_hold_a_pipe_open() {
        let (reader, writer) = io::pipe();
        let observer = writer.downgrade();
        assert!(observer.upgrade().is_some());
        drop(writer);
        assert!(observer.upgrade().is_none());
        assert_eq!(reader.read(&mut [0]).now_or_never(), Some(Ok(0)));
    }

    #[test]
    fn descriptor_clones_share_offsets_but_reopens_do_not() {
        let fs = MemoryFs::new(16);
        fs.write_file("/data", b"abc").unwrap();
        let source = fs.open("/data", &OpenOptions::default()).unwrap();
        let alias = source.clone();
        let reopened = fs.open("/data", &OpenOptions::default()).unwrap();
        let mut byte = [0];
        assert_eq!(source.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(alias.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"b");
        assert_eq!(reopened.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"a");
    }

    #[test]
    fn buffered_pump_source_shares_offset_without_holding_exported_descriptor() {
        let input = Endpoint::bytes(b"abc".to_vec());
        let source = input.buffered_source();
        assert_eq!(input.buffered_input_bytes(), Some(3));
        assert_eq!(input.read(&mut [0]).now_or_never(), Some(Ok(1)));
        let mut rest = [0; 2];
        assert_eq!(source.read(&mut rest).now_or_never(), Some(Ok(2)));
        assert_eq!(&rest, b"bc");
        assert!(source.runtime_fd().is_none());
        assert!(source.host_owner().is_none());
    }
}
