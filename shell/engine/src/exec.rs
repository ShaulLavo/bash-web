//! Original shared execution ownership and admission, extracted from the
//! interpreter and expansion adapters. Feature orchestration stays above this layer.
use crate::executor::{Budget, Cancel};
use futures::{
    FutureExt,
    future::{Either, LocalBoxFuture, Ready, ready},
};
use shell_parser::limits::{ExecutionBudget, ExecutionLimits};
use std::{
    cell::Cell,
    future::Future,
    mem::{size_of, size_of_val},
    ops::Deref,
    pin::Pin,
    rc::Rc,
    sync::{Arc, atomic::AtomicBool},
    task::{Context as TaskContext, Poll},
    time::Duration,
};

pub(crate) const RESOURCE_STATUS: i32 = -1000;
pub(crate) type ResultFuture<'a, T> = Frame<'a, Result<T, Error>>;

const MAX_EVAL_DEPTH: usize = 16;
const MAX_EXECUTION_DEPTH: usize = 256;

pub(crate) type Frame<'a, T> = Either<Ready<T>, LocalBoxFuture<'a, T>>;

pin_project_lite::pin_project! {
    struct Admitted<F> {
        #[pin]
        future: F,
        allocation: Option<Allocation>,
    }
}

impl<F: Future> Future for Admitted<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<Self::Output> {
        #[cfg(test)]
        {
            let marker = 0u8;
            crate::executor::observation::measure_poll(&marker);
        }
        let this = self.project();
        match this.future.poll(context) {
            Poll::Ready(value) => {
                drop(this.allocation.take());
                Poll::Ready(value)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

struct Shared {
    storage: StorageBudget,
    source_bytes: usize,
    /// Bytes retained by currently active boxed execution frames. This is an
    /// active-memory bound, so a loop may keep running after each iteration's
    /// frame has been dropped instead of spending a cumulative parser budget.
    execution: StorageBudget,
}

#[derive(Clone, Debug)]
pub(crate) struct StorageBudget(Rc<Cell<usize>>, #[cfg(test)] Rc<MemoryObservation>);
#[cfg(test)]
#[derive(Debug)]
struct MemoryObservation {
    limit: usize,
    peak: Cell<usize>,
}

impl StorageBudget {
    pub(crate) fn new(bytes: usize) -> Self {
        Self(
            Rc::new(Cell::new(bytes)),
            #[cfg(test)]
            Rc::new(MemoryObservation {
                limit: bytes,
                peak: Cell::new(0),
            }),
        )
    }

    pub(crate) fn admit(&self, bytes: usize) -> Result<StorageAllocation, i32> {
        let remaining = self.0.get().checked_sub(bytes).ok_or(2)?;
        self.0.set(remaining);
        self.record_peak();
        Ok(StorageAllocation {
            budget: self.clone(),
            bytes,
        })
    }
    fn record_peak(&self) {
        #[cfg(test)]
        self.1
            .peak
            .set(self.1.peak.get().max(self.1.limit - self.0.get()));
    }
    #[cfg(test)]
    pub(crate) fn observation(&self) -> (usize, usize) {
        (self.1.limit - self.0.get(), self.1.peak.get())
    }
}

#[derive(Debug)]
pub(crate) struct StorageAllocation {
    budget: StorageBudget,
    bytes: usize,
}

impl StorageAllocation {
    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }
    pub(crate) fn grow(&mut self, bytes: usize) -> Result<(), i32> {
        let total = self.bytes.checked_add(bytes).ok_or(2)?;
        let remaining = self.budget.0.get().checked_sub(bytes).ok_or(2)?;
        self.budget.0.set(remaining);
        self.budget.record_peak();
        self.bytes = total;
        Ok(())
    }
    pub(crate) fn resize(&mut self, bytes: usize) -> Result<(), i32> {
        if bytes > self.bytes {
            self.grow(bytes - self.bytes)?;
        } else {
            self.budget.0.set(self.budget.0.get() + self.bytes - bytes);
            self.bytes = bytes;
        }
        Ok(())
    }
    pub(crate) fn fork(&self) -> Result<Self, i32> {
        self.budget.admit(self.bytes)
    }
    /// Move up to `bytes` of `source`'s existing reservation to this ticket.
    /// The shared budget is unchanged, so this cannot fail.
    pub(crate) fn take_from(&mut self, source: &mut Self, bytes: usize) {
        debug_assert!(Rc::ptr_eq(&self.budget.0, &source.budget.0));
        let moved = bytes.min(source.bytes);
        source.bytes -= moved;
        self.bytes += moved;
    }
}

impl Drop for StorageAllocation {
    fn drop(&mut self) {
        self.budget.0.set(self.budget.0.get() + self.bytes);
    }
}

pub(crate) type RetainedStorage = Rc<StorageAllocation>;

#[derive(Clone)]
pub(crate) struct Source {
    text: Rc<str>,
    storage: Option<RetainedStorage>,
}

impl Source {
    pub(crate) fn retained(&self) -> Option<RetainedStorage> {
        self.storage.clone()
    }

    pub(crate) fn root(text: &str) -> Self {
        Self {
            text: Rc::from(text),
            storage: None,
        }
    }
}

impl Deref for Source {
    type Target = str;

    fn deref(&self) -> &str {
        &self.text
    }
}

pub(crate) struct JoinedSource {
    text: String,
    storage: StorageAllocation,
}

impl JoinedSource {
    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn new(text: String, storage: StorageAllocation) -> Self {
        Self { text, storage }
    }

    pub(crate) fn retain(self) -> Source {
        Source {
            text: Rc::from(self.text),
            storage: Some(Rc::new(self.storage)),
        }
    }
}

pub(crate) struct Allocation {
    _storage: StorageAllocation,
}

#[derive(Clone)]
pub(crate) struct Scope {
    shared: Rc<Shared>,
    retained: Option<RetainedStorage>,
    depth: usize,
    execution_depth: usize,
}

impl Scope {
    pub(crate) fn new(
        source_bytes: usize,
        storage: StorageBudget,
        execution: StorageBudget,
    ) -> Self {
        Self {
            shared: Rc::new(Shared {
                storage,
                source_bytes,
                execution,
            }),
            retained: None,
            depth: 0,
            execution_depth: 0,
        }
    }

    // Each input has its own parser allowance. Nested syntax within that input
    // still shares the parser's work/fuel and cancellation state.
    pub(crate) fn parser_budget(&self, probe: Option<Rc<dyn Fn() -> bool>>) -> ExecutionBudget {
        let parser = ExecutionBudget::new(
            &ExecutionLimits {
                max_input_bytes: self.shared.source_bytes,
                timeout: Duration::MAX,
                ..ExecutionLimits::default()
            },
            Arc::new(AtomicBool::new(false)),
        );
        match probe {
            Some(probe) => parser.with_cancellation_probe(probe),
            None => parser,
        }
    }

    pub(crate) fn execution_available(&self) -> usize {
        self.shared.execution.0.get()
    }

    pub(crate) fn retained(&self) -> Option<RetainedStorage> {
        self.retained.clone()
    }

    pub(crate) fn with_retained(mut self, retained: Option<RetainedStorage>) -> Self {
        self.retained = retained;
        self
    }

    // Fixed execution allocations are charged while their boxed futures are
    // live. Source/AST copies keep their separate storage/work admission.
    // Task metadata retains its allocation until reaping. Rejection is inline,
    // including when no active execution allowance remains.
    pub(crate) fn frame<'a, T: 'a, F: Future<Output = T> + 'a>(
        &self,
        future: F,
        failure: impl FnOnce(i32) -> T,
    ) -> Frame<'a, T> {
        // The poll adapter must not move or replace F. A generic Map reserves
        // F-sized scratch while completing its state machine, even when F is
        // boxed; recursive command polling then repeats that stack reservation
        // at every level. Pin projection keeps both poll and drop in place.
        let bytes = size_of::<Admitted<F>>();
        let allocation = match self.admit_execution(bytes) {
            Ok(allocation) => allocation,
            Err(code) => return Either::Left(ready(failure(code))),
        };
        let future = Admitted {
            future,
            allocation: Some(allocation),
        };
        debug_assert_eq!(size_of_val(&future), bytes);
        Either::Right(future.boxed_local())
    }

    pub(crate) fn admit_execution(&self, bytes: usize) -> Result<Allocation, i32> {
        Ok(Allocation {
            _storage: self
                .shared
                .execution
                .admit(bytes)
                .map_err(|_| RESOURCE_STATUS)?,
        })
    }

    /// Calls already cross an executor task boundary. Only structural command
    /// depth restarts there: an active eval reader remains active across calls.
    pub(crate) fn function_body(&self) -> Self {
        Self {
            execution_depth: 0,
            ..self.clone()
        }
    }

    pub(crate) fn new_task(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            retained: self.retained.clone(),
            depth: 0,
            execution_depth: 0,
        }
    }

