//! Bash builtins. External commands are installed by the embedding runtime.
mod alias;
mod caller;
mod completion;
mod declarations;
mod directories;
mod getopts;
mod help;
mod printf;
mod read;
pub(crate) mod test;
mod trap;
use crate::{
    commands::{self, Builtin, Declaration},
    executor::Budget,
    expand::{self, Error, Work},
    interpreter::{Context, Flow, JobSelector, Outcome},
    io::{Endpoint, FdTable, IoError},
    state::{SharedState, State},
};
use shell_parser::parser::{Word, WordPart};
use std::borrow::Cow;

/// Bashkit's is_decl_keyword starts with the command's syntax, not the name
/// produced by expansion. Quoting also prevents declaration-keyword syntax.
pub(crate) fn declaration_command(word: &Word) -> bool {
    if word.quoted || word.part_quoted.first().copied().unwrap_or(false) {
        return false;
    }
    let [WordPart::Literal(name)] = word.parts.as_slice() else {
        return false;
    };
    commands::lookup(name)
        .is_some_and(|command| command.declaration == Declaration::AssignmentOperands)
        && word
            .raw
            .as_deref()
            .is_none_or(|raw| uncontinued(raw).eq(name.bytes()))
}

/// The prefix-only part of Bashkit normalize_raw_word: continuations disappear
/// before recognition. Other escapes and quotes must remain syntax. Callers
/// stop at '=' so quote handling in the assignment value is unaffected.
fn uncontinued(raw: &str) -> impl Iterator<Item = u8> + '_ {
    raw.split("\\\n").flat_map(str::bytes)
}

/// Adapted from Bashkit is_assignment_prefix/is_decl_assignment_word. Only
/// syntactic assignment operands of declaration builtins suppress splitting.
pub(crate) fn assignment_operand(word: &Word) -> bool {
    let prefix_quoted = if word.part_quoted.iter().any(|quoted| *quoted) {
        word.part_quoted.first().copied().unwrap_or(false)
    } else {
        word.quoted
    };
    if prefix_quoted {
        return false;
    }
    let Some(WordPart::Literal(prefix)) = word.parts.first() else {
        return false;
    };
    let Some((name, _)) = prefix.split_once('=') else {
        return false;
    };
    if word.raw.as_deref().is_some_and(|raw| {
        !uncontinued(raw)
            .take(name.len() + 1)
            .eq(prefix[..=name.len()].bytes())
    }) {
        return false;
    }
    let name = name.strip_suffix('+').unwrap_or(name);
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|b| b == b'_' || b.is_ascii_alphabetic())
        && bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
}

