//! Original structured control-flow execution with fresh per-iteration work.
use super::*;

pub(super) enum LoopStep {
    Normal(Outcome),
    Continue,
    Stop(Outcome),
}
pub(super) fn loop_step(outcome: Outcome, depth: usize) -> LoopStep {
    match outcome.flow {
        Flow::Normal => LoopStep::Normal(outcome),
        Flow::Break(count) if count <= 1 || depth <= 1 => {
            LoopStep::Stop(Outcome::status(outcome.code))
        }
        Flow::Continue(count) if count <= 1 || depth <= 1 => LoopStep::Continue,
        Flow::Break(count) => LoopStep::Stop(Outcome {
            flow: Flow::Break(count - 1),
            ..outcome
        }),
        Flow::Continue(count) => LoopStep::Stop(Outcome {
            flow: Flow::Continue(count - 1),
            ..outcome
        }),
        _ => LoopStep::Stop(outcome),
    }
}

// Keep constructors outside the recursive dispatcher, and keep expansion and
// assignment futures outside the recursive poll frames below. Boxing only the
// outer command still leaves all of its direct await frames on every level.
#[inline(never)]
pub(super) fn run_if(
    command: IfCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(if_body(command, state, fds, context), Outcome::status)
}

async fn if_body(
    command: IfCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let branches =
        std::iter::once((command.condition, command.then_branch)).chain(command.elif_branches);
    for (condition, body) in branches {
        let result = sequence(condition, state.clone(), fds.clone(), context.condition()).await;
        if result.flow != Flow::Normal {
            return result;
        }
        if result.code == 0 {
            return sequence(body, state, fds, context).await;
        }
    }
    match command.else_branch {
        Some(body) => sequence(body, state, fds, context).await,
        None => Outcome::status(0),
    }
}

#[inline(never)]
pub(super) fn run_for<'a>(
    command: ForCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        for_body(command, state, fds, context, work),
        Outcome::status,
    )
}

async fn for_body(
    mut command: ForCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &mut expand::Work,
) -> Outcome {
    let values = match for_values(&command, &state, &fds, &context, work).await {
        Ok(values) => values,
        Err(outcome) => return outcome,
    };
    // Expansion owns its descriptors only until the complete list is ready.
    work.substitutions = None;
    let context = context.loop_body();
    let mut result = Outcome::status(0);
    for value in values {
        if let Err(outcome) = for_assignment(&mut command, value, &state, &fds, &context).await {
            return outcome;
        }
        let outcome = loop_sequence(&command.body, &state, &fds, &context, None).await;
        match loop_step(outcome, context.loop_depth) {
            LoopStep::Normal(outcome) => result = outcome,
            LoopStep::Continue => result = Outcome::status(0),
            LoopStep::Stop(outcome) => return outcome,
        }
    }
    result
}

#[inline(never)]
fn for_values<'a>(
    command: &'a ForCommand,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<Vec<String>, Outcome>> {
    context.evaluation.frame(
        for_values_body(command, state, fds, context, work),
        |code| Err(Outcome::status(code)),
    )
}

async fn for_values_body(
    command: &ForCommand,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Vec<String>, Outcome> {
    // Bash checks the binding's spelling before expanding even an empty list;
    // this ordinary loop failure does not itself trigger errexit.
    for _ in command.variable.bytes() {
        if let Err(error) = work.checkpoint(&context.cancel).await {
            return Err(Outcome::status(admission_status(error)));
        }
    }
    if !builtins::valid_name(&command.variable) {
        let bytes = command.variable.len().saturating_add(96);
        if work.admit_storage(bytes).is_err() {
            return Err(Outcome::status(2));
        }
        let diagnostic = format!(
            "/usr/bin/bash: line {}: `{}': not a valid identifier\n",
            command.span.start.line, command.variable,
        );
        let stderr = fds.borrow().get(2);
        if let Some(stderr) = stderr {
            let _ = stderr
                .write_all(diagnostic.as_bytes(), &context.cancel)
                .await;
        }
        return Err(Outcome::status(if context.cancel.is_cancelled() {
            130
        } else {
            1
        }));
    }
    let implicit;
    let words = match command.words.as_deref() {
        Some(words) => words,
        None => {
            // The implicit quoted positional word owns one part and two small
            // strings; explicit lists need neither this allocation nor its charge.
            if work
                .admit_storage(std::mem::size_of::<WordPart>() + 5)
                .is_err()
            {
                return Err(Outcome::status(2));
            }
            implicit = Word {
                parts: vec![WordPart::Variable("@".into())],
                quoted: true,
                has_unquoted_glob: false,
                part_quoted: Vec::new(),
                raw: Some("\"$@\"".into()),
            };
            std::slice::from_ref(&implicit)
        }
    };
    let mut values = Vec::new();
    let mut raw_remaining = context.limits().expansion_bytes;
    for word in words {
        let remaining = context.limits().arguments.saturating_sub(values.len());
        let fields = match expand::fields_admitted(
            word,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            remaining,
            raw_remaining,
            work,
        )
        .await
        {
            Ok(fields) => fields,
            Err(error) => return Err(expansion_failure(error.into(), fds, context).await),
        };
        raw_remaining = match fields.iter().try_fold(raw_remaining, |remaining, field| {
            remaining.checked_sub(field.len())
        }) {
            Some(bytes) => bytes,
            None => return Err(Outcome::status(2)),
        };
        let bytes = fields
            .len()
            .checked_mul(std::mem::size_of::<String>())
            .ok_or(2);
        if bytes
            .and_then(|bytes| work.admit_storage(bytes).map_err(admission_status))
            .is_err()
            || values.try_reserve_exact(fields.len()).is_err()
        {
            return Err(Outcome::status(2));
        }
        values.extend(fields);
    }
    Ok(values)
}

#[inline(never)]
fn for_assignment<'a>(
    command: &'a mut ForCommand,
    value: String,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
) -> eval::Frame<'a, Result<(), Outcome>> {
    context.evaluation.frame(
        for_assignment_body(command, value, state, fds, context),
        |code| Err(Outcome::status(code)),
    )
}

