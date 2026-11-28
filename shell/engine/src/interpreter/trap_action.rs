use super::*;
use crate::state::traps::{Action, Binding, ERR, EXIT, RETURN};
use futures::future::{Either, ready};

struct Invocation {
    event: usize,
    action: Rc<Action>,
    outcome: Outcome,
    status: i32,
}

pub(super) fn at_boundary(
    event: usize,
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    if context.cancel.is_cancelled() {
        return Either::Left(ready(result));
    }
    let Some(invocation) = prepare_invocation(event, result, &state) else {
        return Either::Left(ready(result));
    };
    let evaluation = context.evaluation.clone();
    evaluation.reader_frame(
        |scope| dispatch(invocation, state, fds, context, scope),
        Outcome::status,
    )
}

fn prepare_invocation(event: usize, outcome: Outcome, state: &SharedState) -> Option<Invocation> {
    let mut shell = state.borrow_mut();
    let status = if event == RETURN {
        let previous = shell.traps.take_return_status();
        if outcome.flow == Flow::Return {
            previous.unwrap_or(outcome.code)
        } else {
            outcome.code
        }
    } else {
        outcome.code
    };
    let action = shell.traps.executable(event)?.clone();
    Some(Invocation {
        event,
        action,
        outcome,
        status,
    })
}

pub(super) fn complete(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    at_boundary(EXIT, result, state, fds, context)
}

pub(super) async fn signals(
    mut result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    if !context.root_environment()
        || state.borrow().traps.dispatching()
        || context.cancel.is_cancelled()
    {
        return result;
    }
    while let Some(signal) = context.core.host.take_trap_signal() {
        let outcome = at_boundary(
            signal as usize,
            result,
            state.clone(),
            fds.clone(),
            context.clone(),
        )
        .await;
        if outcome.flow != result.flow {
            return outcome;
        }
        result = outcome;
    }
    result
}

pub(super) fn needs_command_boundary(
    state: &SharedState,
    context: &Context,
    check_errexit: bool,
) -> bool {
    let traps = &state.borrow().traps;
    let signals = context.root_environment()
        && context.core.signal_handlers.get() != 0
        && !traps.dispatching();
    let err = check_errexit && traps.executable(ERR).is_some();
    signals || err
}

#[inline(never)]
pub(super) fn execute_command<'a>(
    command: CommandView<'a>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    checks: CommandChecks,
) -> eval::Frame<'a> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        command_outcome(command, state, fds, context, checks),
        Outcome::status,
    )
}

async fn command_outcome(
    command: CommandView<'_>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    checks: CommandChecks,
) -> Outcome {
    if !context.command_checkpoint().await {
        return Outcome::status(130);
    }
    let result = command_body(command, state.clone(), fds.clone(), context.clone()).await;
    let (result, failed) = settle_command(result, &state, checks);
    let after_signals = signals(result, state.clone(), fds.clone(), context.clone()).await;
    if failed && after_signals.flow == result.flow && after_signals.code == result.code {
        return at_boundary(ERR, after_signals, state, fds, context).await;
    }
    after_signals
}

pub(super) fn returning(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    if !matches!(result.flow, Flow::Normal | Flow::Return) {
        return Either::Left(ready(result));
    }
    at_boundary(RETURN, result, state, fds, context)
}

pub(super) struct FunctionBindings {
    state: SharedState,
    saved: [Option<(u64, Binding)>; 3],
}

impl FunctionBindings {
    pub(super) fn enter(state: &SharedState) -> Self {
        let mut shell = state.borrow_mut();
        let err = shell.errtrace;
        let functions = shell.functrace || shell.extdebug;
        let saved = shell.traps.hide_untraced(err, functions);
        Self {
            state: state.clone(),
            saved,
        }
    }
}

impl Drop for FunctionBindings {
    fn drop(&mut self) {
        self.state
            .borrow_mut()
            .traps
            .restore_untraced(std::mem::take(&mut self.saved));
    }
}

