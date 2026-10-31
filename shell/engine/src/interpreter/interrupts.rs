use crate::process::{ProcessHost, ProcessId};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

#[derive(Default)]
pub(crate) struct Interrupts {
    strands: RefCell<Vec<Weak<Strand>>>,
    delegated: Cell<bool>,
}
pub(crate) struct Strand {
    job: Option<Rc<Interrupts>>,
    state: Cell<StrandState>,
}
#[derive(Clone, Copy)]
enum StrandState {
    Running,
    Parked,
    Waiting { pid: ProcessId, delivered: bool },
}
impl Interrupts {
    pub(crate) fn strand(self: &Rc<Self>) -> Rc<Strand> {
        let strand = Rc::new(Strand {
            job: Some(self.clone()),
            state: Cell::new(StrandState::Running),
        });
        self.strands.borrow_mut().push(Rc::downgrade(&strand));
        strand
    }
    fn live(&self) -> Vec<Rc<Strand>> {
        self.strands
            .borrow()
            .iter()
            .filter_map(Weak::upgrade)
            .collect()
    }
    pub(crate) fn deliver(&self, host: &dyn ProcessHost) -> bool {
        let mut running = false;
        let mut signalled = false;
        for strand in self.live() {
            let (shell, child) = strand.deliver(host);
            running |= shell;
            signalled |= child;
        }
        self.delegated.set(signalled && !running);
        running
    }
    pub(crate) fn take_delegated(&self) -> bool {
        self.delegated.replace(false)
    }
    pub(crate) fn force(&self) {
        self.delegated.set(false);
        for strand in self.live() {
            strand.force();
        }
    }
}
impl Drop for Strand {
    fn drop(&mut self) {
        if let Some(job) = &self.job {
            job.strands
                .borrow_mut()
                .retain(|strand| !std::ptr::eq(strand.as_ptr(), self));
        }
    }
}
impl Strand {
    pub(crate) fn untracked() -> Rc<Self> {
        Rc::new(Self {
            job: None,
            state: Cell::new(StrandState::Running),
        })
    }
    pub(crate) fn fork(&self) -> Rc<Self> {
        self.job
            .as_ref()
            .map_or_else(Self::untracked, Interrupts::strand)
    }
    fn deliver(&self, host: &dyn ProcessHost) -> (bool, bool) {
        match self.state.get() {
            StrandState::Running => (true, false),
            StrandState::Parked => (false, false),
            StrandState::Waiting { pid, .. } => {
                let _ = host.signal_child(pid, 2);
                self.state.set(StrandState::Waiting {
                    pid,
                    delivered: true,
                });
                (false, true)
            }
        }
    }
    fn force(&self) {
        if let StrandState::Waiting { pid, .. } = self.state.get() {
            self.state.set(StrandState::Waiting {
                pid,
                delivered: false,
            });
        }
    }
    pub(crate) fn park(self: &Rc<Self>) -> StrandGuard {
        self.state.set(StrandState::Parked);
        StrandGuard(self.clone())
    }
    pub(crate) fn wait(self: &Rc<Self>, pid: ProcessId) -> WaitGuard {
        self.state.set(StrandState::Waiting {
            pid,
            delivered: false,
        });
        WaitGuard(StrandGuard(self.clone()))
    }
}
pub(crate) struct StrandGuard(Rc<Strand>);
impl Drop for StrandGuard {
    fn drop(&mut self) {
        self.0.state.set(StrandState::Running);
    }
}
pub(crate) struct WaitGuard(StrandGuard);
impl WaitGuard {
    pub(crate) fn delivered(&self) -> bool {
        matches!(
            self.0.0.state.get(),
            StrandState::Waiting {
                delivered: true,
                ..
            }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor::Executor, process::InProcessHost};

    #[test]
    fn completed_strands_release_their_registrations_without_an_interrupt() {
        let routing = Rc::new(Interrupts::default());
        let root = routing.strand();
        for _ in 0..100_000 {
            let first = root.fork();
            let second = first.fork();
            assert_eq!(routing.strands.borrow().len(), 3);
            drop(first);
            drop(second);
            assert_eq!(routing.strands.borrow().len(), 1);
        }
        drop(root);
        assert!(routing.strands.borrow().is_empty());
    }

    #[test]
    fn running_and_parked_strands_never_acknowledge_an_undelivered_event() {
        let host = InProcessHost::new(Executor::new());
        let routing = Rc::new(Interrupts::default());
        assert!(!routing.deliver(&host));
        assert!(!routing.take_delegated());
        let strand = routing.strand();
        assert!(routing.deliver(&host));
        assert!(!routing.take_delegated());
        let _parked = strand.park();
        assert!(!routing.deliver(&host));
        assert!(!routing.take_delegated());
    }

    #[test]
    fn forced_cancellation_clears_delegation_and_rearms_the_wait() {
        let host = InProcessHost::new(Executor::new());
        let routing = Rc::new(Interrupts::default());
        let strand = routing.strand();
        let wait = strand.wait(42);
        assert!(!routing.deliver(&host));
        assert!(wait.delivered());
        routing.force();
        assert!(!routing.take_delegated());
        assert!(!wait.delivered());
    }
}
