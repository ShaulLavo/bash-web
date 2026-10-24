//! Original live-storage and command-wide scan controls; no real subprocesses.
use super::*;
use crate::{
    io::{Capture, Endpoint, MemoryFs},
    process::{InProcessHost, ProcessId},
};
use futures::future::LocalBoxFuture;

struct HeldRequest {
    path: String,
    cwd: String,
    live: Rc<Cell<usize>>,
}
impl Drop for HeldRequest {
    fn drop(&mut self) {
        self.live
            .set(self.live.get() - self.path.len() - self.cwd.len());
    }
}
struct Host {
    inner: InProcessHost,
    stall: Cell<bool>,
    requests: Cell<usize>,
    spawns: Cell<usize>,
    live: Rc<Cell<usize>>,
}
impl ProcessHost for Host {
    fn allocate_group(&self) -> GroupId {
        self.inner.allocate_group()
    }
    fn allocate_background_group(&self) -> GroupId {
        self.inner.allocate_background_group()
    }
    fn access(
        &self,
        path: String,
        cwd: String,
    ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        self.requests.set(self.requests.get() + 1);
        if !self.stall.get() {
            return self.inner.access(path, cwd);
        }
        self.live.set(self.live.get() + path.len() + cwd.len());
        let held = HeldRequest {
            path,
            cwd,
            live: self.live.clone(),
        };
        async move {
            futures::future::pending::<()>().await;
            drop(held);
            Err(ProcessError::Runtime(44))
        }
        .boxed_local()
    }
    fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError> {
        self.spawns.set(self.spawns.get() + 1);
        self.inner.spawn(request)
    }
    fn wait_start(
        &self,
        pid: ProcessId,
    ) -> futures::future::LocalBoxFuture<'static, Result<(), ProcessError>> {
        self.inner.wait_start(pid)
    }
    fn wait(&self, pid: ProcessId) -> LocalBoxFuture<'static, Result<i32, ProcessError>> {
        self.inner.wait(pid)
    }
    fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
        self.inner.kill(pid, signal)
    }
    fn wait_direct_group(
        &self,
        group: GroupId,
    ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        self.inner.wait_direct_group(group)
    }
    fn detach_group(&self, group: GroupId) -> JoinHandle<Result<(), ProcessError>> {
        self.inner.detach_group(group)
    }
    fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError> {
        self.inner.kill_group(group, signal)
    }
    fn wait_group(&self, group: GroupId) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
        self.inner.wait_group(group)
    }
    fn abandon_group(&self, group: GroupId, signal: i32) {
        self.inner.abandon_group(group, signal)
    }
}
struct Rig {
    executor: Executor,
    session: Session,
    host: Rc<Host>,
    output: Capture,
}
fn finish<T: Clone>(executor: &Executor, job: JoinHandle<T>) -> T {
    for _ in 0..100_000 {
        if job.is_finished() {
            return job.now_or_never().unwrap();
        }
        let turn = executor.drive(64);
        assert!(
            turn.runnable || job.is_finished(),
            "unexpected parked lookup"
        );
    }
    panic!("lookup exceeded bounded turns");
}
impl Rig {
    fn new(limits: Limits) -> Self {
        let executor = Executor::new();
        let host = Rc::new(Host {
            inner: InProcessHost::new(executor.clone()),
            stall: Cell::new(false),
            requests: Cell::new(0),
            spawns: Cell::new(0),
            live: Rc::new(Cell::new(0)),
        });
        host.inner
            .register("/home/guest/a/probe", |_, _| async { 7 }.boxed_local());
        let session = Session::new(
            executor.clone(),
            host.clone(),
            Rc::new(MemoryFs::new(4096)),
            limits,
        );
        let (out, output) = io::capture(4096);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, out);
        fds.insert(2, Endpoint::null());
        session.set_descriptors(fds).unwrap();
        Self {
            executor,
            session,
            host,
            output,
        }
    }
    fn run(&self, source: &str) -> i32 {
        finish(&self.executor, self.session.start(source).unwrap())
    }
    fn dispatch_wrappers(
        &self,
        argv: Vec<String>,
        steps: usize,
        cancel: Cancel,
        line: Option<usize>,
    ) -> JoinHandle<Result<Outcome, i32>> {
        let core = self.session.core.clone();
        let group = self.host.allocate_group();
        let signal = Rc::new(Cell::new(None));
        let context = Context {
            evaluation: crate::exec::Scope::new(
                core.limits.source_bytes,
                core.eval_storage.clone(),
                core.execution_storage.clone(),
            ),
            source: crate::exec::Source::root(""),
            reader: crate::exec::ReaderLocation::default(),
            scope: Scope::new(0),
            group,
            invocation_group: group,
            signal: signal.clone(),
            lifetime: (cancel.clone(), signal),
            cancel,
            parameter_error_status: 127,
            loop_depth: 0,
            ignore_errexit: false,
            compound_child: false,
            core,
        };
        let execution = PreparedExecution {
            line,
            assigned: Vec::new(),
            fds: Some(self.session.core.descriptors.clone()),
            work: expand::Work::new(steps, 0, 0),
        };
        let state = self.session.state.clone();
        self.executor.spawn(async move {
            let argv = Cell::new(argv);
            let builtin_prefix = Cell::new(None);
            let mut execution = Ok(execution);
            dispatch_simple_command(
                &argv,
                &mut None,
                &builtin_prefix,
                &mut execution,
                &state,
                &context,
                WeakStderr::Closed,
            )
            .await
        })
    }
    fn path(&self, value: &str) {
        self.session
            .state
            .borrow_mut()
            .assign_parameter("PATH".into(), value.into())
            .unwrap();
    }
    fn settle_or_cancel(&self, job: JoinHandle<i32>) -> i32 {
        for _ in 0..100_000 {
            if job.is_finished() || self.host.live.get() != 0 {
                break;
            }
            self.executor.drive(64);
        }
        if !job.is_finished() {
            self.session.interrupt();
        }
        finish(&self.executor, job)
    }
    fn shutdown(self) {
        let storage = self.session.core.execution_storage.clone();
        let session = self.session;
        finish(
            &self.executor,
            self.executor.spawn(async move { session.shutdown().await }),
        );
        assert_eq!(self.host.live.get(), 0);
        assert_eq!(self.host.inner.retained_count(), 0);
        assert_eq!(self.executor.drive(64).pending, 0);
        assert_eq!(storage.observation().0, 0);
    }
}

