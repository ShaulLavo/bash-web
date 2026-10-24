//! Near-budget pushd/popd through a real session. The stack's prepared version
//! is admitted before cd, so a refusal changes neither cwd nor the stack, and a
//! failed cd refunds the prepared version.
use crate::{
    Limits, Session,
    executor::Executor,
    io::{Capture, Endpoint, FdTable, MemoryFs, capture},
    process::InProcessHost,
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
        for directory in ["/tmp/a", "/tmp/b"] {
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
