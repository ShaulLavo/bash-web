//! Original indexed-local getopts publication admission regressions.
use super::*;
use crate::{
    Limits, Session,
    exec::StorageBudget,
    executor::{Executor, JoinHandle},
    io::MemoryFs,
    process::InProcessHost,
};
use futures::FutureExt;

const CAPACITY: usize = 65_536;
const SCAN: &str = "getopts abcxyz o -abc -xyz";

#[test]
fn getopts_indexed_local_preflight_covers_publication() {
    let memory = StorageBudget::new(CAPACITY);
    let state = State::with_memory(memory.clone()).shared();
    let frame = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    for name in ["OPTIND", "OPTARG", "o"] {
        let mut state = state.borrow_mut();
        state.local(name.into(), "1".into()).unwrap();
        let old = state.variables.remove(name);
        let update = BindingUpdate::Element {
            index: 0,
            value: "1".into(),
        };
        let (binding, _) = update.apply_with_undo(old);
        state
            .reserve_local_value(name, binding.storage_bytes())
            .unwrap();
        state.variables.insert(name.into(), binding);
    }
    let reservation = state
        .borrow()
        .reserve_getopts_publication(&[("OPTIND", 1), ("OPTARG", 1), ("o", 1)])
        .unwrap();
    let hold = memory.admit(CAPACITY - memory.observation().0).unwrap();
    drop(reservation);
    assert_eq!(state.borrow_mut().publish_getopts_index("1".into()), Ok(()));
    assert_eq!(
        state
            .borrow_mut()
            .assign_parameter("OPTARG".into(), "x".into()),
        Ok(())
    );
    assert_eq!(
        state.borrow_mut().assign_parameter("o".into(), "b".into()),
        Ok(())
    );
    drop(hold);
    drop(frame);
    assert_eq!(memory.observation().0, 0);
}

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
        let session = Session::new(
            executor.clone(),
            Rc::new(host),
            Rc::new(MemoryFs::new(65_536)),
            Limits {
                execution_bytes: CAPACITY,
                ..Limits::default()
            },
        );
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
        assert!(matches!(state.variables["OPTIND"], Binding::Indexed(_)));
        let memory = state.memory.clone().unwrap();
        let used = memory.observation().0;
        Self {
            executor,
            session,
            frame,
            memory,
            used,
            bindings: state.variables.clone(),
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
            state.variables, self.bindings,
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
    assert_eq!(trial.memory.observation().0, 0);
}

#[test]
fn getopts_indexed_local_preflight_covers_repeated_alias_publication() {
    let memory = StorageBudget::new(CAPACITY);
    let state = State::with_memory(memory.clone()).shared();
    let frame = FunctionFrame::enter(state.clone(), Vec::new(), usize::MAX).unwrap();
    {
        let mut state = state.borrow_mut();
        state.local("OPTIND".into(), "1".into()).unwrap();
        let update = BindingUpdate::Element {
            index: 5,
            value: "saved".into(),
        };
        let (binding, _) = update.apply_with_undo(None);
        state
            .reserve_local_value("OPTIND", binding.storage_bytes())
            .unwrap();
        state.variables.insert("OPTIND".into(), binding);
        state
            .declare_nameref("ref".into(), "OPTIND".into(), false)
            .unwrap();
    }
    let reservation = state
        .borrow()
        .reserve_getopts_publication(&[("OPTIND", 1), ("", 0), ("ref", 1)])
        .unwrap();
    let hold = memory.admit(CAPACITY - memory.observation().0).unwrap();
    drop(reservation);
    assert_eq!(state.borrow_mut().publish_getopts_index("1".into()), Ok(()));
    assert_eq!(
        state
            .borrow_mut()
            .assign_parameter("ref".into(), "b".into()),
        Ok(())
    );
    assert_eq!(state.borrow().variables["OPTIND"].element(5), Some("saved"));
    drop(hold);
    drop(frame);
    assert_eq!(memory.observation().0, 0);
}
