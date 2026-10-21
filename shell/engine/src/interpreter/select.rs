//! Original bounded noninteractive select, observed against GNU Bash 5.3.15.
use super::*;

#[inline(never)]
pub(super) fn run<'a>(
    command: SelectCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(body(command, state, fds, context, work), Outcome::status)
}

async fn body(
    command: SelectCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &mut expand::Work,
) -> Outcome {
    let choices = match choices(&command, &state, &context, work).await {
        Ok(choices) => choices,
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    work.substitutions = None;
    if choices.is_empty() {
        return Outcome::status(0);
    }
    let bytes = choices.iter().fold(
        choices.capacity() * std::mem::size_of::<String>(),
        |bytes, choice| bytes.saturating_add(choice.capacity()),
    );
    let _retained = match context.admit_builtin_buffer(bytes) {
        Ok(storage) => storage,
        Err(code) => return Outcome::status(code),
    };
    let context = context.loop_body();
    let mut menu = true;
    let mut budget = Budget::default();
    loop {
        if let Err(outcome) = loop_checkpoint(&mut budget, &context).await {
            return outcome;
        }
        let reply = match read_reply(
            &choices,
            menu,
            &state,
            &fds,
            &context,
            command.span.start.line,
        )
        .await
        {
            Ok(reply) => reply,
            Err(outcome) => return outcome,
        };
        if reply.is_empty() {
            menu = true;
            continue;
        }
        let selected = selection(&reply)
            .and_then(|index| choices.get(index))
            .map_or("", String::as_str);
        if let Err(outcome) = assign(
            &command.variable,
            selected,
            &state,
            &fds,
            &context,
            command.span.start.line,
        )
        .await
        {
            return outcome;
        }
        drop(reply);
        let outcome = loop_sequence(&command.body, &state, &fds, &context, None).await;
        match control::loop_step(outcome, context.loop_depth) {
            control::LoopStep::Stop(outcome) => return outcome,
            control::LoopStep::Normal(_) | control::LoopStep::Continue => {}
        }
        let mut work = expansion_work(context.limits());
        if let Err(error) =
            State::admit_scalar_access(&state, "REPLY", &context.cancel, &mut work).await
        {
            return expansion_failure(error.into(), &fds, &context).await;
        }
        menu = state
            .borrow()
            .scalar_parameter("REPLY")
            .is_none_or(str::is_empty);
    }
}

async fn choices(
    command: &SelectCommand,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Vec<String>, expand::Error> {
    if !builtins::valid_name(&command.variable) {
        return Err(1.into());
    }
    let mut choices = Vec::new();
    let mut remaining = context.limits().expansion_bytes;
    for word in &command.words {
        let fields = expand::fields_admitted(
            word,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            context.limits().arguments.saturating_sub(choices.len()),
            remaining,
            work,
        )
        .await?;
        remaining = fields
            .iter()
            .try_fold(remaining, |bytes, field| bytes.checked_sub(field.len()))
            .ok_or(2)?;
        work.admit_storage(fields.len().saturating_mul(std::mem::size_of::<String>()))?;
        choices.try_reserve_exact(fields.len()).map_err(|_| 2)?;
        choices.extend(fields);
    }
    Ok(choices)
}

fn selection(reply: &str) -> Option<usize> {
    let reply = reply.trim_matches(|ch: char| ch.is_ascii_whitespace() || ch == '\u{b}');
    let digits = reply.strip_prefix('+').unwrap_or(reply);
    if digits.is_empty() {
        return None;
    }
    let number = digits.bytes().try_fold(0usize, |number, byte| {
        if !byte.is_ascii_digit() {
            return None;
        }
        number
            .checked_mul(10)?
            .checked_add(usize::from(byte - b'0'))
    })?;
    number.checked_sub(1)
}

#[inline(never)]
fn read_reply<'a>(
    choices: &'a [String],
    menu: bool,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    line: usize,
) -> eval::Frame<'a, Result<String, Outcome>> {
    context.evaluation.frame(
        read_reply_body(choices, menu, state, fds, context, line),
        |code| Err(Outcome::status(code)),
    )
}

async fn read_reply_body(
    choices: &[String],
    menu: bool,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    line: usize,
) -> Result<String, Outcome> {
    let mut work = expansion_work(context.limits());
    if let Err(code) = prompt(choices, menu, state, fds, context, &mut work).await {
        return Err(Outcome::status(code));
    }
    let input = fds.borrow().get(0);
    let Some(input) = input else {
        return Err(closed_input(fds, context, line, &mut work).await);
    };
    let (reply, eof) = match read(input, context, &mut work).await {
        Ok(value) => value,
        Err(code) => return Err(Outcome::status(code)),
    };
    if let Err(outcome) = assign("REPLY", &reply, state, fds, context, line).await {
        if outcome.code == 1 {
            eof_newline(fds, context).await.map_err(Outcome::status)?;
        }
        return Err(outcome);
    }
    if eof {
        eof_newline(fds, context).await.map_err(Outcome::status)?;
        return Err(Outcome::status(1));
    }
    Ok(reply)
}

