//! Trap execution owns admission, status restoration and boundary-local visibility.
use super::*;
use crate::state::traps::{Binding, Traps};
use futures::future::{AbortHandle, Abortable, Either, ready};

#[derive(Clone, Copy)]
pub(super) enum Event {
    Exit = 0,
    Debug = 65,
    Err = 66,
    Return = 67,
}
impl Event {
    fn bit(self) -> u8 {
        match self {
            Self::Exit => 1,
            Self::Debug => 2,
            Self::Err => 4,
            Self::Return => 8,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) enum Completion {
    #[default]
    Open,
    Running,
    Finished(i32),
}

pub(super) enum DebugDecision {
    Execute,
    Skip,
    Transfer(Outcome),
}

struct Status {
    state: SharedState,
    code: i32,
    pipeline: Option<Vec<i32>>,
    _allocation: crate::exec::Allocation,
}
impl Status {
    fn save(state: &SharedState, context: &Context) -> Result<Self, i32> {
        let shell = state.borrow();
        let bytes = shell
            .pipeline_status()
            .len()
            .checked_mul(size_of::<i32>())
            .ok_or(2)?;
        let allocation = context
            .evaluation
            .admit_execution(bytes.checked_add(size_of::<Self>()).ok_or(2)?)?;
        let mut pipeline = Vec::new();
        pipeline
            .try_reserve_exact(shell.pipeline_status().len())
            .map_err(|_| crate::exec::RESOURCE_STATUS)?;
        pipeline.extend_from_slice(shell.pipeline_status());
        Ok(Self {
            state: state.clone(),
            code: shell.status(),
            pipeline: Some(pipeline),
            _allocation: allocation,
        })
    }
}
impl Drop for Status {
    fn drop(&mut self) {
        let mut state = self.state.borrow_mut();
        state.publish_status(self.code);
        state.publish_pipeline_status(self.pipeline.take().unwrap());
    }
}

pub(super) struct FunctionScope {
    state: SharedState,
    saved: Option<Traps>,
    _allocation: crate::exec::Allocation,
}
impl FunctionScope {
    pub(super) fn enter(state: &SharedState, context: &Context) -> Result<Self, i32> {
        let allocation = context.evaluation.admit_execution(size_of::<Self>())?;
        let mut shell = state.borrow_mut();
        let saved = shell.traps.clone();
        let debug = shell.functrace || shell.extdebug;
        let err = shell.errtrace;
        shell.traps.function_scope(debug, err);
        Ok(Self {
            state: state.clone(),
            saved: Some(saved),
            _allocation: allocation,
        })
    }
}
impl Drop for FunctionScope {
    fn drop(&mut self) {
        self.state
            .borrow_mut()
            .traps
            .restore_function(self.saved.take().unwrap());
    }
}

pub(super) fn inherit(state: &SharedState) {
    let mut shell = state.borrow_mut();
    let debug = shell.functrace || shell.extdebug;
    let err = shell.errtrace;
    shell.traps.inherit_execution(debug, err);
}

// The ordinary caller retains only a ready result or an admitted boxed reader.
// No action or saved PIPESTATUS is captured by its recursive command future.
pub(super) fn run(
    event: Event,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    if context.cancel.is_cancelled() || context.trap_mask & event.bit() != 0 {
        return Either::Left(ready(Outcome::status(0)));
    }
    let action = state.borrow().traps.executable(event as usize).cloned();
    let Some(Binding::Handler(action)) = action else {
        return Either::Left(ready(Outcome::status(0)));
    };
    let scope = match context.evaluation.enter() {
        Ok(scope) => scope,
        Err(code) => return Either::Left(ready(Outcome::status(code))),
    };
    let plan = prepare(&action.text, &state, &context, &scope);
    let (source, reader, status) = match plan {
        Ok(plan) => plan,
        Err(code) => return Either::Left(ready(Outcome::status(code))),
    };
    let context = Context {
        source,
        evaluation: scope.clone(),
        trap_mask: context.trap_mask | event.bit(),
        // The handler's own failing commands do not apply the caller's -e.
        ignore_errexit: true,
        skip_debug: false,
        ..context
    };
    let executor = context.core.executor.clone();
    let task = scope.frame(
        async move {
            let _status = status;
            let _action = action;
            reader::run(reader, "trap", true, state, fds, context).await
        },
        Outcome::status,
    );
    if let Either::Left(result) = task {
        return Either::Left(result);
    }
    let (abort, registration) = AbortHandle::new_pair();
    let guard = ReaderWait(abort);
    scope.frame(
        async move {
            let _guard = guard;
            executor
                .spawn(async move {
                    Abortable::new(task, registration)
                        .await
                        .unwrap_or_else(|_| Outcome::status(130))
                })
                .await
        },
        Outcome::status,
    )
}

// Dropping a wait never leaves user code running on a detached reader task.
// The task owns status restoration until its canceled future is retired.
struct ReaderWait(AbortHandle);
impl Drop for ReaderWait {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn prepare(
    text: &str,
    state: &SharedState,
    context: &Context,
    scope: &crate::exec::Scope,
) -> Result<(crate::exec::Source, reader::Reader, Status), i32> {
    let source = eval::trap_source(text, scope, context.limits().source_bytes)?.retain();
    let parser = context.parser_budget();
    let aliases = reader::AliasOptions::snapshot(state);
    let (script, failure) = parse::script(
        &source,
        context.limits().source_bytes,
        &parser,
        aliases.options(),
    )
    .map_err(|_| {
        if context.cancel.is_cancelled() {
            130
        } else {
            crate::exec::RESOURCE_STATUS
        }
    })?;
    let status = Status::save(state, context)?;
    Ok((
        source,
        reader::Reader::new(script, failure, aliases, parser),
        status,
    ))
}

fn debug_active(state: &SharedState, context: &Context) -> bool {
    !context.skip_debug
        && context.trap_mask & Event::Debug.bit() == 0
        && matches!(
            state.borrow().traps.executable(Event::Debug as usize),
            Some(Binding::Handler(_))
        )
}

pub(super) fn for_iteration(
    command: &ForCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, DebugDecision> {
    if !debug_active(&state, &context) {
        return Either::Left(ready(DebugDecision::Execute));
    }
    let limit = context.limits().source_bytes;
    let text = shell_parser::parser::for_header_string(
        command,
        &Cell::new(limit),
        limit,
        Some(&context.parser_budget()),
    );
    planned_debug(text, state, fds, context)
}

pub(super) fn debug(
    command: &Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, DebugDecision> {
    let eligible = matches!(
        command,
        Command::Simple(_)
            | Command::Compound(CompoundCommand::Arithmetic(_) | CompoundCommand::Test(_), _)
    );
    if !eligible || !debug_active(&state, &context) {
        return Either::Left(ready(DebugDecision::Execute));
    }
    let limit = context.limits().source_bytes;
    let text = command_string(
        command,
        &Cell::new(limit),
        limit,
        Some(&context.parser_budget()),
    );
    planned_debug(text, state, fds, context)
}

fn planned_debug(
    text: shell_parser::error::Result<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, DebugDecision> {
    let text = match text {
        Ok(text) => text,
        Err(_) => {
            return Either::Left(ready(DebugDecision::Transfer(Outcome::status(
                crate::exec::RESOURCE_STATUS,
            ))));
        }
    };
    let evaluation = context.evaluation.clone();
    evaluation.frame(debug_body(text, state, fds, context), |code| {
        DebugDecision::Transfer(Outcome::status(code))
    })
}

async fn debug_body(
    text: String,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> DebugDecision {
    let mut work = expansion_work(&context);
    if let Err(error) = State::admit_assignment(
        &state,
        "BASH_COMMAND",
        text.len(),
        &context.cancel,
        &mut work,
    )
    .await
    {
        return DebugDecision::Transfer(Outcome::status(admission_status(error)));
    }
    if let Err(code) = state
        .borrow_mut()
        .assign_parameter("BASH_COMMAND".into(), text)
    {
        return DebugDecision::Transfer(Outcome::status(code));
    }
    let extdebug = state.borrow().extdebug;
    let result = run(Event::Debug, state, fds, context.clone()).await;
    if result.flow != Flow::Normal {
        return DebugDecision::Transfer(result);
    }
    if extdebug && result.code == 2 && context.return_boundary {
        return DebugDecision::Transfer(Outcome {
            code: result.code,
            flow: Flow::Return,
        });
    }
    if extdebug && result.code != 0 {
        return DebugDecision::Skip;
    }
    DebugDecision::Execute
}

pub(super) fn failed(
    result: Outcome,
    eligible: bool,
    state: SharedState,
    fds: Option<Descriptors>,
    context: Context,
) -> eval::Frame<'static> {
    if !eligible || result.flow != Flow::Normal || result.code == 0 {
        return Either::Left(ready(result));
    }
    let errexit = state.borrow().errexit;
    let result = Outcome {
        flow: if errexit { Flow::Exit } else { result.flow },
        ..result
    };
    if !matches!(
        state.borrow().traps.executable(Event::Err as usize),
        Some(Binding::Handler(_))
    ) {
        return Either::Left(ready(result));
    }
    let Some(fds) = fds else {
        return Either::Left(ready(result));
    };
    let reader = run(Event::Err, state, fds, context.clone());
    context.evaluation.frame(
        async move {
            let handler = reader.await;
            if handler.flow != Flow::Normal {
                return handler;
            }
            Outcome {
                flow: if errexit { Flow::Exit } else { result.flow },
                ..result
            }
        },
        Outcome::status,
    )
}

pub(super) fn returning(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    if !matches!(result.flow, Flow::Normal | Flow::Return) || context.cancel.is_cancelled() {
        return Either::Left(ready(result));
    }
    if !matches!(
        state.borrow().traps.executable(Event::Return as usize),
        Some(Binding::Handler(_))
    ) {
        return Either::Left(ready(result));
    }
    state.borrow_mut().publish_status(result.code);
    let reader = run(Event::Return, state, fds, context.clone());
    context.evaluation.frame(
        async move {
            let handler = reader.await;
            if handler.flow != Flow::Normal {
                return handler;
            }
            result
        },
        Outcome::status,
    )
}

pub(super) fn completing(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    if context.cancel.is_cancelled() {
        return Either::Left(ready(result));
    }
    state.borrow_mut().publish_status(result.code);
    let reader = run(Event::Exit, state, fds, context.clone());
    context.evaluation.frame(
        async move {
            let handler = reader.await;
            if handler.flow != Flow::Normal {
                return handler;
            }
            result
        },
        Outcome::status,
    )
}

// A leaf external/builtin cannot install an EXIT handler while waiting for its
// terminal fence. Do not keep its pipe ends alive in an otherwise trap-free stage.
pub(super) fn needs_completion_descriptors(command: &Command, state: &SharedState) -> bool {
    let shell = state.borrow();
    if [0, 65, 66, 67]
        .into_iter()
        .any(|event| matches!(shell.traps.executable(event), Some(Binding::Handler(_))))
    {
        return true;
    }
    let Command::Simple(simple) = command else {
        return true;
    };
    let [WordPart::Literal(name)] = simple.name.parts.as_slice() else {
        return true;
    };
    if shell.functions().contains_key(name) {
        return true;
    }
    matches!(
        commands::handler(name),
        Some(
            commands::Handler::Eval
                | commands::Handler::Source
                | commands::Handler::Command
                | commands::Handler::BuiltinWrapper
                | commands::Handler::Builtin(commands::Builtin::Trap)
        )
    )
}
