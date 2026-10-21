//! Option scanning adapted from Bashkit's execute_getopts at 491c3281.
//! The bounded argument snapshots, binding publication and cursor owner are original.
use super::{diagnose, error_status, valid_name, write};
use crate::{
    expand::Work,
    interpreter::{Context, Outcome},
    io::FdTable,
    state::{GetoptsState, SharedState, State},
};

const USAGE: &str = "getopts: usage: getopts optstring name [arg ...]\n";

#[derive(Clone, Copy)]
enum Problem {
    Unknown(u8),
    Missing(u8),
}
struct Argument {
    value: String,
    _storage: crate::exec::Allocation,
}
struct Parsed {
    option: u8,
    argument: Option<Argument>,
    cursor: GetoptsState,
    problem: Option<Problem>,
    status: i32,
}
impl Parsed {
    fn end(index: usize) -> Self {
        Self {
            option: b'?',
            argument: None,
            cursor: GetoptsState { index, offset: 0 },
            problem: None,
            status: 1,
        }
    }
}

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if args.first().is_some_and(|arg| arg == "--help") {
        write(
            fds,
            b"getopts: getopts optstring name [arg ...]\n    Parse option arguments.\n",
            context,
        )
        .await?;
        return Err(2);
    }
    let args = if args.first().is_some_and(|arg| arg == "--") {
        &args[1..]
    } else {
        args
    };
    if args.len() < 2 {
        diagnose(fds, USAGE, context).await?;
        return Err(2);
    }
    if args[0].starts_with('-') && args[0] != "-" {
        message(
            fds,
            &["getopts: ", &args[0], ": invalid option\n", USAGE],
            context,
            work,
        )
        .await?;
        return Err(2);
    }
    let specification = args[0].strip_prefix(':').unwrap_or(&args[0]);
    let silent = args[0].starts_with(':');
    let explicit = (args.len() > 2).then_some(&args[2..]);
    let mut parsed = parse(specification, explicit, state, context, work).await?;
    if silent && let Some(problem) = parsed.problem {
        let option = match problem {
            Problem::Unknown(option) => option,
            Problem::Missing(option) => {
                parsed.option = b':';
                option
            }
        };
        let byte = [option];
        parsed.argument = Some(snapshot(
            std::str::from_utf8(&byte).map_err(|_| 2)?,
            context,
            work,
        )?);
    }
    state.borrow_mut().getopts = parsed.cursor;
    work.admit_storage(20).map_err(error_status)?;
    let index = parsed.cursor.index.to_string();
    publish("OPTIND", Some(&index), state, fds, context, work).await?;
    publish(
        "OPTARG",
        parsed
            .argument
            .as_ref()
            .map(|argument| argument.value.as_str()),
        state,
        fds,
        context,
        work,
    )
    .await?;
    if !silent && let Some(problem) = parsed.problem {
        diagnostic(problem, state, fds, context, work).await?;
    }
    scan(args[1].len(), context, work).await?;
    if !valid_name(&args[1]) {
        message(
            fds,
            &["getopts: `", &args[1], "': not a valid identifier\n"],
            context,
            work,
        )
        .await?;
        return Err(1);
    }
    let option = [parsed.option];
    let option = std::str::from_utf8(&option).map_err(|_| 2)?;
    if !publish(&args[1], Some(option), state, fds, context, work).await? {
        return Err(2);
    }
    Ok(Outcome::status(parsed.status))
}

async fn scan(bytes: usize, context: &Context, work: &mut Work) -> Result<(), i32> {
    for _ in 0..bytes {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
    }
    Ok(())
}

fn snapshot(value: &str, context: &Context, work: &mut Work) -> Result<Argument, i32> {
    work.admit_storage(value.len()).map_err(error_status)?;
    let storage = context.admit_builtin_buffer(value.len())?;
    Ok(Argument {
        value: value.to_owned(),
        _storage: storage,
    })
}