pub(crate) fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().enumerate().all(|(index, byte)| {
            byte == b'_' || byte.is_ascii_alphabetic() || (index > 0 && byte.is_ascii_digit())
        })
}
fn endpoint(fds: &FdTable, fd: u32) -> Result<Endpoint, i32> {
    fds.get(fd).ok_or(1)
}
async fn write(fds: &FdTable, bytes: &[u8], context: &Context) -> Result<(), i32> {
    endpoint(fds, 1)?
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|e| e.status())
}
fn output_outcome(result: Result<(), printf::PrintFailure>) -> Result<Outcome, i32> {
    match result {
        Ok(()) => Ok(Outcome::status(0)),
        Err(printf::PrintFailure::Io(IoError::BrokenPipe)) => Ok(Outcome {
            code: 141,
            flow: Flow::Abort,
        }),
        Err(printf::PrintFailure::Io(error)) => Err(error.status()),
        Err(printf::PrintFailure::Status(code)) => Err(code),
    }
}
pub(crate) async fn run(
    builtin: Builtin,
    name: &str,
    arguments: Cow<'_, [String]>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let args = arguments.as_ref();
    match builtin {
        Builtin::Completion => {
            let kind = match name {
                "compgen" => completion::Kind::Generate,
                "complete" => completion::Kind::Complete,
                _ => completion::Kind::Options,
            };
            return completion::run(kind, args, state, fds, context, work).await;
        }
        Builtin::Help => return help::run(args, state, fds, context, work).await,
        Builtin::Noop => {}
        Builtin::False => return Err(1),
        Builtin::Test => return test::run(name, args, state, fds, context, work).await,
        Builtin::Trap => return trap::run(args, state, fds, context, work).await,
        Builtin::Getopts => return getopts::run(args, state, fds, context, work).await,
        Builtin::Alias => {
            return alias::run(name, args, state, fds, context, work)
                .await
                .map(Outcome::status);
        }
        Builtin::Caller => return caller::run(args, state, fds, context, work).await,
        Builtin::Shopt => return shopt(args, state, fds, context, work).await,
        Builtin::LoopControl => {
            return loop_control(name, args, fds, context, work).await;
        }
        Builtin::ExitReturn => {
            let args = if args.first().is_some_and(|arg| arg == "--") {
                &args[1..]
            } else {
                args
            };
            if name == "return"
                && state.borrow().function_calls == 0
                && state.borrow().source_calls == 0
            {
                return Err(2);
            }
            let code = match args.first() {
                Some(s) => match s.trim_matches([' ', '\t', '\n']).parse::<i64>() {
                    Ok(code) => code.rem_euclid(256) as i32,
                    Err(_) => {
                        return Ok(Outcome {
                            code: 2,
                            flow: if name == "return" {
                                Flow::Return
                            } else {
                                Flow::Exit
                            },
                        });
                    }
                },
                None => state.borrow().status(),
            };
            if args.len() > 1 {
                return Ok(Outcome {
                    code: 1,
                    flow: Flow::Exit,
                });
            }
            return Ok(Outcome {
                code,
                flow: if name == "exit" {
                    Flow::Exit
                } else {
                    Flow::Return
                },
            });
        }
        Builtin::Echo => {
            return output_outcome(printf::echo(args, state, fds, context, work).await);
        }
        Builtin::Printf => {
            return output_outcome(printf::run(args, state, fds, context, work).await);
        }
        Builtin::Read => return read::run(args, state, fds, context, work).await,
        Builtin::Declaration => {
            return declarations(name, args, state, fds, context, work).await;
        }
        Builtin::Unset => return unset(args, state, fds, context, work).await,
        Builtin::Cd => return directories::cd(args, state, fds, context, work).await,
        Builtin::Pushd => return directories::pushd(args, state, fds, context, work).await,
        Builtin::Popd => return directories::popd(args, state, fds, context, work).await,
        Builtin::Dirs => return directories::dirs(args, state, fds, context, work).await,
        Builtin::Pwd => {
            let cwd = state.borrow().cwd.clone();
            write(fds, format!("{cwd}\n").as_bytes(), context).await?;
        }
        Builtin::Set => return set(arguments.into_owned(), state, context, work).await,
        Builtin::Shift => {
            let args = if args.first().is_some_and(|arg| arg == "--") {
                &args[1..]
            } else {
                args
            };
            let count = match args.first() {
                None => 1,
                Some(value) => value
                    .trim_matches([' ', '\t', '\n'])
                    .parse::<i64>()
                    .map_err(|_| 2)?,
            };
            if args.len() > 1 {
                return Ok(Outcome {
                    code: 1,
                    flow: Flow::Exit,
                });
            }
            let count = usize::try_from(count).map_err(|_| 1)?;
            state.borrow_mut().shift_positional(count)?;
        }
        Builtin::Jobs => {
            if !args.is_empty() {
                return Err(2);
            }
            context.list_jobs(fds).await?;
        }
        Builtin::Wait => {
            if args.len() > 1 {
                return Err(2);
            }
            let id = args.first().map(|s| JobSelector::parse(s)).transpose()?;
            return Ok(Outcome::status(context.wait_job(id).await?));
        }
        Builtin::Kill => {
            let (action, selector) = match kill_arguments(args) {
                Ok(value) => value,
                Err(error) => {
                    if let Some(stderr) = fds.get(2) {
                        stderr
                            .write_all(b"kill: ", &context.cancel)
                            .await
                            .map_err(|error| error.status())?;
                        stderr
                            .write_all(error.message().as_bytes(), &context.cancel)
                            .await
                            .map_err(|error| error.status())?;
                        stderr
                            .write_all(b"\n", &context.cancel)
                            .await
                            .map_err(|error| error.status())?;
                    }
                    return Err(error.status());
                }
            };
            let selector = JobSelector::parse(selector)?;
            match action {
                SignalAction::Exists => context.check_job(selector)?,
                SignalAction::Terminate(signal) => context.kill_job(selector, signal)?,
            }
        }
    }
    Ok(Outcome::status(0))
}