    pub(crate) fn descend(&self) -> Result<Self, i32> {
        if self.execution_depth >= MAX_EXECUTION_DEPTH {
            return Err(2);
        }
        Ok(Self {
            execution_depth: self.execution_depth + 1,
            ..self.clone()
        })
    }

    pub(crate) fn enter(&self) -> Result<Self, i32> {
        if self.depth >= MAX_EVAL_DEPTH {
            return Err(2);
        }
        Ok(Self {
            depth: self.depth + 1,
            ..self.clone()
        })
    }

    pub(crate) fn admit_storage(&self, bytes: usize) -> Result<StorageAllocation, i32> {
        self.shared.storage.admit(bytes)
    }

    pub(crate) async fn checkpoint(&self, budget: &mut Budget, cancel: &Cancel) -> Result<(), i32> {
        if cancel.is_cancelled() {
            return Err(130);
        }
        budget.checkpoint(cancel).await.map_err(|_| 130)
    }

    pub(crate) async fn copy_bytes(
        &self,
        bytes: usize,
        budget: &mut Budget,
        cancel: &Cancel,
    ) -> Result<(), i32> {
        for _ in 0..bytes {
            self.checkpoint(budget, cancel).await?;
        }
        Ok(())
    }
}

/// Fatal parameter errors remain distinct from ordinary unsupported/limit errors.
/// The interpreter supplies the shell environment's status and diagnostic line.
pub(crate) enum Error {
    Status(i32),
    /// A scalar write could not resolve its reference within the supported
    /// depth. Unlike an ordinary nonzero command, it ends this reader unit.
    AssignmentDepth,
    SpecialAssignment {
        name: String,
        line: Option<usize>,
    },
    BadArraySubscript {
        name: String,
        line: Option<usize>,
    },
    Readonly {
        name: String,
        line: Option<usize>,
        expansion: bool,
    },
    Arithmetic {
        message: &'static str,
        line: Option<usize>,
        expansion: bool,
    },
    ShellBoundary {
        stage: ShellBoundaryStage,
        line: Option<usize>,
    },
    BadSubstitution {
        message: &'static str,
        line: Option<usize>,
    },
    Indirect {
        name: String,
        unset: bool,
        line: Option<usize>,
    },
    Unbound {
        name: String,
        line: Option<usize>,
    },
    Parameter {
        name: String,
        message: String,
        line: Option<usize>,
    },
}
#[derive(Clone, Copy)]
pub(crate) enum ShellBoundaryStage {
    Word,
    Expansion,
}
impl Error {
    pub(crate) fn in_expansion(self) -> Self {
        match self {
            Self::Readonly { name, line, .. } => Self::Readonly {
                name,
                line,
                expansion: true,
            },
            Self::Arithmetic { message, line, .. } => Self::Arithmetic {
                message,
                line,
                expansion: true,
            },
            other => other,
        }
    }
    pub(crate) fn at_line(self, line: Option<usize>) -> Self {
        match self {
            Self::SpecialAssignment { name, .. } => Self::SpecialAssignment { name, line },
            Self::BadArraySubscript { name, .. } => Self::BadArraySubscript { name, line },
            Self::Readonly {
                name, expansion, ..
            } => Self::Readonly {
                name,
                line,
                expansion,
            },
            Self::Arithmetic {
                message, expansion, ..
            } => Self::Arithmetic {
                message,
                expansion,
                line,
            },
            Self::ShellBoundary { stage, .. } => Self::ShellBoundary { stage, line },
            Self::BadSubstitution { message, .. } => Self::BadSubstitution { message, line },
            Self::Parameter { name, message, .. } => Self::Parameter {
                name,
                message,
                line,
            },
            Self::Indirect { name, unset, .. } => Self::Indirect { name, unset, line },
            Self::Unbound { name, .. } => Self::Unbound { name, line },
            status => status,
        }
    }
}
impl From<i32> for Error {
    fn from(code: i32) -> Self {
        Self::Status(code)
    }
}