#[test]
fn lookup_live_storage_refunds_each_failed_candidate() {
    for source in ["probe", "command -v probe", "type -p probe"] {
        let rig = Rig::new(Limits {
            path_bytes: 70,
            ..Limits::default()
        });
        rig.path("missing:a");
        let status = rig.run(source);
        let requests = rig.host.requests.get();
        let output = rig.output.bytes();
        rig.shutdown();
        assert_eq!(status, if source == "probe" { 7 } else { 0 });
        assert_eq!(requests, 2);
        if source != "probe" {
            assert_eq!(output, b"a/probe\n");
        }
    }
}

#[test]
fn lookup_live_storage_has_exact_peak_boundaries_and_recovers_after_rejection() {
    // cwd/PATH=20, missing/probe=13; the metadata absolute path=25
    // is one byte larger than the completed access request's 24 bytes.
    for (limit, expected) in [(58, 7), (57, 2)] {
        let rig = Rig::new(Limits {
            path_bytes: limit,
            ..Limits::default()
        });
        rig.path("missing:a");
        assert_eq!(rig.run("probe"), expected, "path_bytes={limit}");
        rig.path("a");
        assert_eq!(rig.run("probe"), 7);
        rig.shutdown();
    }
}

#[test]
fn lookup_keeps_a_nonexecutable_fallback_charged_while_searching() {
    // Snapshot=22, retained ./probe=7, next candidate=13, metadata=25.
    for (limit, expected) in [(67, 7), (66, 2)] {
        let rig = Rig::new(Limits {
            path_bytes: limit,
            ..Limits::default()
        });
        assert_eq!(rig.run("printf data > probe"), 0);
        rig.path(".:missing:a");
        assert_eq!(rig.run("probe"), expected, "path_bytes={limit}");
        rig.path("a");
        assert_eq!(rig.run("probe"), 7);
        rig.shutdown();
    }
}

#[test]
fn lookup_small_paths_reserve_actual_bytes_not_the_whole_policy_ceiling() {
    let rig = Rig::new(Limits {
        execution_bytes: 64 * 1024,
        path_bytes: 1024 * 1024,
        ..Limits::default()
    });
    rig.path("a");
    assert_eq!(rig.run("probe"), 7);
    assert_eq!(rig.run("command -V probe"), 0);
    assert_eq!(rig.output.bytes(), b"probe is /home/guest/a/probe\n");
    rig.shutdown();
}

