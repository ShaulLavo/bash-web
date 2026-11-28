//! Near-budget pushd/popd through a real session. The stack's prepared version
//! is admitted before cd, so a refusal changes neither cwd nor the stack, and a
//! failed cd refunds the prepared version.
use crate::{
    Limits, Session,
    exec::Work,
    executor::{Cancel, Executor},
    io::{Capture, Endpoint, FdTable, MemoryFs, capture},
    process::InProcessHost,
    state::State,
};
use futures::FutureExt;
use std::rc::Rc;

/// The held-back headroom; the stack's large entry is 2^18 bytes.
const HEADROOM: usize = 100_000;

struct Rig {
    executor: Executor,
    session: Session,
    output: Capture,
}

impl Rig {
    fn new() -> Self {
        let executor = Executor::new();
        let host = InProcessHost::new(executor.clone());
        // /dev/null is an ordinary file here; leave room for large listings.
        let fs = MemoryFs::new(8 * 1024 * 1024);
        for directory in ["/dev", "/tmp/a", "/tmp/b"] {
            fs.mkdir(directory, true).unwrap();
        }
        let (stdout, output) = capture(65536);
        let mut fds = FdTable::default();
        for (fd, endpoint) in [(0, Endpoint::null()), (1, stdout), (2, Endpoint::null())] {
            fds.insert(fd, endpoint);
        }
        let session = Session::new(
            executor.clone(),
            Rc::new(host),
            Rc::new(fs),
            Limits::default(),
        );
        session.set_descriptors(fds).unwrap();
        Self {
            executor,
            session,
            output,
        }
    }
    fn run(&self, code: &str) -> i32 {
        let job = self.session.start(code).unwrap();
        for _ in 0..100_000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            self.executor.drive(64);
        }
        panic!("{code} exceeded the turn limit");
    }
    /// The largest temporary admission the shared State budget still allows.
    fn remaining(&self) -> usize {
        let state = self.session.state();
        let (mut low, mut high) = (0, Limits::default().execution_bytes);
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            let admitted = state.borrow().admit_temporary(middle).is_ok();
            if admitted {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        low
    }
    /// Runs `code` with only HEADROOM bytes left; returns its status and the
    /// budget left afterwards, once the hold is released.
    fn squeezed(&self, code: &str) -> (i32, usize) {
        let hold = self
            .session
            .state()
            .borrow()
            .admit_temporary(self.remaining() - HEADROOM)
            .unwrap();
        let status = self.run(code);
        drop(hold);
        (status, self.remaining())
    }
    fn observe(&self) -> String {
        let before = self.output.bytes().len();
        self.run("pwd; dirs -l +1; x=$(dirs -l +2); echo ${#x}; dirs +3 2>/dev/null; echo $?");
        String::from_utf8_lossy(&self.output.bytes()[before..]).into_owned()
    }
}

/// Stack (bottom first): a large literal entry, then `/`; cwd `/tmp/a`.
fn loaded() -> Rig {
    let rig = Rig::new();
    let setup = "cd /; big=x; for i in {1..18}; do big=$big$big; done; \
                 pushd -n \"/$big\" >/dev/null; pushd /tmp/a >/dev/null";
    assert_eq!(rig.run(setup), 0);
    assert_eq!(rig.observe(), "/tmp/a\n/\n262145\n1\n");
    rig.run(":");
    rig
}

#[test]
fn refused_popd_changes_neither_cwd_nor_stack() {
    let rig = loaded();
    let before = rig.remaining();
    let (status, after) = rig.squeezed("popd");
    assert_eq!(status, 2);
    assert_eq!(after, before);
    assert_eq!(rig.observe(), "/tmp/a\n/\n262145\n1\n");
}

#[test]
fn refused_pushd_changes_neither_cwd_nor_stack() {
    let rig = loaded();
    let before = rig.remaining();
    let (status, after) = rig.squeezed("pushd /tmp/b");
    assert_eq!(status, 2);
    assert_eq!(after, before);
    assert_eq!(rig.observe(), "/tmp/a\n/\n262145\n1\n");
}

