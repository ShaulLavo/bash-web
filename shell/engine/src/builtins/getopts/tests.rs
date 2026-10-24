//! Original Session regression for indexed-local getopts publication rejection.
use crate::{
    Limits, Session,
    exec::StorageBudget,
    executor::{Executor, JoinHandle},
    io::MemoryFs,
    process::InProcessHost,
    state::{Binding, FunctionFrame, State},
};
use futures::FutureExt;
use std::{collections::BTreeMap, rc::Rc};

const CAPACITY: usize = 65_536;
const SCAN: &str = "getopts abcxyz o -abc -xyz";

struct ScanTrial {
    executor: Executor,
    session: Session,
    frame: FunctionFrame,
    memory: StorageBudget,
    bindings: BTreeMap<String, Binding>,
    cursor: (usize, usize, usize),
    used: usize,
}
impl ScanTrial {
    fn new() -> Self {
        let executor = Executor::new();
        let host = InProcessHost::new(executor.clone());
        let fs = MemoryFs::new(CAPACITY);
        let limits = Limits {
            execution_bytes: CAPACITY,
            ..Limits::default()
        };
        let session = Session::new(executor.clone(), Rc::new(host), Rc::new(fs), limits);
        let state = session.state();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
        state
            .borrow_mut()
            .local("OPTIND".into(), "1".into())
            .unwrap();
        let job = session
            .start("getopts abc o -abc -xyz; OPTIND[0]=2; OPTARG=old")
            .unwrap();
        assert_eq!(finish(&executor, job), 0);
        let state = state.borrow();
        assert_eq!(state.parameter("o"), "a");
        assert!(matches!(
            state.raw_bindings()["OPTIND"],
            Binding::Indexed(_)
        ));
        let memory = state.getopts_publication_budget().unwrap();
        let used = memory.observation().0;
        Self {
            executor,
            session,
            frame,
            memory,
            used,
            bindings: state.raw_bindings().clone(),
            cursor: cursor(&state),
        }
    }
    fn run(&self) -> i32 {
        finish(&self.executor, self.session.start(SCAN).unwrap())
    }
    fn pressured(&self, headroom: usize) -> i32 {
        let hold = self.memory.admit(CAPACITY - self.used - headroom).unwrap();
        let status = self
            .session
            .start(SCAN)
            .map_or(2, |job| finish(&self.executor, job));
        drop(hold);
        status
    }
    fn check_rejected(&self) {
        let state = self.session.state();
        let state = state.borrow();
        assert_eq!(
            cursor(&state),
            self.cursor,
            "rejected getopts must not consume b"
        );
        assert_eq!(
            state.raw_bindings(),
            &self.bindings,
            "rejected getopts must not publish bindings"
        );
        assert_eq!(
            self.memory.observation().0,
            self.used,
            "rejection refunds staged storage"
        );
    }
}

fn cursor(state: &State) -> (usize, usize, usize) {
    (
        state.getopts.index,
        state.getopts.offset,
        state.getopts.argument,
    )
}

fn finish(executor: &Executor, job: JoinHandle<i32>) -> i32 {
    for _ in 0..10_000 {
        if job.is_finished() {
            return job.now_or_never().unwrap();
        }
        let turn = executor.drive(64);
        assert!(
            turn.runnable || job.is_finished(),
            "unexpected parked getopts"
        );
    }
    panic!("getopts exceeded bounded executor turns");
}

#[test]
fn getopts_indexed_local_rejected_publication_preserves_cluster() {
    let mut low = 0;
    let mut high = CAPACITY / 2;
    assert_eq!(ScanTrial::new().pressured(high), 0);
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        if ScanTrial::new().pressured(middle) == 0 {
            high = middle;
        } else {
            low = middle;
        }
    }
    let trial = ScanTrial::new();
    assert_eq!(trial.pressured(low), 2);
    eprintln!("rejected publication headroom={low}, first success={high}");
    trial.check_rejected();
    assert_eq!(trial.run(), 0);
    assert_eq!(trial.session.state().borrow().parameter("o"), "b");
    drop(trial.frame);
    assert_eq!(
        trial.memory.observation().0,
        trial.session.state().borrow().prefix_capacity_bytes()
    );
    drop(trial.session);
    assert_eq!(trial.memory.observation().0, 0);
}
