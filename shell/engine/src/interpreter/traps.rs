//! Trap execution owns admission, status restoration and boundary-local visibility.
use super::*;
use crate::state::traps::Binding;
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

impl DebugDecision {
    pub(super) fn outcome(self) -> Option<Outcome> {
        match self {
            Self::Execute => None,
            Self::Skip => Some(Outcome::status(0)),
            Self::Transfer(result) => Some(result),
        }
    }
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
        let Some(pipeline) = self.pipeline.take() else {
            return;
        };
        let mut state = self.state.borrow_mut();
        state.publish_status(self.code);
        state.publish_pipeline_status(pipeline);
    }
}

pub(super) struct FunctionScope {
    state: SharedState,
    saved: Option<[Option<Binding>; 3]>,
    err_traced: bool,
    _allocation: crate::exec::Allocation,
}
impl FunctionScope {
    pub(super) fn enter(state: &SharedState, context: &Context) -> Result<Self, i32> {
        let allocation = context.evaluation.admit_execution(size_of::<Self>())?;
        let mut shell = state.borrow_mut();
        let debug = shell.functrace || shell.extdebug;
        let err = shell.errtrace;
        let saved = shell.traps.function_scope(debug, err);
        Ok(Self {
            state: state.clone(),
            saved: Some(saved),
            err_traced: err,
            _allocation: allocation,
        })
    }
}
impl Drop for FunctionScope {
    fn drop(&mut self) {
        self.state
            .borrow_mut()
            .traps
            .restore_function(self.saved.take().unwrap(), self.err_traced);
    }
}

pub(super) fn child_mask(mask: u8) -> u8 {
    mask & !Event::Exit.bit()
}

pub(super) fn inherit(state: &SharedState) {
    inherit_boundary(state, false);
}

pub(super) fn inherit_boundary(state: &SharedState, err_boundary: bool) {
    let mut shell = state.borrow_mut();
    let debug = shell.functrace || shell.extdebug;
    let err = shell.errtrace || err_boundary;
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
    let allocation = match admit_task_metadata::<JoinHandle<Outcome>>(&context, 1) {
        Ok(allocation) => allocation,
        Err(error) => return Either::Left(ready(Outcome::status(admission_status(error)))),
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
        skip_debug: false,
        cancel: context.cancel.child(),
        ..context
    };
    let executor = context.core.executor.clone();
    let cancel = context.cancel.clone();
    let task = scope.frame(
        async move {
            let _allocation = allocation;
            let mut status = status;
            let _action = action;
            let result = reader::run(reader, "trap", true, state, fds, context).await;
            if matches!(result.flow, Flow::Exit | Flow::Return) {
                status.pipeline.take();
            }
            result
        },
        Outcome::status,
    );
    if let Either::Left(result) = task {
        return Either::Left(result);
    }
    let (abort, registration) = AbortHandle::new_pair();
    let guard = ReaderWait {
        abort,
        cancel,
        armed: true,
    };
    scope.frame(
        async move {
            let mut guard = guard;
            let result = executor
                .spawn(async move {
                    Abortable::new(task, registration)
                        .await
                        .unwrap_or_else(|_| Outcome::status(130))
                })
                .await;
            guard.armed = false;
            result
        },
        Outcome::status,
    )
}

// Dropping a wait never leaves user code running on a detached reader task.
// The task owns status restoration until its canceled future is retired.
struct ReaderWait {
    abort: AbortHandle,
    cancel: Cancel,
    armed: bool,
}
impl Drop for ReaderWait {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.cancel.cancel();
        self.abort.abort();
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

pub(super) fn debug_active(state: &SharedState, context: &Context) -> bool {
    !context.skip_debug && active(Event::Debug, state, context)
}

pub(super) fn active(event: Event, state: &SharedState, context: &Context) -> bool {
    context.trap_mask & event.bit() == 0
        && matches!(
            state.borrow().traps.executable(event as usize),
            Some(Binding::Handler(_))
        )
}

pub(super) fn command_metadata_active(state: &SharedState, context: &Context) -> bool {
    if debug_active(state, context) {
        return true;
    }
    !context.skip_debug
        && context.trap_mask & Event::Debug.bit() == 0
        && active(Event::Err, state, context)
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
    let text =
        shell_parser::parser::for_header_string(command, limit, Some(&context.parser_budget()));
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
    if !eligible || !command_metadata_active(&state, &context) {
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
                if context.cancel.is_cancelled() {
                    130
                } else {
                    crate::exec::RESOURCE_STATUS
                },
            ))));
        }
    };
    let evaluation = context.evaluation.clone();
    evaluation.frame(debug_body(text, state, fds, context), |code| {
        DebugDecision::Transfer(Outcome::status(code))
    })
}

pub(super) fn function_entry(
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, DebugDecision> {
    if !debug_active(&state, &context) {
        return Either::Left(ready(DebugDecision::Execute));
    }
    let extdebug = state.borrow().extdebug;
    let handler = run(Event::Debug, state, fds, context.clone());
    context.evaluation.frame(
        async move { debug_decision(handler.await, extdebug, context.return_boundary) },
        |code| DebugDecision::Transfer(Outcome::status(code)),
    )
}

async fn debug_body(
    text: String,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> DebugDecision {
    if context.trap_mask & Event::Err.bit() == 0
        && let Err(code) = publish_command(text, &state, &context).await
    {
        return DebugDecision::Transfer(Outcome::status(code));
    }
    if !debug_active(&state, &context) {
        return DebugDecision::Execute;
    }
    let extdebug = state.borrow().extdebug;
    let result = run(Event::Debug, state, fds, context.clone()).await;
    debug_decision(result, extdebug, context.return_boundary)
}

async fn publish_command(text: String, state: &SharedState, context: &Context) -> Result<(), i32> {
    let mut work = expansion_work(context);
    State::admit_assignment(
        state,
        "BASH_COMMAND",
        text.len(),
        &context.cancel,
        &mut work,
    )
    .await
    .map_err(admission_status)?;
    state
        .borrow_mut()
        .assign_parameter("BASH_COMMAND".into(), text)
}

fn debug_decision(result: Outcome, extdebug: bool, return_boundary: bool) -> DebugDecision {
    if result.flow != Flow::Normal {
        return DebugDecision::Transfer(result);
    }
    if extdebug && result.code == 2 && return_boundary {
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
    err_at_entry: bool,
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
    if !err_at_entry || !active(Event::Err, &state, &context) {
        return Either::Left(ready(result));
    }
    let Some(fds) = fds else {
        return Either::Left(ready(result));
    };
    at_boundary(Event::Err, result, state, fds, context)
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
    at_boundary(Event::Return, result, state, fds, context)
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
    at_boundary(Event::Exit, result, state, fds, context)
}

fn at_boundary(
    event: Event,
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    state.borrow_mut().publish_status(result.code);
    let reader = run(event, state, fds, context.clone());
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
