use super::{
    Context, Descriptors, Flow, Limits, Outcome, parse_failure, parse_shell, script_sequence,
};
use crate::{
    executor::{Budget, Cancel},
    state::SharedState,
};
use futures::{
    FutureExt,
    future::{Either, LocalBoxFuture, Ready, ready},
};
use shell_parser::{
    limits::{ExecutionBudget, ExecutionLimits},
    parser::{Command, Word, WordPart},
};
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

#[cfg(test)]
#[derive(Clone, Copy, Default, Debug)]
pub(crate) struct StackObservation {
    driver: usize,
    pub(crate) poll_bytes: usize,
    pub(crate) drop_bytes: usize,
    pub(crate) calls: usize,
}
#[cfg(test)]
thread_local! { static STACK_OBSERVATION: Cell<StackObservation> = Cell::new(StackObservation::default()); }
#[cfg(test)]
pub(crate) fn measure_driver(marker: &u8) {
    STACK_OBSERVATION.with(|slot| {
        let mut sample = slot.get();
        sample.driver = marker as *const u8 as usize;
        slot.set(sample);
    });
}
#[cfg(test)]
fn measure_poll(marker: &u8) {
    STACK_OBSERVATION.with(|slot| {
        let mut sample = slot.get();
        if sample.driver != 0 {
            sample.poll_bytes = sample
                .poll_bytes
                .max(sample.driver.abs_diff(marker as *const u8 as usize));
        }
        slot.set(sample);
    });
}
#[cfg(test)]
pub(crate) fn measure_drop(marker: &u8) {
    STACK_OBSERVATION.with(|slot| {
        let mut sample = slot.get();
        if sample.driver != 0 {
            sample.drop_bytes = sample
                .drop_bytes
                .max(sample.driver.abs_diff(marker as *const u8 as usize));
        }
        slot.set(sample);
    });
}
#[cfg(test)]
pub(crate) fn measure_calls(calls: usize) {
    STACK_OBSERVATION.with(|slot| {
        let mut sample = slot.get();
        sample.calls = sample.calls.max(calls);
        slot.set(sample);
    });
}
#[cfg(test)]
pub(super) fn reset_stack_observation() {
    STACK_OBSERVATION.with(|slot| slot.set(StackObservation::default()));
}
#[cfg(test)]
pub(super) fn stack_observation() -> StackObservation {
    STACK_OBSERVATION.with(Cell::get)
}

const MAX_EVAL_DEPTH: usize = 16;
const MAX_EXECUTION_DEPTH: usize = 256;
const TEXT_BYTES_PER_LEVEL: usize = 16;
const READER_METADATA_BYTES: usize = 4096;

pub(super) type Frame<'a, T = Outcome> = Either<Ready<T>, LocalBoxFuture<'a, T>>;

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
            measure_poll(&marker);
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
}

impl Drop for StorageAllocation {
    fn drop(&mut self) {
        self.budget.0.set(self.budget.0.get() + self.bytes);
    }
}

pub(crate) type RetainedStorage = Rc<StorageAllocation>;

#[derive(Clone)]
pub(super) struct Source {
    text: Rc<str>,
    storage: Option<RetainedStorage>,
}