pub(super) fn trace_inherited(state: &SharedState) {
    let mut shell = state.borrow_mut();
    let err = shell.errtrace;
    let functions = shell.functrace || shell.extdebug;
    shell.traps.trace_inherited(err, functions);
}

pub(super) struct ExitDescriptors {
    table: Descriptors,
    awaiting_redirects: bool,
}

pub(super) fn arm_exit(
    command: &Command,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) {
    if !retain_for_exit(command, state) {
        return;
    }
    let awaiting_redirects = matches!(command, Command::Simple(_) | Command::Compound(..));
    context
        .scope
        .0
        .exit_descriptors
        .replace(Some(ExitDescriptors {
            table: fds.clone(),
            awaiting_redirects,
        }));
}

pub(super) fn effective_exit_descriptors(fds: &Descriptors, context: &Context) {
    if context.root_environment() {
        return;
    }
    let mut exit = context.scope.0.exit_descriptors.borrow_mut();
    if let Some(exit) = exit.as_mut()
        && exit.awaiting_redirects
    {
        exit.awaiting_redirects = false;
        exit.table = fds.clone();
    }
}

pub(super) fn finish_child(
    result: Outcome,
    state: SharedState,
    context: Context,
) -> eval::Frame<'static> {
    let exit = context.scope.0.exit_descriptors.take();
    match exit {
        Some(exit) => complete(result, state, exit.table, context),
        None => Either::Left(ready(result)),
    }
}

fn retain_for_exit(command: &Command, state: &SharedState) -> bool {
    if matches!(command, Command::Compound(CompoundCommand::Subshell(_), _)) {
        return false;
    }
    let Command::Simple(command) = command else {
        return true;
    };
    let [WordPart::Literal(name)] = command.name.parts.as_slice() else {
        return true;
    };
    if state.borrow().functions().contains_key(name) {
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

struct SavedStatus {
    state: SharedState,
    event: usize,
    code: i32,
    pipeline: Vec<i32>,
    _storage: crate::exec::Allocation,
}

impl SavedStatus {
    fn capture(
        state: &SharedState,
        invocation: &Invocation,
        scope: &crate::exec::Scope,
    ) -> Result<Self, i32> {
        let mut shell = state.borrow_mut();
        let statuses = shell.pipeline_status();
        let bytes = std::mem::size_of_val(statuses);
        let storage = scope.admit_execution(bytes)?;
        let mut pipeline = Vec::new();
        pipeline
            .try_reserve_exact(statuses.len())
            .map_err(|_| crate::exec::RESOURCE_STATUS)?;
        pipeline.extend_from_slice(statuses);
        shell.traps.enter(invocation.event, invocation.status);
        shell.publish_status(invocation.status);
        Ok(Self {
            state: state.clone(),
            event: invocation.event,
            code: invocation.outcome.code,
            pipeline,
            _storage: storage,
        })
    }
}

impl Drop for SavedStatus {
    fn drop(&mut self) {
        let mut shell = self.state.borrow_mut();
        shell.traps.leave(self.event);
        shell.publish_status(self.code);
        shell.publish_pipeline_status(std::mem::take(&mut self.pipeline));
    }
}

async fn dispatch(
    invocation: Invocation,
    state: SharedState,
    fds: Descriptors,
    mut context: Context,
    scope: crate::exec::Scope,
) -> Outcome {
    let source = match eval::join_text(&[invocation.action.text.as_str()], &scope, &context).await {
        Ok(source) => source,
        Err(code) => return Outcome::status(code),
    };
    let _restore = match SavedStatus::capture(&state, &invocation, &scope) {
        Ok(saved) => saved,
        Err(code) => return Outcome::status(code),
    };
    context.tail_exec = false;
    let outcome = eval::read(
        source,
        scope,
        Some("trap"),
        state.clone(),
        fds.clone(),
        context.clone(),
    )
    .await;
    match outcome {
        Ok(handler) if handler.flow != Flow::Normal => handler,
        Ok(_) => invocation.outcome,
        Err(message) => {
            abort_diagnostic(&fds, &context, message.as_bytes(), 2).await;
            invocation.outcome
        }
    }
}
