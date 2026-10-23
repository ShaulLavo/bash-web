use super::{Context, Descriptors, Flow, Outcome, command_builtin, parse_failure, script_sequence};
use crate::{
    exec::{JoinedSource, Scope, StorageAllocation},
    executor::Budget,
    parse,
    state::SharedState,
};
use futures::future::{Either, ready};
use shell_parser::{
    limits::ExecutionLimits,
    parser::{Command, Word, WordPart},
};
use std::mem::size_of;

pub(super) type Frame<'a, T = Outcome> = crate::exec::Frame<'a, T>;
const TEXT_BYTES_PER_LEVEL: usize = 16;
const READER_METADATA_BYTES: usize = 4096;

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
pub(super) fn join<'a>(
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
    Ok(JoinedSource::new(source, storage))
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
    let evaluation = context.evaluation.clone();
    evaluation.reader_frame(
        |scope| run_body(args, state, fds, context, scope),
        Outcome::status,
    )
}

async fn run_body(
    mut args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    evaluation: Scope,
) -> Outcome {
    if args.first().is_some_and(|arg| arg == "--") {
        args.remove(0);
    } else if args
        .first()
        .is_some_and(|arg| arg.starts_with('-') && arg != "-")
    {
        let diagnostic = b"/usr/bin/bash: eval: invalid option\n";
        let status = command_builtin::diagnostic(&fds, &context, diagnostic).await;
        return Outcome::status(status.err().unwrap_or(2));
    }
    let source = match join(args, &evaluation, &context).await {
        Ok(source) => source,
        Err(code) => return Outcome::status(code),
    };
    read(source, evaluation, "eval", state, fds, context).await
}

pub(super) async fn read(
    source: JoinedSource,
    evaluation: Scope,
    reader: &str,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let parser = context.parser_budget();
    let (script, failure) = match parse::eval(source.text(), context.limits().source_bytes, &parser)
    {
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
        evaluation: evaluation.with_retained(source.retained()),
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
        result = parse_failure(failure, reader, &fds, &context).await;
        if result.code == 2 && result.flow == Flow::Exit {
            result.flow = Flow::Normal;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::Limits;
    use super::*;
    use crate::{exec::StorageBudget, executor::Cancel};
    use futures::FutureExt;
    use std::{
        cell::Cell,
        future::Future,
        mem::size_of_val,
        pin::Pin,
        rc::Rc,
        task::{Context as TaskContext, Poll},
    };
    const MAX_EXECUTION_DEPTH: usize = 256;

    #[test]
    fn storage_growth_is_admitted_atomically_and_refunded_by_the_last_owner() {
        let storage = StorageBudget::new(64);
        let mut allocation = storage.admit(48).unwrap();
        assert!(allocation.grow(17).is_err());
        assert_eq!((64 - storage.observation().0), 16);
        allocation.grow(16).unwrap();
        assert!(storage.admit(1).is_err());
        let retained = Rc::new(allocation);
        let limits = Limits::default();
        let scope = Scope::new(
            limits.source_bytes,
            storage.clone(),
            StorageBudget::new(limits.execution_bytes),
        )
        .with_retained(Some(retained.clone()));
        let child = scope.new_task();
        drop(retained);
        drop(scope);
        assert!(storage.admit(1).is_err());
        drop(child);
        assert_eq!((64 - storage.observation().0), 64);
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
        assert_eq!((64 - storage.observation().0), 0);
        cancel.cancel();
        assert!(matches!(wait.as_mut().now_or_never(), Some(Err(_))));
        assert_eq!((64 - storage.observation().0), 64);
    }

    #[test]
    fn parser_work_is_shared_inside_an_input_and_fresh_for_a_later_input() {
        let limits = Limits::default();
        let scope = Scope::new(
            limits.source_bytes,
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
            limits.source_bytes,
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
            limits.source_bytes,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let frame = scope.frame(ready(7), |_| 2);
        futures::pin_mut!(frame);
        assert!((limits.execution_bytes - scope.execution_available()) > 0);
        assert_eq!(frame.as_mut().now_or_never(), Some(7));
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);

        let cancel = Cancel::new();
        let frame = scope.frame(futures::future::pending::<()>(), |_| ());
        let wait = cancel.run(frame);
        futures::pin_mut!(wait);
        assert!(wait.as_mut().now_or_never().is_none());
        assert!((limits.execution_bytes - scope.execution_available()) > 0);
        cancel.cancel();
        assert!(matches!(wait.as_mut().now_or_never(), Some(Err(_))));
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);
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
            limits.source_bytes,
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
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);
    }

    #[test]
    fn live_execution_admission_rejects_growth_and_releases_dropped_allocations() {
        let limits = Limits::default();
        let scope = Scope::new(
            limits.source_bytes,
            StorageBudget::new(limits.expansion_bytes),
            StorageBudget::new(limits.execution_bytes),
        );
        let allocation = scope.admit_execution(limits.execution_bytes).unwrap();
        assert!(scope.admit_execution(1).is_err());
        drop(allocation);
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);
        let frame = scope.frame(futures::future::pending::<()>(), |_| ());
        assert!((limits.execution_bytes - scope.execution_available()) > 0);
        drop(frame);
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);
        assert_eq!(scope.frame(ready(7), |_| 2).now_or_never(), Some(7));
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);
        let frame = scope.frame(ready([7u8; 4096]), |_| [0; 4096]);
        let Either::Right(body) = &frame else {
            panic!("the bounded future fits the execution allowance");
        };
        assert_eq!(
            (limits.execution_bytes - scope.execution_available()),
            size_of_val(body.as_ref().get_ref())
        );
        assert_eq!(frame.now_or_never(), Some([7; 4096]));
        assert_eq!((limits.execution_bytes - scope.execution_available()), 0);
    }
}