#[test]
fn refused_directory_bindings_keep_cwd_stack_and_budget() {
    for (setup, command) in [
        ("", "pushd /tmp/b"),
        ("", "cd /tmp/b"),
        ("pushd -n /tmp/b >/dev/null;", "pushd"),
        ("pushd -n /tmp/b >/dev/null;", "pushd +1"),
        ("pushd -n /tmp/b >/dev/null;", "popd"),
    ] {
        let rig = Rig::new();
        assert_eq!(rig.run(&format!("cd /tmp/a; {setup} OLDPWD=kept; :")), 0);
        let state = rig.session.state();
        state
            .borrow_mut()
            .assign_parameter("large".into(), "x".repeat(256 * 1024))
            .unwrap();
        let stack = state.borrow().directories().to_vec();
        let mut work = Work::new(65536, 1024 * 1024, 0);
        let cancel = Cancel::new();
        let snapshot = State::snapshot(&state, &cancel, &mut work)
            .now_or_never()
            .expect("short snapshot does not yield")
            .unwrap_or_else(|_| panic!("snapshot fits"));
        let expected = rig.remaining();
        let (status, after) = rig.squeezed(command);
        assert_eq!(status, 2, "{command}");
        assert_eq!(state.borrow().cwd, "/tmp/a", "{command}");
        assert_eq!(state.borrow().directories(), stack, "{command}");
        assert_eq!(state.borrow().bindings()["PWD"].as_str(), "/tmp/a");
        assert_eq!(state.borrow().parameter("OLDPWD"), "kept");
        assert_eq!(after, expected, "{command}");
        drop(snapshot);
    }
}

#[test]
fn cyclic_oldpwd_keeps_prepared_swap_and_rotation_on_status_one() {
    for (command, stack) in [
        ("pushd", ["/tmp/b", "/tmp/a"]),
        ("pushd +2", ["/", "/tmp/a"]),
        ("pushd -0", ["/", "/tmp/a"]),
    ] {
        let rig = Rig::new();
        assert_eq!(
            rig.run(
                "cd /tmp/a; pushd -n /tmp/b >/dev/null; pushd -n / >/dev/null; \
                     declare -n a=OLDPWD; declare -n OLDPWD=a"
            ),
            0
        );
        assert_eq!(rig.run(command), 1, "{command}");
        let state = rig.session.state();
        let state = state.borrow();
        assert_eq!(state.cwd, "/tmp/a", "{command}");
        assert_eq!(state.parameter("PWD"), "/tmp/a", "{command}");
        assert_eq!(state.directories(), stack, "{command}");
    }
}

#[test]
fn readonly_directory_binding_still_changes_directory_and_writes_the_other_binding() {
    for (readonly, pwd, oldpwd) in [("PWD", "/tmp/a", "/tmp/a"), ("OLDPWD", "/tmp/b", "kept")] {
        let rig = Rig::new();
        assert_eq!(
            rig.run(&format!("cd /tmp/a; OLDPWD=kept; readonly {readonly}")),
            0
        );
        assert_eq!(rig.run("pushd /tmp/b"), 1);
        let state = rig.session.state();
        let state = state.borrow();
        assert_eq!(state.cwd, "/tmp/b");
        assert!(state.directories().is_empty());
        assert_eq!(state.bindings()["PWD"].as_str(), pwd);
        assert_eq!(state.parameter("OLDPWD"), oldpwd);
    }
}

#[test]
fn failed_cd_refunds_the_prepared_versions() {
    let rig = loaded();
    let before = rig.remaining();
    assert_eq!(rig.run("pushd /missing"), 1);
    assert_eq!(rig.remaining(), before);
    assert_eq!(rig.run("pushd -n /missing >/dev/null"), 0);
    let pushed = rig.remaining();
    assert_eq!(rig.run("popd"), 1);
    assert_eq!(rig.remaining(), pushed);
    assert_eq!(rig.run("popd -n >/dev/null"), 0);
    assert_eq!(rig.remaining(), before);
    assert_eq!(rig.observe(), "/tmp/a\n/\n262145\n1\n");
}