#[derive(Clone, Copy)]
enum SignalAction {
    Exists,
    Terminate(i32),
}

#[derive(Clone, Copy)]
enum SignalError {
    Invalid,
    Unsupported,
    Usage,
}
impl SignalError {
    fn message(self) -> &'static str {
        match self {
            Self::Invalid | Self::Usage => "invalid signal",
            Self::Unsupported => "unsupported signal action",
        }
    }
    fn status(self) -> i32 {
        match self {
            Self::Invalid => 1,
            Self::Unsupported | Self::Usage => 2,
        }
    }
}

fn kill_arguments(args: &[String]) -> Result<(SignalAction, &str), SignalError> {
    match args {
        [selector] => Ok((SignalAction::Terminate(15), selector)),
        [flag, selector] if flag.starts_with("-s") => {
            let name = flag
                .strip_prefix("-s")
                .filter(|name| !name.is_empty())
                .ok_or(SignalError::Usage)?;
            Ok((parse_signal(name)?, selector))
        }
        [flag, signal, selector] if flag == "-s" => Ok((parse_signal(signal)?, selector)),
        [flag, selector] if flag.starts_with('-') => {
            Ok((parse_signal(flag.trim_start_matches('-'))?, selector))
        }
        _ => Err(SignalError::Usage),
    }
}

fn parse_signal(value: &str) -> Result<SignalAction, SignalError> {
    if let Ok(signal) = value.parse::<i32>() {
        return classify_signal(signal);
    }
    let name = value
        .get(..3)
        .filter(|prefix| ascii_eq_ignore_case(prefix, "SIG"))
        .and_then(|_| value.get(3..))
        .unwrap_or(value);
    for (candidate, signal) in [
        ("HUP", 1),
        ("INT", 2),
        ("QUIT", 3),
        ("KILL", 9),
        ("TERM", 15),
    ] {
        if ascii_eq_ignore_case(name, candidate) {
            return Ok(SignalAction::Terminate(signal));
        }
    }
    if [
        "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "USR1", "USR2", "ALRM", "PIPE",
    ]
    .iter()
    .any(|candidate| ascii_eq_ignore_case(name, candidate))
    {
        return Err(SignalError::Unsupported);
    }
    Err(SignalError::Invalid)
}

fn classify_signal(signal: i32) -> Result<SignalAction, SignalError> {
    match signal {
        0 => Ok(SignalAction::Exists),
        1 | 2 | 3 | 9 | 15 => Ok(SignalAction::Terminate(signal)),
        4..=127 => Err(SignalError::Unsupported),
        _ => Err(SignalError::Invalid),
    }
}

fn ascii_eq_ignore_case(value: &str, expected: &str) -> bool {
    value.len() == expected.len()
        && value
            .bytes()
            .zip(expected.bytes())
            .all(|(value, expected)| value.to_ascii_uppercase() == expected)
}

fn error_status(error: Error) -> i32 {
    match error {
        Error::Status(code) => code,
        _ => 2,
    }
}

const SHOPT_OPTIONS: [&str; 8] = [
    "expand_aliases",
    "extdebug",
    "extglob",
    "inherit_errexit",
    "lastpipe",
    "nullglob",
    "promptvars",
    "sourcepath",
];

fn shopt_value(state: &State, option: &str) -> Option<bool> {
    match option {
        "expand_aliases" => Some(state.expand_aliases),
        "promptvars" => Some(state.promptvars),
        "extglob" => Some(state.extglob),
        "extdebug" => Some(state.extdebug),
        "inherit_errexit" => Some(state.inherit_errexit),
        "nullglob" => Some(state.nullglob),
        "lastpipe" => Some(state.lastpipe),
        "sourcepath" => Some(state.sourcepath),
        _ => None,
    }
}

