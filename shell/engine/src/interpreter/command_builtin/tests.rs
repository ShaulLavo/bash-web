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
        self.inner.spawn(request)
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
    fn path(&self, value: &str) {
        self.session
            .state
            .borrow_mut()
            .variables
            .insert("PATH".into(), value.into());
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
    for source in ["probe", "command -v probe"] {
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
    for source in ["probe", "command -v probe"] {
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
    let rig = Rig::new(Limits {
        execution_bytes: 1024 * 1024,
        ..Limits::default()
    });
    assert_eq!(rig.run(&format!("PATH={}", "p".repeat(96 * 1024))), 0);
    let before = rig.session.core.execution_storage.observation().0;
    rig.host.stall.set(true);
    let job = rig.session.start("command -v probe").unwrap();
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
    let rig = Rig::new(Limits {
        source_bytes: 256,
        expansion_bytes: 4096,
        arguments: 64,
        path_bytes: 4096,
        ..Limits::default()
    });
    rig.path(&std::iter::repeat_n("x", 100).collect::<Vec<_>>().join(":"));
    assert_eq!(rig.run("command -v q0"), 1);
    assert_eq!(rig.host.requests.replace(0), 100);
    let status = rig.run(&format!("command -v{}", " q0".repeat(32)));
    let requests = rig.host.requests.replace(0);
    assert_eq!(rig.run("command -v q0"), 1);
    assert_eq!(rig.host.requests.get(), 100);
    rig.shutdown();
    assert_eq!(status, 2);
    assert!(
        requests < 3200,
        "all operands must share one scan allowance"
    );
}
