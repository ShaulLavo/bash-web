//! Option scanning adapted from Bashkit's execute_getopts at 491c3281.
//! The bounded argument snapshots, binding publication and cursor owner are original.
use super::{diagnose, error_status, scan_bytes, valid_name, write};
use crate::{
    expand::Work,
    interpreter::{Context, Outcome},
    io::FdTable,
    state::{GetoptsState, SharedState, State, getopts_number},
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
            cursor: GetoptsState {
                index,
                offset: 0,
                argument: 0,
            },
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
    let options_ended = args.first().is_some_and(|arg| arg == "--");
    let args = if options_ended { &args[1..] } else { args };
    if !options_ended
        && args
            .first()
            .is_some_and(|arg| arg.starts_with('-') && arg != "-")
    {
        let option = &args[0][..1 + args[0][1..].chars().next().map_or(0, char::len_utf8)];
        message(
            fds,
            &["getopts: ", option, ": invalid option\n", USAGE],
            context,
            work,
        )
        .await?;
        return Err(2);
    }
    if args.len() < 2 {
        diagnose(fds, USAGE, context).await?;
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
    scan_bytes(args[1].len(), context, work).await?;
    let valid = valid_name(&args[1]);
    let enabled = if !silent && parsed.problem.is_some() {
        diagnostic_enabled(state, context, work).await?
    } else {
        false
    };
    work.admit_storage(20).map_err(error_status)?;
    let index = parsed.cursor.index.to_string();
    let index = Some(snapshot(&index, context, work)?);
    let option = [parsed.option];
    let option = std::str::from_utf8(&option).map_err(|_| 2)?;
    let destination = if valid {
        Some(snapshot(option, context, work)?)
    } else {
        None
    };
    let error_path = parsed.problem.is_some() || parsed.status != 0;
    let unbind = error_path && parsed.argument.is_none();
    let mut publications = [
        prepare("OPTIND", index, false, state, context, work).await?,
        prepare("OPTARG", parsed.argument, unbind, state, context, work).await?,
        prepare(
            if valid { &args[1] } else { "" },
            destination,
            false,
            state,
            context,
            work,
        )
        .await?,
    ];
    if error_path && valid {
        publications.swap(1, 2);
    }
    let bindings = publications.each_ref().map(|publication| {
        (
            if publication.unbind {
                ""
            } else {
                publication.name.as_str()
            },
            publication.value.as_ref().map_or(0, String::len),
        )
    });
    let reservation = state.borrow().reserve_getopts_publication(&bindings)?;
    let (failures, destination_ok) = commit_all(
        &mut publications,
        parsed.cursor,
        &args[1],
        state,
        reservation,
    )?;
    if !silent
        && enabled
        && let Some(problem) = parsed.problem
    {
        diagnostic(problem, fds, context).await?;
    }
    for target in failures.iter().flatten() {
        binding_message(fds, target, context).await?;
    }
    if !valid {
        message(
            fds,
            &["getopts: `", &args[1], "': not a valid identifier\n"],
            context,
            work,
        )
        .await?;
        return Err(1);
    }
    if !destination_ok {
        return Err(2);
    }
    Ok(Outcome::status(parsed.status))
}

struct Publication {
    name: String,
    value: Option<String>,
    _value_storage: Option<crate::exec::Allocation>,
    _storage: crate::exec::Allocation,
    unbind: bool,
}

async fn prepare(
    name: &str,
    value: Option<Argument>,
    unbind: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Publication, i32> {
    let bytes = value.as_ref().map_or(0, |argument| argument.value.len());
    if !name.is_empty() && !unbind {
        State::admit_assignment(state, name, bytes, &context.cancel, work)
            .await
            .map_err(error_status)?;
    }
    let storage = state
        .borrow()
        .declaration_storage(name, false)
        .map_err(error_status)?;
    let target_bytes = if unbind {
        0
    } else {
        state.borrow().scalar_target(name)?.map_or(0, str::len)
    };
    let copies = storage
        .saturating_add(name.len())
        .saturating_add(target_bytes.saturating_mul(2));
    work.admit_storage(copies).map_err(error_status)?;
    let (prefix_bytes, direct) = if unbind {
        (0, true)
    } else {
        let state = state.borrow();
        let target = state.scalar_target(name)?.ok_or(2)?;
        (
            if value.is_some() && state.prefix_saved(target) {
                bytes
            } else {
                0
            },
            target == name,
        )
    };
    if direct {
        work.admit_storage(prefix_bytes).map_err(error_status)?;
    }
    let storage = context.admit_builtin_buffer(copies.saturating_add(prefix_bytes))?;
    let (value, value_storage) = match value {
        Some(argument) => (Some(argument.value), Some(argument._storage)),
        None => (None, None),
    };
    Ok(Publication {
        name: name.to_owned(),
        value,
        _value_storage: value_storage,
        _storage: storage,
        unbind,
    })
}

fn commit_all(
    publications: &mut [Publication; 3],
    cursor: GetoptsState,
    destination: &str,
    state: &SharedState,
    reservation: Option<crate::exec::StorageAllocation>,
) -> Result<([Option<String>; 3], bool), i32> {
    let mut failures = [None, None, None];
    let mut destination_ok = true;
    let mut state = state.borrow_mut();
    // All fallible scans and resource admissions precede the cursor commit.
    // Transfer the aggregate reservation to local tickets without yielding.
    drop(reservation);
    state.getopts = cursor;
    for (publication, failure) in publications.iter_mut().zip(&mut failures) {
        let result = commit(publication, &mut state)?;
        if publication.name == destination && result.is_some() {
            destination_ok = false;
        }
        *failure = result;
    }
    Ok((failures, destination_ok))
}

fn commit(publication: &mut Publication, state: &mut State) -> Result<Option<String>, i32> {
    if publication.name.is_empty() {
        return Ok(None);
    }
    if publication.unbind {
        state.unset_getopts_argument();
        return Ok(None);
    }
    let target = state.assignment_name(publication.name.clone())?;
    let Some(mut value) = publication.value.take() else {
        return match state.clear_getopts_argument(&target) {
            Ok(()) => Ok(None),
            Err(1) => Ok(Some(target)),
            Err(status) => Err(status),
        };
    };
    if state.getopts_numeric(&target) && value.bytes().any(|byte| !byte.is_ascii_digit()) {
        value.clear();
        value.push('0');
    }
    let result = if publication.name == "OPTIND" {
        state.publish_getopts_index(value)
    } else {
        state.assign_parameter(publication.name.clone(), value)
    };
    match result {
        Ok(()) => Ok(None),
        Err(1) => Ok(Some(target)),
        Err(status) => Err(status),
    }
}

async fn binding_message(fds: &FdTable, target: &str, context: &Context) -> Result<(), i32> {
    diagnose(fds, "/usr/bin/bash: ", context).await?;
    diagnose(fds, target, context).await?;
    diagnose(fds, ": readonly variable\n", context).await
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
    scan_bytes(bytes, context, work).await?;
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
    if index > count {
        return Ok(Parsed::end(index));
    }
    let position = if cursor.offset == 0 {
        index - 1
    } else {
        cursor.argument
    };
    let Some(current) = argument(position, explicit, state, context, work).await? else {
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
                argument: position,
            }
        } else {
            GetoptsState {
                index: index + 1,
                offset: 0,
                argument: 0,
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
    required(current, offset, explicit, state, context, work, &mut result).await?;
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
    mut current: Argument,
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
        argument: 0,
    };
    if offset + 1 < current.value.len() {
        current.value.drain(..offset + 1);
        result.argument = Some(current);
        return Ok(());
    }
    let option = current.value.as_bytes()[offset];
    let bytes = current.value.len();
    drop(current);
    work.release_storage(bytes);
    if let Some(value) = argument(index, explicit, state, context, work).await? {
        result.argument = Some(value);
        result.cursor.index += 1;
        return Ok(());
    }
    result.option = b'?';
    result.problem = Some(Problem::Missing(option));
    Ok(())
}

async fn diagnostic_enabled(
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    State::admit_scalar_access(state, "OPTERR", &context.cancel, work)
        .await
        .map_err(error_status)?;
    let bytes = state
        .borrow()
        .scalar_parameter("OPTERR")
        .map_or(0, str::len);
    scan_bytes(bytes, context, work).await?;
    let state = state.borrow();
    let value = state.scalar_parameter("OPTERR").unwrap_or("");
    Ok(value.is_empty() || getopts_number(value) != 0)
}

async fn diagnostic(problem: Problem, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let (prefix, option) = match problem {
        Problem::Unknown(option) => ("/usr/bin/bash: illegal option -- ", option),
        Problem::Missing(option) => ("/usr/bin/bash: option requires an argument -- ", option),
    };
    let option = [option];
    diagnose(fds, prefix, context).await?;
    diagnose(fds, std::str::from_utf8(&option).map_err(|_| 2)?, context).await?;
    diagnose(fds, "\n", context).await
}

async fn message(
    fds: &FdTable,
    pieces: &[&str],
    context: &Context,
    _work: &mut Work,
) -> Result<(), i32> {
    diagnose(fds, "/usr/bin/bash: ", context).await?;
    for piece in pieces {
        diagnose(fds, piece, context).await?;
    }
    Ok(())
}