impl Source {
    pub(super) fn root(text: &str) -> Self {
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

struct JoinedSource {
    text: String,
    storage: StorageAllocation,
}

impl JoinedSource {
    fn retain(self) -> Source {
        Source {
            text: Rc::from(self.text),
            storage: Some(Rc::new(self.storage)),
        }
    }
}

pub(super) struct Allocation {
    _storage: StorageAllocation,
}

#[derive(Clone)]
pub(super) struct Scope {
    shared: Rc<Shared>,
    retained: Option<RetainedStorage>,
    depth: usize,
    execution_depth: usize,
}

impl Scope {
    pub(super) fn new(limits: &Limits, storage: StorageBudget, execution: StorageBudget) -> Self {
        Self {
            shared: Rc::new(Shared {
                storage,
                source_bytes: limits.source_bytes,
                execution,
            }),
            retained: None,
            depth: 0,
            execution_depth: 0,
        }
    }

    // Each input has its own parser allowance. Nested syntax within that input
    // still shares the parser's work/fuel and cancellation state.
    pub(super) fn parser_budget(&self, probe: Option<Rc<dyn Fn() -> bool>>) -> ExecutionBudget {
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

    pub(super) fn execution_available(&self) -> usize {
        self.shared.execution.0.get()
    }

    pub(super) fn retained(&self) -> Option<RetainedStorage> {
        self.retained.clone()
    }

    pub(super) fn with_retained(mut self, retained: Option<RetainedStorage>) -> Self {
        self.retained = retained;
        self
    }

    // Fixed execution allocations are charged while their boxed futures are
    // live. Source/AST copies keep their separate storage/work admission.
    // Task metadata retains its allocation until reaping. Rejection is inline,
    // including when no active execution allowance remains.
    pub(super) fn frame<'a, T: 'a, F: Future<Output = T> + 'a>(
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

    pub(super) fn admit_execution(&self, bytes: usize) -> Result<Allocation, i32> {
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
    pub(super) fn function_body(&self) -> Self {
        Self {
            execution_depth: 0,
            ..self.clone()
        }
    }

    pub(super) fn new_task(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            retained: self.retained.clone(),
            depth: 0,
            execution_depth: 0,
        }
    }

    pub(super) fn descend(&self) -> Result<Self, i32> {
        if self.execution_depth >= MAX_EXECUTION_DEPTH {
            return Err(2);
        }
        Ok(Self {
            execution_depth: self.execution_depth + 1,
            ..self.clone()
        })
    }

    fn enter(&self) -> Result<Self, i32> {
        if self.depth >= MAX_EVAL_DEPTH {
            return Err(2);
        }
        Ok(Self {
            depth: self.depth + 1,
            ..self.clone()
        })
    }

    pub(super) fn admit_storage(&self, bytes: usize) -> Result<StorageAllocation, i32> {
        self.shared.storage.admit(bytes)
    }

    async fn checkpoint(&self, budget: &mut Budget, cancel: &Cancel) -> Result<(), i32> {
        if cancel.is_cancelled() {
            return Err(130);
        }
        budget.checkpoint(cancel).await.map_err(|_| 130)
    }

    async fn copy_bytes(
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

// Reserve source/AST storage before growth. Its shared owner follows the reader,
// stored functions and descendant contexts; the final owner returns admission.
struct Shape {
    bytes: usize,
    syntax: usize,
}

impl Shape {
    fn character(&mut self, ch: char) {
        self.bytes += ch.len_utf8();
        self.syntax +=
            usize::from(ch.is_whitespace() || "$\\'\"`<>()|;&{}\0\u{1e}\u{1f}".contains(ch));
    }

    fn storage(&self) -> Result<usize, i32> {
        // Nested raw words/operands can retain the surrounding source at every
        // admitted level. Tokens and delimiters bound those levels; flat AST
        // slots, vector growth, lexical metadata and parser frames are separate.
        let layers = self
            .syntax
            .checked_add(1)
            .ok_or(2)?
            .min(ExecutionLimits::default().max_ast_depth);
        let text = self
            .bytes
            .checked_mul(layers)
            .and_then(|bytes| bytes.checked_mul(TEXT_BYTES_PER_LEVEL))
            .ok_or(2)?;
        let slot = size_of::<Command>() + size_of::<Word>() + size_of::<WordPart>();
        let nodes = self
            .syntax
            .checked_add(1)
            .and_then(|count| count.checked_mul(4))
            .and_then(|count| count.checked_mul(slot))
            .ok_or(2)?;
        let parsers = layers
            .checked_mul(size_of::<shell_parser::Parser<'static>>())
            .ok_or(2)?;
        text.checked_add(nodes)
            .and_then(|bytes| bytes.checked_add(parsers))
            .and_then(|bytes| bytes.checked_add(4096))
            .and_then(|bytes| bytes.checked_add(READER_METADATA_BYTES))
            .ok_or(2)
    }
}

#[inline(never)]
fn join<'a>(
    args: Vec<String>,
    scope: &'a Scope,
    context: &'a Context,
) -> Frame<'a, Result<JoinedSource, i32>> {
    scope.frame(join_body(args, scope, context), Err)
}

async fn join_body(
    args: Vec<String>,
    scope: &Scope,
    context: &Context,
) -> Result<JoinedSource, i32> {
    let mut budget = Budget::default();
    let mut bytes = args.len().saturating_sub(1);
    for arg in &args {
        scope.checkpoint(&mut budget, &context.cancel).await?;
        bytes = bytes.checked_add(arg.len()).ok_or(2)?;
    }
    if bytes > context.limits().source_bytes {
        return Err(2);
    }
    // String plus the later Rc<str> copy and both reference-count headers.
    let storage = bytes
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(size_of::<usize>() * 4))
        .and_then(|bytes| bytes.checked_add(size_of::<StorageAllocation>()))
        .ok_or(2)?;
    let mut storage = scope.admit_storage(storage)?;
    let mut source = String::new();
    source.try_reserve_exact(bytes).map_err(|_| 2)?;
    let mut shape = Shape {
        bytes: 0,
        syntax: 0,
    };
    for (index, arg) in args.into_iter().enumerate() {
        if index != 0 {
            scope.checkpoint(&mut budget, &context.cancel).await?;
            shape.character(' ');
            source.push(' ');
        }
        for ch in arg.chars() {
            scope
                .copy_bytes(ch.len_utf8(), &mut budget, &context.cancel)
                .await?;
            shape.character(ch);
            source.push(ch);
        }
    }
    storage.grow(shape.storage()?)?;
    scope.checkpoint(&mut budget, &context.cancel).await?;
    Ok(JoinedSource {
        text: source,
        storage,
    })
}

/// Read admitted eval text in the current shell. Complete earlier lines and
/// the caller's return/exit behavior survive a later syntax error.
#[inline(never)]
pub(super) fn run(
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Frame<'static> {
    if context.cancel.is_cancelled() {
        return Either::Left(ready(Outcome::status(130)));
    }
    if args.is_empty() || args.len() == 1 && args[0].is_empty() {
        return Either::Left(ready(Outcome::status(0)));
    }
    let evaluation = match context.evaluation.enter() {
        Ok(scope) => scope,
        Err(code) => return Either::Left(ready(Outcome::status(code))),
    };

    evaluation.frame(
        run_body(args, state, fds, context, evaluation.clone()),
        Outcome::status,
    )
}

async fn run_body(
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    evaluation: Scope,
) -> Outcome {
    let source = match join(args, &evaluation, &context).await {
        Ok(source) => source,
        Err(code) => return Outcome::status(code),
    };
    let parser = context.parser_budget();
    let (script, failure) = match parse_shell(&source.text, context.limits(), &parser) {
        Ok(parsed) => parsed,
        Err(_)
            if matches!(
                parser.check(),
                Err(shell_parser::limits::LimitExceeded::Cancelled)
            ) =>
        {
            context.cancel.cancel();
            return Outcome::status(130);
        }
        Err(_) => return Outcome::status(2),
    };
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    let source = source.retain();
    let context = Context {
        evaluation: evaluation.with_retained(source.storage.clone()),
        source,
        ..context
    };
    // A joined reader task breaks the recursive poll/drop chain. Keep the
    // caller's shell and evaluation scopes, including both depth counters.
    // Shape already admitted this reader's fixed executor/queue metadata.
    let mut result = context
        .core
        .executor
        .spawn(script_sequence(
            script.commands,
            script.command_end_lines,
            state,
            fds.clone(),
            context.clone(),
        ))
        .await;
    // Discard belongs to this eval reader. Resume its next input/error, then
    // return a status to the caller instead of discarding the caller's line.
    if result.flow == Flow::DiscardReadUnit {
        result.flow = Flow::Normal;
    }
    if result.flow == Flow::Normal
        && let Some(failure) = failure
    {
        result = parse_failure(failure, "eval", &fds, &context).await;
        if result.code == 2 && result.flow == Flow::Exit {
            result.flow = Flow::Normal;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_growth_is_admitted_atomically_and_refunded_by_the_last_owner() {
        let storage = StorageBudget::new(64);
        let mut allocation = storage.admit(48).unwrap();
        assert!(allocation.grow(17).is_err());
        assert_eq!(storage.0.get(), 16);
        allocation.grow(16).unwrap();
        assert!(storage.admit(1).is_err());
        let retained = Rc::new(allocation);
        let limits = Limits::default();
        let scope = Scope::new(
            &limits,
            storage.clone(),
            StorageBudget::new(limits.execution_bytes),
        )
        .with_retained(Some(retained.clone()));
        let child = scope.new_task();
        drop(retained);
        drop(scope);
        assert!(storage.admit(1).is_err());
        drop(child);
        assert_eq!(storage.0.get(), 64);
    }

    #[test]
    fn cancelling_owned_storage_returns_admission_without_waiting_for_a_later_request() {
        let storage = StorageBudget::new(64);
        let allocation = storage.admit(64).unwrap();
        let cancel = Cancel::new();
        let body = async move {
            let _allocation = allocation;
            futures::future::pending::<()>().await;
        };
        let wait = cancel.run(body);
        futures::pin_mut!(wait);
        assert!(wait.as_mut().now_or_never().is_none());
        assert_eq!(storage.0.get(), 0);
        cancel.cancel();
        assert!(matches!(wait.as_mut().now_or_never(), Some(Err(_))));
        assert_eq!(storage.0.get(), 64);
    }

    #[test]
    fn parser_work_is_shared_inside_an_input_and_fresh_for_a_later_input() {
        let limits = Limits::default();
        let scope = Scope::new(
            &limits,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let parser = scope.parser_budget(None);
        parser
            .consume_work(ExecutionLimits::default().max_work_units)
            .unwrap();
        assert!(parser.clone().consume_work(1).is_err());
        assert!(parser.consume_work(0).is_err());
        assert!(scope.parser_budget(None).consume_work(1).is_ok());
    }

    #[test]
    fn fresh_parser_inputs_preserve_interrupt_probes() {
        let limits = Limits::default();
        let interrupted = Rc::new(Cell::new(false));
        let observed = interrupted.clone();
        let probe: Rc<dyn Fn() -> bool> = Rc::new(move || observed.get());
        let scope = Scope::new(
            &limits,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let parser = scope.parser_budget(Some(probe.clone()));
        assert!(parser.consume_work(1).is_ok());
        interrupted.set(true);
        assert!(matches!(
            parser.check(),
            Err(shell_parser::limits::LimitExceeded::Cancelled)
        ));
        assert!(matches!(
            scope.parser_budget(Some(probe)).check(),
            Err(shell_parser::limits::LimitExceeded::Cancelled)
        ));
    }

    #[test]
    fn completed_and_cancelled_frames_release_admission_before_the_wrapper_is_dropped() {
        let limits = Limits::default();
        let scope = Scope::new(
            &limits,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let frame = scope.frame(ready(7), |_| 2);
        futures::pin_mut!(frame);
        assert!((limits.execution_bytes - scope.shared.execution.0.get()) > 0);
        assert_eq!(frame.as_mut().now_or_never(), Some(7));
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);

        let cancel = Cancel::new();
        let frame = scope.frame(futures::future::pending::<()>(), |_| ());
        let wait = cancel.run(frame);
        futures::pin_mut!(wait);
        assert!(wait.as_mut().now_or_never().is_none());
        assert!((limits.execution_bytes - scope.shared.execution.0.get()) > 0);
        cancel.cancel();
        assert!(matches!(wait.as_mut().now_or_never(), Some(Err(_))));
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);
    }

    #[test]
    fn large_admitted_frames_poll_in_place_without_per_level_future_copies() {
        struct Large {
            child: Frame<'static, usize>,
            retained: [u8; 8192],
        }
        impl Future for Large {
            type Output = usize;

            fn poll(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<usize> {
                let this = self.get_mut();
                Pin::new(&mut this.child)
                    .poll(context)
                    .map(|value| value + usize::from(this.retained[0]))
            }
        }

        let limits = Limits::default();
        let scope = Scope::new(
            &limits,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let mut frame = scope.frame(ready(0), |_| usize::MAX);
        for _ in 0..MAX_EXECUTION_DEPTH {
            frame = scope.frame(
                Large {
                    child: frame,
                    retained: [1; 8192],
                },
                |_| usize::MAX,
            );
        }
        assert_eq!(frame.now_or_never(), Some(MAX_EXECUTION_DEPTH));
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);
    }

    #[test]
    fn live_execution_admission_rejects_growth_and_releases_dropped_allocations() {
        let limits = Limits::default();
        let scope = Scope::new(
            &limits,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let allocation = scope.admit_execution(limits.execution_bytes).unwrap();
        assert!(scope.admit_execution(1).is_err());
        drop(allocation);
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);
        let frame = scope.frame(futures::future::pending::<()>(), |_| ());
        assert!((limits.execution_bytes - scope.shared.execution.0.get()) > 0);
        drop(frame);
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);
        assert_eq!(scope.frame(ready(7), |_| 2).now_or_never(), Some(7));
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);
        let frame = scope.frame(ready([7u8; 4096]), |_| [0; 4096]);
        let Either::Right(body) = &frame else {
            panic!("the bounded future fits the execution allowance");
        };
        assert_eq!(
            (limits.execution_bytes - scope.shared.execution.0.get()),
            size_of_val(body.as_ref().get_ref())
        );
        assert_eq!(frame.now_or_never(), Some([7; 4096]));
        assert_eq!((limits.execution_bytes - scope.shared.execution.0.get()), 0);
    }
}