/// Command-wide cumulative work, parser, storage and field admission.
/// Temporary storage is returned only after its consumer has dropped it.
pub(crate) struct Work {
    pub(crate) remaining: usize,
    budget: Budget,
    parse_remaining: usize,
    pub(crate) storage_remaining: usize,
    pub(crate) fields_remaining: usize,
}
impl Work {
    pub(crate) fn new(steps: usize, storage: usize, fields: usize) -> Self {
        Self {
            remaining: steps,
            budget: Budget::default(),
            parse_remaining: steps,
            storage_remaining: storage,
            fields_remaining: fields,
        }
    }
    pub(crate) fn admit_storage(&mut self, bytes: usize) -> Result<(), Error> {
        if bytes > self.storage_remaining {
            return Err(2.into());
        }
        self.storage_remaining -= bytes;
        Ok(())
    }
    pub(crate) fn storage_left(&self) -> usize {
        self.storage_remaining
    }
    /// Return storage admitted for a temporary once it has been dropped. Only
    /// freed memory: retained values stay charged for the whole command.
    pub(crate) fn release_storage(&mut self, bytes: usize) {
        self.storage_remaining = self.storage_remaining.saturating_add(bytes);
    }
    pub(crate) fn consume_scalar_field(&mut self) {
        self.fields_remaining = self.fields_remaining.saturating_sub(1);
    }
    pub(crate) async fn admit_parse(&mut self, bytes: usize, cancel: &Cancel) -> Result<(), Error> {
        if bytes > self.parse_remaining {
            return Err(2.into());
        }
        self.parse_remaining -= bytes;
        // Reserve cumulative parser work before its synchronous, nonrecursive
        // scalar-token call. No parser fuel/fallback is relied on for admission.
        for _ in 0..bytes.saturating_mul(8) {
            self.checkpoint(cancel).await?;
        }
        Ok(())
    }
    pub(crate) async fn checkpoint(&mut self, cancel: &Cancel) -> Result<(), Error> {
        if cancel.is_cancelled() {
            return Err(130.into());
        }
        if self.remaining == 0 {
            return Err(2.into());
        }
        self.remaining -= 1;
        self.budget
            .checkpoint(cancel)
            .await
            .map_err(|_| Error::Status(130))
    }
}
pub(crate) fn fault<T>(message: &'static str, work: &mut Work) -> Result<T, Error> {
    work.admit_storage(message.len() * 2 + 128)?;
    Err(Error::Arithmetic {
        message,
        line: None,
        expansion: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fault_keeps_exact_message_admission_and_error_metadata() {
        let message = "division by 0";
        let bytes = message.len() * 2 + 128;
        let mut short = Work::new(1, bytes - 1, 1);
        assert!(matches!(
            fault::<()>(message, &mut short),
            Err(Error::Status(2))
        ));
        assert_eq!(short.storage_left(), bytes - 1);
        let mut exact = Work::new(1, bytes, 1);
        assert!(matches!(
            fault::<()>(message, &mut exact),
            Err(Error::Arithmetic {
                message: "division by 0",
                line: None,
                expansion: false
            })
        ));
        assert_eq!(exact.storage_left(), 0);
    }

    #[test]
    fn scope_reset_policies_keep_eval_and_structural_depth_distinct() {
        let scope = Scope::new(1024, StorageBudget::new(1024), StorageBudget::new(1024));
        let mut nested = scope.clone();
        for _ in 0..MAX_EVAL_DEPTH {
            nested = nested.enter().unwrap();
        }
        assert!(matches!(nested.enter(), Err(2)));
        for _ in 0..MAX_EXECUTION_DEPTH {
            nested = nested.descend().unwrap();
        }
        assert!(matches!(nested.descend(), Err(2)));
        let function = nested.function_body();
        assert!(matches!(function.enter(), Err(2)));
        assert_eq!(function.descend().unwrap().execution_depth, 1);
        let task = nested.new_task();
        assert_eq!(task.enter().unwrap().depth, 1);
        assert_eq!(task.descend().unwrap().execution_depth, 1);
        assert!(Rc::ptr_eq(&scope.shared, &task.shared));
    }

    #[test]
    fn source_clones_and_descendants_share_the_retained_owner_without_copying_text() {
        let storage = StorageBudget::new(64);
        let source = JoinedSource::new("body".to_owned(), storage.admit(64).unwrap()).retain();
        let clone = source.clone();
        assert!(Rc::ptr_eq(&source.text, &clone.text));
        let scope = Scope::new(1024, storage.clone(), StorageBudget::new(1024))
            .with_retained(source.retained());
        let child = scope.new_task().function_body();
        assert!(Rc::ptr_eq(
            scope.retained.as_ref().unwrap(),
            child.retained.as_ref().unwrap()
        ));
        drop(source);
        drop(clone);
        drop(scope);
        assert_eq!(storage.observation().0, 64);
        drop(child);
        assert_eq!(storage.observation().0, 0);
    }
}