async fn closed_input(
    fds: &Descriptors,
    context: &Context,
    line: usize,
    work: &mut expand::Work,
) -> Outcome {
    if work.admit_storage(128).is_err() {
        return Outcome::status(2);
    }
    let diagnostic = format!("/usr/bin/bash: line {line}: 0: read error: Bad file descriptor\n");
    let stderr = fds.borrow().get(2);
    if let Some(stderr) = stderr
        && let Err(code) = write(&stderr, diagnostic.as_bytes(), context, work).await
    {
        return Outcome::status(code);
    }
    match eof_newline(fds, context).await {
        Ok(()) => Outcome::status(1),
        Err(code) => Outcome::status(code),
    }
}

fn io_status(error: io::IoError) -> i32 {
    if error == io::IoError::LimitExceeded {
        2
    } else {
        error.status()
    }
}

async fn eof_newline(fds: &Descriptors, context: &Context) -> Result<(), i32> {
    let stdout = fds.borrow().get(1);
    let Some(stdout) = stdout else {
        return Ok(());
    };
    stdout
        .write_all(b"\n", &context.cancel)
        .await
        .map_err(io_status)
}

#[inline(never)]
fn assign<'a>(
    name: &'a str,
    value: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    line: usize,
) -> eval::Frame<'a, Result<(), Outcome>> {
    context.evaluation.frame(
        assign_body(name, value, state, fds, context, line),
        |code| Err(Outcome::status(code)),
    )
}

async fn assign_body(
    name: &str,
    value: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    line: usize,
) -> Result<(), Outcome> {
    let mut work = expansion_work(context.limits());
    if let Err(error) =
        expand::admit_assignment(state, name, value.len(), &context.cancel, &mut work).await
    {
        return Err(expansion_failure(error.into(), fds, context).await);
    }
    let bytes = name.len().saturating_add(value.len()).saturating_add(
        if state.borrow().bindings().contains_key(name) {
            0
        } else {
            std::mem::size_of::<(String, String)>() * 16
        },
    );
    if work.admit_storage(bytes).is_err() {
        return Err(Outcome::status(2));
    }
    if state
        .borrow_mut()
        .assign_parameter(name.to_owned(), value.to_owned())
        .is_ok()
    {
        return Ok(());
    }
    let error = expand::Error::Readonly {
        name: name.to_owned(),
        line: Some(line),
        expansion: false,
    };
    let outcome = expansion_failure(error.into(), fds, context).await;
    Err(Outcome {
        flow: if state.borrow().errexit {
            Flow::Abort
        } else {
            Flow::Normal
        },
        ..outcome
    })
}

async fn prompt(
    choices: &[String],
    menu: bool,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    let stderr = fds.borrow().get(2);
    let Some(stderr) = stderr else {
        return Ok(());
    };
    if menu {
        print_menu(choices, &stderr, context, work).await?;
    }
    State::admit_scalar_access(state, "PS3", &context.cancel, work)
        .await
        .map_err(admission_status)?;
    let prompt = {
        let state = state.borrow();
        let text = state.scalar_parameter("PS3").unwrap_or("#? ");
        work.admit_storage(text.len()).map_err(admission_status)?;
        text.to_owned()
    };
    let _storage = context.admit_builtin_buffer(prompt.len())?;
    write(&stderr, prompt.as_bytes(), context, work).await
}

async fn print_menu(
    choices: &[String],
    stderr: &io::Endpoint,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    let width = choices.len().ilog10() as usize + 1;
    work.admit_storage(width + 2).map_err(admission_status)?;
    for (index, choice) in choices.iter().enumerate() {
        let label = format!("{:>width$}) ", index + 1);
        write(stderr, label.as_bytes(), context, work).await?;
        write(stderr, choice.as_bytes(), context, work).await?;
        write(stderr, b"\n", context, work).await?;
    }
    Ok(())
}

async fn write(
    endpoint: &io::Endpoint,
    bytes: &[u8],
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    for chunk in bytes.chunks(1024) {
        work.checkpoint(&context.cancel)
            .await
            .map_err(admission_status)?;
        match endpoint.write_all(chunk, &context.cancel).await {
            Ok(()) | Err(io::IoError::BadDescriptor) => {}
            Err(io::IoError::LimitExceeded) => return Err(2),
            Err(error) => return Err(error.status()),
        }
    }
    Ok(())
}

async fn read(
    input: io::Endpoint,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(String, bool), i32> {
    let ceiling = context
        .limits()
        .line_bytes
        .min(context.limits().expansion_bytes);
    work.admit_storage(ceiling).map_err(admission_status)?;
    let _storage = context.admit_builtin_buffer(ceiling)?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(ceiling).map_err(|_| 2)?;
    let mut escaped = false;
    let mut byte = [0];
    let eof = loop {
        work.checkpoint(&context.cancel)
            .await
            .map_err(admission_status)?;
        let count = input
            .read_cancelled(&mut byte, &context.cancel)
            .await
            .map_err(io_status)?;
        if count == 0 {
            break true;
        }
        if byte[0] == 0 {
            continue;
        }
        if byte[0] == b'\\' && !escaped {
            escaped = true;
            continue;
        }
        if byte[0] == b'\n' && !escaped {
            break false;
        }
        if byte[0] == b'\n' {
            escaped = false;
            continue;
        }
        if bytes.len() == ceiling {
            return Err(2);
        }
        bytes.push(byte[0]);
        escaped = false;
    };
    String::from_utf8(bytes.into_boxed_slice().into_vec())
        .map(|reply| (reply, eof))
        .map_err(|_| 2)
}