#[test]
fn lookup_global_admission_rejects_before_copying_large_path_requests() {
    for source in ["probe", "command -v probe", "type -p probe"] {
        let rig = Rig::new(Limits {
            execution_bytes: 192 * 1024,
            ..Limits::default()
        });
        assert_eq!(rig.run(&format!("PATH={}", "p".repeat(96 * 1024))), 0);
        rig.host.stall.set(true);
        let status = rig.settle_or_cancel(rig.session.start(source).unwrap());
        let requests = rig.host.requests.get();
        rig.shutdown();
        assert_eq!(
            status, 2,
            "{source} must reject, not park until interrupted"
        );
        assert_eq!(requests, 0);
    }
    let rig = Rig::new(Limits {
        execution_bytes: 32 * 1024,
        ..Limits::default()
    });
    rig.path(&"p".repeat(256 * 1024));
    rig.host.stall.set(true);
    let status = rig.settle_or_cancel(rig.session.start("probe").unwrap());
    let requests = rig.host.requests.get();
    rig.shutdown();
    assert_eq!(status, 2);
    assert_eq!(requests, 0);
}

#[test]
fn lookup_pending_request_keeps_shared_tickets_and_cancel_refunds_them() {
    for source in ["command -v probe", "type -p probe", "type -aP probe"] {
        pending_lookup_refunds(source);
    }
}
fn pending_lookup_refunds(source: &str) {
    let rig = Rig::new(Limits {
        execution_bytes: 1024 * 1024,
        ..Limits::default()
    });
    assert_eq!(rig.run(&format!("PATH={}", "p".repeat(96 * 1024))), 0);
    let before = rig.session.core.execution_storage.observation().0;
    rig.host.stall.set(true);
    let job = rig.session.start(source).unwrap();
    for _ in 0..100_000 {
        if rig.host.live.get() != 0 || job.is_finished() {
            break;
        }
        rig.executor.drive(64);
    }
    assert!(!job.is_finished());
    assert!(rig.host.live.get() > 96 * 1024);
    let charged = rig.session.core.execution_storage.observation().0 - before;
    let peer = Rc::new(Cell::new(false));
    let observed = peer.clone();
    rig.executor.spawn(async move {
        observed.set(true);
    });
    rig.executor.drive(64);
    assert!(peer.get());
    rig.session.interrupt();
    assert_eq!(finish(&rig.executor, job), 130);
    assert_eq!(rig.host.live.get(), 0);
    assert_eq!(rig.session.core.execution_storage.observation().0, before);
    rig.host.stall.set(false);
    assert_eq!(rig.run("PATH=a; probe"), 7);
    rig.shutdown();
    assert!(
        charged >= 3 * 96 * 1024,
        "resolver-owned bytes must stay globally admitted while access is pending, charged={charged}"
    );
}

#[test]
fn lookup_scan_fuel_is_shared_by_all_query_operands_but_not_later_commands() {
    for query in ["command -v", "type -p", "type -aP"] {
        query_scan_fuel(query);
    }
}
fn query_scan_fuel(query: &str) {
    let rig = Rig::new(Limits {
        source_bytes: 256,
        expansion_bytes: 4096,
        arguments: 64,
        path_bytes: 4096,
        ..Limits::default()
    });
    rig.path(&std::iter::repeat_n("x", 100).collect::<Vec<_>>().join(":"));
    assert_eq!(rig.run(&format!("{query} q0")), 1);
    assert_eq!(rig.host.requests.replace(0), 100);
    let status = rig.run(&format!("{query}{}", " q0".repeat(32)));
    let requests = rig.host.requests.replace(0);
    assert_eq!(rig.run(&format!("{query} q0")), 1);
    assert_eq!(rig.host.requests.get(), 100);
    rig.shutdown();
    assert_eq!(status, 2);
    assert!(
        requests < 3200,
        "all operands must share one scan allowance"
    );
}

#[test]
fn builtin_wrapper_rejected_targets_never_access_or_spawn_registered_externals() {
    let rig = Rig::new(Limits::default());
    rig.path("/home/guest/a");
    for source in [
        "builtin probe",
        "command builtin probe",
        "builtin /home/guest/a/probe",
        "builtin if",
        "builtin absent",
    ] {
        assert_eq!(rig.run(source), 1, "{source}");
    }
    assert_eq!(rig.host.requests.get(), 0);
    assert_eq!(rig.host.spawns.get(), 0);
    assert_eq!(rig.host.inner.active_count(), 0);
    assert_eq!(rig.host.inner.retained_count(), 0);
    rig.shutdown();
}