/// Original streaming shopt adapter. Only options with actual state/consumers
/// are accepted; unknown names fail rather than pretending to enable a feature.
/// Extended-pattern matching itself may still reject unsupported syntax with 2.
async fn set_shopt_option(
    option: &str,
    enabled: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    if option == "extdebug" && enabled {
        State::initialize_arguments(state, &context.cancel, work)
            .await
            .map_err(error_status)?;
    }
    let mut state = state.borrow_mut();
    match option {
        "expand_aliases" => state.expand_aliases = enabled,
        "promptvars" => state.promptvars = enabled,
        "extglob" => state.extglob = enabled,
        "extdebug" => {
            state.extdebug = enabled;
            state.functrace = enabled;
            state.errtrace = enabled;
        }
        "inherit_errexit" => state.inherit_errexit = enabled,
        "nullglob" => state.nullglob = enabled,
        "lastpipe" => state.lastpipe = enabled,
        "sourcepath" => state.sourcepath = enabled,
        _ => unreachable!("validated shell option"),
    }
    Ok(())
}

async fn shopt(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut set = false;
    let mut unset = false;
    let mut quiet = false;
    let mut reusable = false;
    let mut index = 0;
    while let Some(argument) = args.get(index) {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if argument == "--" {
            index += 1;
            break;
        }
        if !argument.starts_with('-') || argument == "-" {
            break;
        }
        for flag in argument[1..].bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(error_status)?;
            match flag {
                b's' => set = true,
                b'u' => unset = true,
                b'q' => quiet = true,
                b'p' => reusable = true,
                _ => {
                    shopt_diagnostic(argument, "invalid option", fds, context).await?;
                    return Err(2);
                }
            }
        }
        index += 1;
    }
    if set && unset {
        shopt_diagnostic(
            "",
            "cannot set and unset shell options simultaneously",
            fds,
            context,
        )
        .await?;
        return Err(1);
    }
    let operands = &args[index..];
    let options = if operands.is_empty() {
        SHOPT_OPTIONS.map(Some)
    } else {
        [None; SHOPT_OPTIONS.len()]
    };
    let mut status = 0;
    // A fixed iterator over known names avoids allocating or copying argv.
    let names = operands
        .iter()
        .map(String::as_str)
        .chain(options.into_iter().flatten());
    for option in names {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        for _ in option.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(error_status)?;
        }
        let enabled = {
            let state = state.borrow();
            shopt_value(&state, option)
        };
        let Some(enabled) = enabled else {
            shopt_diagnostic(option, "invalid shell option name", fds, context).await?;
            status = 1;
            continue;
        };
        if !operands.is_empty() && (set || unset) {
            set_shopt_option(option, set, state, context, work).await?;
            continue;
        }
        if !operands.is_empty() && !enabled {
            status = 1;
        }
        if quiet || (operands.is_empty() && ((set && !enabled) || (unset && enabled))) {
            continue;
        }
        if reusable {
            write(
                fds,
                if enabled { b"shopt -s " } else { b"shopt -u " },
                context,
            )
            .await?;
            write(fds, option.as_bytes(), context).await?;
        } else {
            write(fds, option.as_bytes(), context).await?;
            let padding = 20usize.saturating_sub(option.len());
            write(fds, &b"                    "[..padding], context).await?;
            write(fds, if enabled { b"\ton" } else { b"\toff" }, context).await?;
        }
        write(fds, b"\n", context).await?;
    }
    Ok(Outcome::status(status))
}