async fn argument(
    index: usize,
    explicit: Option<&[String]>,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Option<Argument>, i32> {
    let bytes = match explicit {
        Some(args) => args.get(index).map(String::len),
        None => state.borrow().positional().get(index).map(String::len),
    };
    let Some(bytes) = bytes else { return Ok(None) };
    scan(bytes, context, work).await?;
    match explicit {
        Some(args) => args
            .get(index)
            .map(|value| snapshot(value, context, work))
            .transpose(),
        None => state
            .borrow()
            .positional()
            .get(index)
            .map(|value| snapshot(value, context, work))
            .transpose(),
    }
}

async fn parse(
    specification: &str,
    explicit: Option<&[String]>,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Parsed, i32> {
    let cursor = state.borrow().getopts;
    let count = explicit.map_or_else(|| state.borrow().positional().len(), <[String]>::len);
    let index = cursor.index.clamp(1, count.saturating_add(1));
    let Some(current) = argument(index - 1, explicit, state, context, work).await? else {
        return Ok(Parsed::end(index));
    };
    let value = &current.value;
    if !value.starts_with('-') || value == "-" || value == "--" {
        return Ok(Parsed::end(index + usize::from(value == "--")));
    }
    let offset = cursor.offset.max(1);
    let Some(&option) = value.as_bytes().get(offset) else {
        return Ok(Parsed::end((index + 1).min(count + 1)));
    };
    // Scalar bindings are UTF-8 strings. Never manufacture an invalid UTF-8 byte.
    if !option.is_ascii() {
        return Err(2);
    }
    let mut result = Parsed {
        option,
        argument: None,
        cursor: if offset + 1 < value.len() {
            GetoptsState {
                index,
                offset: offset + 1,
            }
        } else {
            GetoptsState {
                index: index + 1,
                offset: 0,
            }
        },
        problem: None,
        status: 0,
    };
    let definition = definition(specification, option, context, work).await?;
    if definition.is_none() || option == b':' {
        result.option = b'?';
        result.problem = Some(Problem::Unknown(option));
        return Ok(result);
    }
    if definition == Some(false) {
        return Ok(result);
    }
    required(value, offset, explicit, state, context, work, &mut result).await?;
    Ok(result)
}

async fn definition(
    specification: &str,
    option: u8,
    context: &Context,
    work: &mut Work,
) -> Result<Option<bool>, i32> {
    for (index, byte) in specification.bytes().enumerate() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if byte == option {
            return Ok(Some(specification.as_bytes().get(index + 1) == Some(&b':')));
        }
    }
    Ok(None)
}

async fn required(
    current: &str,
    offset: usize,
    explicit: Option<&[String]>,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
    result: &mut Parsed,
) -> Result<(), i32> {
    let index = if result.cursor.offset == 0 {
        result.cursor.index - 1
    } else {
        result.cursor.index
    };
    result.cursor = GetoptsState {
        index: index + 1,
        offset: 0,
    };
    if offset + 1 < current.len() {
        let value = &current[offset + 1..];
        result.argument = Some(snapshot(value, context, work)?);
        return Ok(());
    }
    if let Some(value) = argument(index, explicit, state, context, work).await? {
        result.argument = Some(value);
        result.cursor.index += 1;
        return Ok(());
    }
    result.option = b'?';
    result.problem = Some(Problem::Missing(current.as_bytes()[offset]));
    Ok(())
}

async fn publish(
    name: &str,
    value: Option<&str>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    State::admit_assignment(
        state,
        name,
        value.map_or(0, str::len),
        &context.cancel,
        work,
    )
    .await
    .map_err(error_status)?;
    let storage = state
        .borrow()
        .declaration_storage(name, false)
        .map_err(error_status)?;
    work.admit_storage(
        storage
            .saturating_add(name.len())
            .saturating_add(value.map_or(0, str::len)),
    )
    .map_err(error_status)?;
    let target_bytes = state.borrow().scalar_target(name)?.ok_or(2)?.len();
    work.admit_storage(target_bytes).map_err(error_status)?;
    let _target_storage = context.admit_builtin_buffer(target_bytes)?;
    let target = state.borrow().assignment_name(name.to_owned())?;
    let value = value.map(|value| {
        if target == "OPTIND" && value.bytes().any(|byte| !byte.is_ascii_digit()) {
            "0"
        } else {
            value
        }
    });
    let result = match value {
        None => state.borrow_mut().unset_getopts_argument(&target),
        Some(value) if name == "OPTIND" => {
            state.borrow_mut().publish_getopts_index(value.to_owned())
        }
        Some(value) => state
            .borrow_mut()
            .assign_parameter(name.to_owned(), value.to_owned()),
    };
    if let Err(status) = result {
        if status != 1 {
            return Err(status);
        }
        message(fds, &[&target, ": readonly variable\n"], context, work).await?;
        return Ok(false);
    }
    Ok(true)
}

async fn diagnostic(
    problem: Problem,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    State::admit_scalar_access(state, "OPTERR", &context.cancel, work)
        .await
        .map_err(error_status)?;
    let bytes = state
        .borrow()
        .scalar_parameter("OPTERR")
        .map_or(0, str::len);
    scan(bytes, context, work).await?;
    if !diagnostics_enabled(state.borrow().scalar_parameter("OPTERR").unwrap_or("")) {
        return Ok(());
    }
    let (prefix, option) = match problem {
        Problem::Unknown(option) => ("/usr/bin/bash: illegal option -- ", option),
        Problem::Missing(option) => ("/usr/bin/bash: option requires an argument -- ", option),
    };
    let option = [option];
    diagnose(fds, prefix, context).await?;
    diagnose(fds, std::str::from_utf8(&option).map_err(|_| 2)?, context).await?;
    diagnose(fds, "\n", context).await
}

fn diagnostics_enabled(value: &str) -> bool {
    let number = value.trim_start_matches(|ch: char| ch.is_ascii_whitespace());
    let digits = number
        .strip_prefix('+')
        .or_else(|| number.strip_prefix('-'))
        .unwrap_or(number);
    let length = digits.bytes().take_while(u8::is_ascii_digit).count();
    if length == 0 {
        return false;
    }
    let length = number.len() - digits.len() + length;
    let overflow = if number.starts_with('-') {
        i64::MIN
    } else {
        i64::MAX
    };
    number[..length].parse::<i64>().unwrap_or(overflow) as i32 != 0
}

async fn message(
    fds: &FdTable,
    pieces: &[&str],
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    diagnose(fds, "/usr/bin/bash: ", context).await?;
    for piece in pieces {
        scan(piece.len(), context, work).await?;
        diagnose(fds, piece, context).await?;
    }
    Ok(())
}