#[test]
fn builtin_wrapper_selection_spends_shared_work_without_recharging_argv() {
    let rig = Rig::new(Limits::default());
    let words = || vec!["builtin".into(), "command".into(), "true".into()];
    for steps in [0, 1] {
        let job = rig.dispatch_wrappers(words(), steps, Cancel::new(), Some(9));
        assert_eq!(finish(&rig.executor, job).unwrap_err(), 2);
    }
    let job = rig.dispatch_wrappers(words(), 2, Cancel::new(), Some(9));
    assert_eq!(finish(&rig.executor, job).unwrap().code, 0);
    assert_eq!(rig.host.requests.get(), 0);
    assert_eq!(rig.host.spawns.get(), 0);
    rig.shutdown();
}

#[test]
fn builtin_wrapper_selection_yields_and_cancels_without_host_requests() {
    let rig = Rig::new(Limits::default());
    let before = rig.session.core.execution_storage.observation().0;
    let mut words = vec!["builtin".to_owned(); 8192];
    words.push("true".into());
    let cancel = Cancel::new();
    let job = rig.dispatch_wrappers(words, 8192, cancel.clone(), Some(9));
    rig.executor.drive(1);
    assert!(!job.is_finished(), "wrapper traversal must yield");
    let peer = rig.executor.spawn(async { 7 });
    rig.executor.drive(4);
    assert!(peer.is_finished());
    assert!(!job.is_finished());
    cancel.cancel();
    assert_eq!(finish(&rig.executor, job).unwrap_err(), 130);
    assert_eq!(rig.host.requests.get(), 0);
    assert_eq!(rig.host.spawns.get(), 0);
    assert_eq!(rig.session.core.execution_storage.observation().0, before);
    rig.shutdown();
}

#[test]
fn builtin_wrapper_blocked_diagnostic_cancellation_releases_all_frames() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = io::pipe();
    let mut fds = rig.session.core.descriptors.borrow().clone();
    fds.insert(2, writer);
    rig.session.set_descriptors(fds).unwrap();
    let source = format!("a=temporary builtin {}", "n".repeat(96 * 1024));
    let job = rig.session.start(&source).unwrap();
    for _ in 0..1000 {
        rig.executor.drive(64);
    }
    assert!(
        !job.is_finished(),
        "the bounded stderr pipe must backpressure"
    );
    rig.session.interrupt();
    assert_eq!(finish(&rig.executor, job), 130);
    assert!(!rig.session.state.borrow().bindings().contains_key("a"));
    assert_eq!(rig.host.requests.get(), 0);
    assert_eq!(rig.host.spawns.get(), 0);
    drop(reader);
    rig.shutdown();
}

#[test]
fn builtin_wrapper_usage_diagnostic_cancellation_and_broken_pipe() {
    let rig = Rig::new(Limits::default());
    let before = rig.session.core.execution_storage.observation().0;
    let (reader, writer) = io::pipe();
    assert_eq!(
        writer.write(&vec![0; io::PIPE_CAPACITY]).now_or_never(),
        Some(Ok(io::PIPE_CAPACITY))
    );
    let mut fds = rig.session.core.descriptors.borrow().clone();
    fds.insert(2, writer);
    rig.session.set_descriptors(fds).unwrap();
    let job = rig.session.start("a=temporary builtin -z").unwrap();
    rig.executor.drive(1024);
    assert!(!job.is_finished());
    rig.session.interrupt();
    assert_eq!(finish(&rig.executor, job), 130);
    assert_eq!(rig.session.core.execution_storage.observation().0, before);
    assert!(!rig.session.state.borrow().bindings().contains_key("a"));
    drop(reader);
    assert_eq!(rig.run("builtin -z"), 141);
    assert_eq!(rig.host.requests.get(), 0);
    assert_eq!(rig.host.spawns.get(), 0);
    rig.shutdown();
}

#[test]
fn builtin_wrapper_unknown_line_omits_numeric_label() {
    for (args, status, expected) in [
        (
            vec!["builtin".into(), "missing".into()],
            1,
            "/usr/bin/bash: builtin: missing: not a shell builtin\n",
        ),
        (
            vec!["builtin".into(), "-z".into()],
            2,
            "/usr/bin/bash: builtin: -z: invalid option\nbuiltin: usage: builtin [shell-builtin [arg ...]]\n",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        let mut fds = rig.session.core.descriptors.borrow().clone();
        fds.insert(2, fds.get(1).unwrap().clone());
        rig.session.set_descriptors(fds).unwrap();
        let job = rig.dispatch_wrappers(args, 1, Cancel::new(), None);
        assert_eq!(
            finish(&rig.executor, job)
                .map(|outcome| outcome.code)
                .unwrap_or_else(|code| code),
            status
        );
        assert_eq!(rig.output.bytes(), expected.as_bytes());
        assert_eq!(rig.host.requests.get(), 0);
        assert_eq!(rig.host.spawns.get(), 0);
        rig.shutdown();
    }
}