async fn for_assignment_body(
    command: &mut ForCommand,
    value: String,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), Outcome> {
    let mut assignment = expansion_work(context.limits());
    if let Err(error) = expand::admit_assignment(
        state,
        &command.variable,
        value.len(),
        &context.cancel,
        &mut assignment,
    )
    .await
    {
        return Err(expansion_failure(error.into(), fds, context).await);
    }
    // The value moves into the binding, but the owned key and a possible
    // new B-tree node must be admitted before the state map grows.
    let binding_bytes = command.variable.len().saturating_add(
        if state.borrow().bindings().contains_key(&command.variable) {
            0
        } else {
            std::mem::size_of::<(String, String)>() * 16
        },
    );
    if assignment.admit_storage(binding_bytes).is_err() {
        return Err(Outcome::status(2));
    }
    if state
        .borrow_mut()
        .assign_parameter(command.variable.clone(), value)
        .is_err()
    {
        let error = expand::Error::Readonly {
            name: std::mem::take(&mut command.variable),
            line: Some(command.span.start.line),
            expansion: false,
        };
        let mut outcome = expansion_failure(error.into(), fds, context).await;
        outcome.flow = if state.borrow().errexit {
            Flow::Abort
        } else {
            Flow::Normal
        };
        return Err(outcome);
    }
    Ok(())
}

#[inline(never)]
fn arithmetic_clause<'a>(
    source: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
) -> eval::Frame<'a, Result<i64, Outcome>> {
    context.evaluation.frame(
        arithmetic_clause_body(source, state, fds, context),
        |code| Err(Outcome::status(code)),
    )
}

async fn arithmetic_clause_body(
    source: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Result<i64, Outcome> {
    if source.trim().is_empty() {
        return Ok(0);
    }
    let mut work = substitution_work(context, fds);
    match arithmetic::evaluate(
        source,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        &mut work,
    )
    .await
    {
        Ok(value) => Ok(value),
        Err(error) => {
            let ordinary = matches!(
                error,
                expand::Error::Arithmetic {
                    expansion: false,
                    ..
                } | expand::Error::Readonly {
                    expansion: false,
                    ..
                }
            );
            let readonly = matches!(
                error,
                expand::Error::Readonly {
                    expansion: false,
                    ..
                }
            );
            let mut outcome = expansion_failure(error.into(), fds, context).await;
            if ordinary {
                // Clause arithmetic errors end the loop, not the reader.
                // Readonly assignment is fatal under -e even in a condition.
                outcome.flow = if readonly && state.borrow().errexit {
                    Flow::Abort
                } else {
                    Flow::Normal
                };
            }
            Err(outcome)
        }
    }
}

#[inline(never)]
pub(super) fn run_arithmetic_for(
    command: ArithmeticForCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        arithmetic_for_body(command, state, fds, context),
        Outcome::status,
    )
}

async fn arithmetic_for_body(
    command: ArithmeticForCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    if let Err(outcome) = arithmetic_clause(&command.init, &state, &fds, &context).await {
        return outcome;
    }
    let context = context.loop_body();
    let mut result = Outcome::status(0);
    let mut budget = Budget::default();
    loop {
        if let Err(outcome) = loop_checkpoint(&mut budget, &context).await {
            return outcome;
        }
        if !command.condition.trim().is_empty() {
            match arithmetic_clause(&command.condition, &state, &fds, &context).await {
                Ok(0) => return result,
                Ok(_) => {}
                Err(outcome) => return outcome,
            }
        }
        let outcome = loop_sequence(&command.body, &state, &fds, &context, None).await;
        match loop_step(outcome, context.loop_depth) {
            LoopStep::Normal(outcome) => result = outcome,
            LoopStep::Continue => result = Outcome::status(0),
            LoopStep::Stop(outcome) => return outcome,
        }
        if let Err(outcome) = arithmetic_clause(&command.step, &state, &fds, &context).await {
            return outcome;
        }
    }
}
