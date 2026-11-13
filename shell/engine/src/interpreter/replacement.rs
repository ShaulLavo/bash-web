use super::*;

pub(super) enum Mode {
    Spawn,
    Tail,
    Explicit(Options),
}

#[derive(Default)]
pub(super) struct Options {
    argv0: Option<String>,
    clear: bool,
    login: bool,
}

impl Mode {
    pub(super) fn clear_environment(&self) -> bool {
        matches!(self, Self::Explicit(Options { clear: true, .. }))
    }
    pub(super) fn configure(&self, request: &mut crate::process::ExecRequest) {
        let Self::Explicit(options) = self else {
            return;
        };
        if let Some(name) = &options.argv0 {
            request.argv[0] = name.clone();
        }
        if options.login {
            request.argv[0].insert(0, '-');
        }
    }

    pub(super) fn should_attempt(&self, state: &SharedState, context: &Context) -> bool {
        match self {
            Self::Spawn => false,
            Self::Explicit(_) => true,
            Self::Tail => {
                let state = state.borrow();
                state.command_string
                    && !state.interactive
                    && state.function_calls == 0
                    && (0..crate::state::traps::SLOTS)
                        .all(|signal| state.traps.get(signal).is_none())
                    && context.core.jobs.borrow().is_empty()
                    && context.core.residuals.borrow().is_empty()
                    && context.core.host.exec_ready()
            }
        }
    }

    pub(super) fn falls_back(&self, error: &ProcessError) -> bool {
        matches!(self, Self::Tail)
            && matches!(
                error,
                ProcessError::Runtime(52 | 58) | ProcessError::StartFailed(52 | 58, _)
            )
    }
}

fn simple_eligible(simple: &SimpleCommand) -> bool {
    simple.redirects.is_empty()
        && word_eligible(&simple.name)
        && simple.args.iter().all(word_eligible)
        && simple.assignments.iter().all(|assignment| {
            assignment.index.is_none()
                && matches!(&assignment.value,
                AssignmentValue::Scalar(word) if word_eligible(word))
        })
}

fn word_eligible(word: &Word) -> bool {
    // Other forms can lazily evaluate source, including parameter/arithmetic operands.
    word.parts
        .iter()
        .all(|part| matches!(part, WordPart::Literal(_) | WordPart::Variable(_)))
}

pub(super) fn eligible(command: &Command) -> bool {
    match command {
        Command::Simple(simple) => simple_eligible(simple),
        Command::List(list) => {
            matches!(list.first.as_ref(), Command::Simple(simple) if simple_eligible(simple))
                && list.rest.iter().all(|(op, command)| {
                    *op == ListOperator::Semicolon
                        && matches!(command, Command::Simple(simple) if simple_eligible(simple))
                })
        }
        _ => false,
    }
}

fn options(argv: &[String]) -> Result<(Options, usize), String> {
    let mut options = Options::default();
    let mut index = 1;
    while let Some(value) = argv.get(index) {
        if value == "--" {
            return Ok((options, index + 1));
        }
        if !value.starts_with('-') || value == "-" {
            break;
        }
        index = option_word(value, argv, index, &mut options)?;
    }
    Ok((options, index))
}

fn option_word(
    value: &str,
    argv: &[String],
    index: usize,
    options: &mut Options,
) -> Result<usize, String> {
    let mut chars = value[1..].chars();
    while let Some(option) = chars.next() {
        if option == 'a' {
            return argv_zero(chars.as_str(), argv, index, options);
        }
        match option {
            'c' => options.clear = true,
            'l' => options.login = true,
            _ => return Err(format!("-{option}: invalid option")),
        }
    }
    Ok(index + 1)
}

fn argv_zero(
    rest: &str,
    argv: &[String],
    mut index: usize,
    options: &mut Options,
) -> Result<usize, String> {
    options.argv0 = Some(if rest.is_empty() {
        index += 1;
        argv.get(index)
            .ok_or("-a: option requires an argument")?
            .clone()
    } else {
        rest.to_owned()
    });
    Ok(index + 1)
}

pub(super) async fn explicit(
    argv: &mut Vec<String>,
    execution: Result<PreparedExecution, CommandError>,
    generated_fds: u64,
    state: &SharedState,
    original_fds: &Descriptors,
    context: &Context,
    stderr: WeakStderr,
) -> Outcome {
    let mut execution = match execution {
        Ok(execution) => execution,
        Err(error) => return expansion_failure(error, original_fds, context).await,
    };
    let fds = execution.fds.take().unwrap();
    context.persist_descriptors(
        &execution.redirected,
        generated_fds,
        &fds.borrow(),
        original_fds,
    );
    command(
        argv,
        execution.assigned,
        fds,
        execution.line,
        state,
        context,
        stderr,
    )
    .await
}

pub(super) async fn command(
    argv: &mut Vec<String>,
    assigned: Vec<(String, String)>,
    fds: Descriptors,
    line: Option<usize>,
    state: &SharedState,
    context: &Context,
    stderr: WeakStderr,
) -> Outcome {
    let (options, offset) = match options(argv) {
        Ok(options) => options,
        Err(error) => {
            return abort_diagnostic(&fds, context, format!("exec: {error}").as_bytes(), 2).await;
        }
    };
    if offset == argv.len() {
        return Outcome::status(0);
    }
    if context.scope.resolved_id() != 0 {
        let outcome = failure(ProcessError::Runtime(58), "exec", &fds, context)
            .await
            .unwrap_or_else(Outcome::status);
        return Outcome {
            flow: Flow::Exit,
            ..outcome
        };
    }
    argv.drain(..offset);
    let mut last_storage = None;
    // Clear only the request environment. Lookup still uses the effective shell PATH.
    let mode = Mode::Explicit(options);
    let result = external_command(ExternalCommand {
        argv,
        last_storage: &mut last_storage,
        argument_offset: 1,
        assigned,
        default_path: false,
        line,
        fds,
        state,
        context,
        parent_stderr: stderr,
        replacement: mode,
    })
    .await
    .unwrap_or_else(Outcome::status);
    Outcome {
        flow: if state.borrow().interactive {
            Flow::Normal
        } else {
            Flow::Exit
        },
        ..result
    }
}

pub(super) async fn failure(
    error: ProcessError,
    command: &str,
    fds: &Descriptors,
    context: &Context,
) -> Result<Outcome, i32> {
    command_builtin::execution_failure(fds, context, command, error.to_string().as_bytes(), None)
        .await?;
    let status = match error {
        ProcessError::Runtime(44)
        | ProcessError::StartFailed(44, _)
        | ProcessError::UnknownCommand(_) => 127,
        _ => 126,
    };
    Ok(Outcome::status(status))
}