async fn shopt_diagnostic(
    option: &str,
    message: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    let output = endpoint(fds, 2)?;
    for piece in [
        "/usr/bin/bash: shopt: ",
        option,
        if option.is_empty() { "" } else { ": " },
        message,
        "\n",
    ] {
        output
            .write_all(piece.as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    Ok(())
}

/// Original bounded loop-control adapter. Counts use Bash's signed decimal
/// intmax_t syntax, not wasm32 usize, and outside-loop calls return success
/// before inspecting their operands. Diagnostics borrow rather than clone argv.
async fn loop_control(
    name: &str,
    args: &[String],
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    work.checkpoint(&context.cancel)
        .await
        .map_err(error_status)?;
    let depth = context.loop_depth();
    let options_ended = args.first().is_some_and(|value| value == "--");
    let args = if options_ended { &args[1..] } else { args };
    let (code, flow, value, message) = if depth == 0 {
        (
            0,
            Flow::Normal,
            None,
            "only meaningful in a `for', `while', or `until' loop",
        )
    } else if !options_ended && args.first().is_some_and(|value| value == "--help") {
        let help: &[u8] = if name == "break" {
            b"break: break [n]\n    Exit for, while, or until loops.\n"
        } else {
            b"continue: continue [n]\n    Resume for, while, or until loops.\n"
        };
        write(fds, help, context).await?;
        return Ok(Outcome::status(2));
    } else if args.len() > 1 {
        (1, Flow::Exit, None, "too many arguments")
    } else {
        let count = match args.first() {
            None => Some(1),
            Some(value) => test::decimal(value, &context.cancel, work).await?,
        };
        match count {
            Some(count) if count > 0 => {
                // Clamping to active depth also avoids truncating a valid
                // 64-bit Bash count on our wasm32 target.
                let count = (count as u64).min(depth as u64) as usize;
                return Ok(Outcome {
                    code: 0,
                    flow: if name == "break" {
                        Flow::Break(count)
                    } else {
                        Flow::Continue(count)
                    },
                });
            }
            // Bash unwinds every enclosing loop for a nonpositive count,
            // including when the command was `continue`, while preserving 1.
            Some(_) => (
                1,
                Flow::Break(depth),
                args.first(),
                "loop count out of range",
            ),
            None => (2, Flow::Exit, args.first(), "numeric argument required"),
        }
    };
    let output = endpoint(fds, 2)?;
    for piece in ["/usr/bin/bash: ", name, ": "] {
        output
            .write_all(piece.as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    if let Some(value) = value {
        output
            .write_all(value.as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
        output
            .write_all(b": ", &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    output
        .write_all(message.as_bytes(), &context.cancel)
        .await
        .map_err(|error| error.status())?;
    output
        .write_all(b"\n", &context.cancel)
        .await
        .map_err(|error| error.status())?;
    Ok(Outcome { code, flow })
}

/// Original streaming adapter for Bashkit builtins/vars.rs Set. Expanded argv
/// moves into the positional frame; no side-effect vector or argv clone.
async fn set(
    mut args: Vec<String>,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if args.is_empty() {
        return Err(2); // Variable/option listing remains unsupported.
    }
    let mut flags = {
        let state = state.borrow();
        SetFlags {
            nounset: state.nounset,
            pipefail: state.pipefail,
            errexit: state.errexit,
            monitor: state.monitor,
            noglob: state.noglob,
            noexec: state.noexec,
            functrace: state.functrace,
            errtrace: state.errtrace,
        }
    };
    let mut index = 0;
    let mut explicit = false;
    while let Some(option) = args.get(index) {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if option == "--" || option == "-" {
            explicit = option == "--";
            index += 1;
            break;
        }
        if option == "+" {
            index += 1;
            continue;
        }
        if !option.starts_with(['-', '+']) || option.len() == 1 {
            break;
        }
        let enabled = option.starts_with('-');
        index += 1;
        if matches!(option.as_str(), "-o" | "+o") {
            set_option(args.get(index).ok_or(2)?, enabled, &mut flags)?;
            index += 1;
            continue;
        }
        set_short_options(option, enabled, &mut flags, context, work).await?;
    }
    // All options and work admission complete before any state changes.
    let mut state = state.borrow_mut();
    if explicit || index < args.len() {
        args.drain(..index);
        state.replace_positional(args)?;
    }
    state.nounset = flags.nounset;
    state.pipefail = flags.pipefail;
    state.errexit = flags.errexit;
    state.monitor = flags.monitor;
    state.noglob = flags.noglob;
    state.noexec = flags.noexec && !state.interactive;
    state.functrace = flags.functrace;
    state.errtrace = flags.errtrace;
    Ok(Outcome::status(0))
}

/// `set` options staged until every argument has been validated.
struct SetFlags {
    functrace: bool,
    errtrace: bool,
    nounset: bool,
    pipefail: bool,
    errexit: bool,
    monitor: bool,
    noglob: bool,
    noexec: bool,
}

fn set_option(option: &str, enabled: bool, flags: &mut SetFlags) -> Result<(), i32> {
    match option {
        "nounset" => flags.nounset = enabled,
        "pipefail" => flags.pipefail = enabled,
        "errexit" => flags.errexit = enabled,
        "monitor" => flags.monitor = enabled,
        "noglob" => flags.noglob = enabled,
        "noexec" => flags.noexec = enabled,
        "functrace" => flags.functrace = enabled,
        "errtrace" => flags.errtrace = enabled,
        _ => return Err(2),
    }
    Ok(())
}

async fn set_short_options(
    option: &str,
    enabled: bool,
    flags: &mut SetFlags,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    for flag in option[1..].bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        match flag {
            b'u' => flags.nounset = enabled,
            b'e' => flags.errexit = enabled,
            b'm' => flags.monitor = enabled,
            b'f' => flags.noglob = enabled,
            b'n' => flags.noexec = enabled,
            b'T' => flags.functrace = enabled,
            b'E' => flags.errtrace = enabled,
            _ => return Err(2),
        }
    }
    Ok(())
}

async fn declarations(
    name: &str,
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut args = args.iter().peekable();
    if name == "local" && state.borrow().function_calls == 0 {
        return Err(1);
    }
    let DeclarationOptions {
        print,
        function_names,
        inherit,
        nameref,
        readonly,
        exported,
        case,
    } = declaration_options(name, &mut args, context, work).await?;
    if function_names {
        return declarations::function_names(args, state, fds, context, work).await;
    }
    if print {
        return declarations::print(name, args, state, fds, context, work).await;
    }
    if inherit && (nameref || case.specified()) {
        return Err(2);
    }
    if nameref && (readonly || exported || case.specified()) {
        return Err(2);
    }
    if args.peek().is_none() && (nameref || matches!(name, "declare" | "typeset")) {
        return Err(2);
    }
    let mut status = 0;
    for arg in args {
        // A pending reference-IFS classification belongs to the binding before
        // a declaration retargets or shadows it. Finish it before mutation.
        State::admit_scalar_access(state, "IFS", &context.cancel, work)
            .await
            .map_err(error_status)?;
        for _ in arg.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(error_status)?;
        }
        let extended = nameref || matches!(name, "declare" | "typeset");
        if extended {
            work.admit_storage(arg.len()).map_err(error_status)?;
        }
        let (key, value, append) = match arg.split_once('=') {
            Some((key, value)) => (
                key.strip_suffix('+').unwrap_or(key).to_owned(),
                Some(value.to_owned()),
                key.ends_with('+'),
            ),
            None => (arg.to_owned(), None, false),
        };
        if !valid_name(&key) {
            if name == "local" {
                status = 1;
                continue;
            }
            return Err(2);
        }
        let local = name == "local"
            || matches!(name, "declare" | "typeset") && state.borrow().in_function_scope();
        let target =
            if append && local && !nameref && !inherit && state.borrow().is_current_local(&key) {
                declarations::local_append_target(key, state, context, work).await
            } else {
                Ok(key)
            };
        if target == Err(1) {
            status = 1;
            continue;
        }
        let key = target?;
        if extended || local {
            let storage = state
                .borrow()
                .declaration_storage(&key, local)
                .map_err(error_status)?;
            work.admit_storage(storage).map_err(error_status)?;
        }
        if nameref && append {
            return Err(2);
        }
        if nameref {
            let result = nameref_declaration(&key, value, local, state, context, work).await;
            status |= declaration_status(result)?;
            continue;
        }
        let value = if append {
            Some(
                declarations::append_scalar(
                    &key,
                    value.ok_or(2)?,
                    local,
                    inherit,
                    state,
                    context,
                    work,
                )
                .await?,
            )
        } else {
            value
        };
        if let Some(value) = &value
            && (!local || append && state.borrow().is_current_local(&key))
        {
            State::admit_assignment(state, &key, value.len(), &context.cancel, work)
                .await
                .map_err(error_status)?;
        }
        let key = if matches!(name, "export" | "readonly") {
            State::attribute_target(state, &key, name == "readonly", &context.cancel, work)
                .await
                .map_err(error_status)?
        } else {
            key
        };
        if inherit && value.is_none() && !state.borrow().is_current_local(&key) {
            let bytes = state
                .borrow()
                .declaration_append_base(&key, true, true)
                .map_or(0, str::len);
            scan_bytes(bytes, context, work).await?;
        }
        let result = if inherit {
            state
                .borrow_mut()
                .declare_inherited_local(key.clone(), value, work)
        } else if case.specified() {
            state
                .borrow_mut()
                .declare_case(key.clone(), value, local, case, work)
        } else {
            apply_declaration(name, &key, value, append, &mut state.borrow_mut())
        };
        if declaration_status(result)? == 0 {
            declaration_attributes(&key, exported, readonly, &mut state.borrow_mut())?;
            continue;
        }
        status = 1;
        if state.borrow().is_readonly(&key) {
            readonly_diagnostic(name, &key, fds, context).await?;
        }
    }
    Ok(Outcome::status(status))
}

fn declaration_status(result: Result<(), i32>) -> Result<i32, i32> {
    match result {
        Ok(()) => Ok(0),
        Err(code @ (2 | crate::exec::RESOURCE_STATUS)) => Err(code),
        Err(_) => Ok(1),
    }
}

fn declaration_attributes(
    key: &str,
    exported: bool,
    readonly: bool,
    state: &mut crate::state::State,
) -> Result<(), i32> {
    if exported {
        state.export(key.to_owned(), None)?;
    }
    if readonly {
        state.readonly(key.to_owned(), None)?;
    }
    Ok(())
}

#[derive(Default)]
struct DeclarationOptions {
    print: bool,
    function_names: bool,
    inherit: bool,
    nameref: bool,
    readonly: bool,
    exported: bool,
    case: crate::state::CaseOptions,
}

async fn declaration_options(
    name: &str,
    args: &mut std::iter::Peekable<std::slice::Iter<'_, String>>,
    context: &Context,
    work: &mut Work,
) -> Result<DeclarationOptions, i32> {
    let mut flags = DeclarationOptions::default();
    if !matches!(name, "local" | "declare" | "typeset") {
        return Ok(flags);
    }
    while let Some(option) = args.next_if(|arg| arg.starts_with(['-', '+'])) {
        if option == "--" {
            break;
        }
        declaration_option(name, option, &mut flags, context, work).await?;
    }
    Ok(flags)
}

async fn declaration_option(
    name: &str,
    option: &str,
    flags: &mut DeclarationOptions,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let enabled = option.starts_with('-');
    for flag in option[1..].bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        match flag {
            b'p' if enabled && name != "local" => flags.print = true,
            b'F' if enabled && name != "local" => flags.function_names = true,
            b'I' if enabled && name == "local" => flags.inherit = true,
            b'n' if enabled => flags.nameref = true,
            b'r' if enabled => flags.readonly = true,
            b'x' if enabled => flags.exported = true,
            b'l' | b'u' => flags.case.flag(flag == b'u', enabled),
            _ => return Err(2),
        }
    }
    Ok(())
}

async fn nameref_declaration(
    key: &str,
    value: Option<String>,
    local: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let target = match value {
        Some(value) => value,
        None => {
            let state = state.borrow();
            let target = state
                .namerefs()
                .get(key)
                .or_else(|| {
                    state
                        .raw_bindings()
                        .get(key)
                        .and_then(crate::state::Binding::scalar)
                })
                .ok_or(2)?;
            work.admit_storage(target.len()).map_err(error_status)?;
            target.clone()
        }
    };
    for _ in target.bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
    }
    if target.is_empty() || target == "PIPESTATUS" || key == "PIPESTATUS" {
        return Err(2);
    }
    let Some(reference) = crate::state::Reference::parse(&target) else {
        return Err(if target.contains(['[', ']']) { 2 } else { 1 });
    };
    // Special arrays have projected reads, not the ordinary element write
    // contract. Refuse their subscripted declarations before publishing a local.
    let unsupported = {
        let state = state.borrow();
        state.reference(reference).ok().is_some_and(|target| {
            target.subscript.is_some()
                && (target.name == "PIPESTATUS" || state.stack_array(target.name))
        })
    };
    if unsupported {
        return Err(2);
    }
    state
        .borrow_mut()
        .declare_nameref(key.to_owned(), target, local)
}

fn apply_declaration(
    name: &str,
    key: &str,
    value: Option<String>,
    append: bool,
    state: &mut crate::state::State,
) -> Result<(), i32> {
    if name == "readonly" {
        return state.readonly(key.to_owned(), value);
    }
    if name == "export" {
        return state.export(key.to_owned(), value);
    }
    let local =
        name == "local" || matches!(name, "declare" | "typeset") && state.in_function_scope();
    if local && (!append || !state.is_current_local(key)) {
        return state.declare_local(key.to_owned(), value);
    }
    if let Some(value) = value {
        state.assign_parameter(key.to_owned(), value)?;
    }
    Ok(())
}

/// `unset [-f] [-v] [-n] [--] name...`. Bash 5.3 ignores names that are not
/// identifiers. Without `-v` a name with no variable unsets a function.
/// `-n` removes the reference itself without following its target.
async fn unset(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut functions = false;
    let mut variables = false;
    let mut namerefs = false;
    let mut names = args.iter().peekable();
    while let Some(option) = names.next_if(|arg| arg.starts_with('-') && arg.len() > 1) {
        if option == "--" {
            break;
        }
        for flag in option[1..].chars() {
            match flag {
                'f' => functions = true,
                'v' => variables = true,
                'n' => namerefs = true,
                _ => {
                    let diagnostic = format!(
                        "/usr/bin/bash: unset: -{flag}: invalid option\nunset: usage: unset [-f] [-v] [-n] [name ...]\n"
                    );
                    diagnose(fds, &diagnostic, context).await?;
                    return Ok(Outcome::status(2));
                }
            }
        }
    }
    if functions && variables {
        diagnose(
            fds,
            "/usr/bin/bash: unset: cannot simultaneously unset a function and a variable\n",
            context,
        )
        .await?;
        return Ok(Outcome::status(1));
    }
    let mut code = 0;
    let mut budget = Budget::default();
    for name in names {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if crate::state::Reference::parse(name).is_none() {
            continue;
        }
        if functions {
            state.borrow_mut().unset_function(name);
            continue;
        }
        let removed = if namerefs {
            state.borrow_mut().unset_nameref(name)
        } else {
            let Some(place) = expand::references::removal_place(
                expand::references::syntax(name).map_err(error_status)?,
                state,
                &context.cancel,
                context.limits().expansion_bytes,
                work,
            )
            .await
            .map_err(error_status)?
            else {
                continue;
            };
            if let Some(index) = place.index {
                let existed = state.borrow().place_value(&place).is_some();
                let result = State::write_element(
                    state,
                    &place,
                    crate::state::BindingUpdate::Remove { index },
                    &context.cancel,
                    work,
                )
                .await;
                match result {
                    Ok(()) => Ok(existed),
                    Err(crate::exec::Error::Readonly { .. }) => Err(1),
                    Err(error) => return Err(error_status(error)),
                }
            } else {
                admit_unset_target(&place.name, state, context, work).await?;
                state
                    .borrow_mut()
                    .unset_selected(&place.name, name == "IFS")
            }
        };
        match removed {
            Err(_) => {
                let diagnostic =
                    format!("/usr/bin/bash: unset: {name}: cannot unset: readonly variable\n");
                diagnose(fds, &diagnostic, context).await?;
                code = 1;
            }
            Ok(false) if !variables && !namerefs => {
                state.borrow_mut().unset_function(name);
            }
            Ok(_) => {}
        }
    }
    Ok(Outcome::status(code))
}

async fn admit_unset_target(
    name: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    State::admit_scalar_access(state, name, &context.cancel, work)
        .await
        .map_err(error_status)?;
    let target_bytes = {
        let state = state.borrow();
        state
            .namerefs()
            .contains_key(name)
            .then(|| state.scalar_target(name))
            .transpose()?
            .flatten()
            .map_or(0, str::len)
    };
    work.admit_storage(target_bytes).map_err(error_status)
}

async fn diagnose(fds: &FdTable, diagnostic: &str, context: &Context) -> Result<(), i32> {
    if let Some(stderr) = fds.get(2) {
        stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    Ok(())
}

async fn readonly_diagnostic(
    builtin: &str,
    key: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    let diagnostic = format!("{builtin}: {key}: readonly variable\n");
    diagnose(fds, &diagnostic, context).await
}

async fn scan_bytes(bytes: usize, context: &Context, work: &mut Work) -> Result<(), i32> {
    for _ in 0..bytes {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
    }
    Ok(())
}
