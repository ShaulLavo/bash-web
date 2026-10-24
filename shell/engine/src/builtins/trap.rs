//! Original Bash-compatible registration and query. No event or signal runs an action.
use super::{diagnose, error_status, scan_bytes, write};
use crate::{
    expand::Work,
    interpreter::{Context, Outcome},
    io::FdTable,
    state::{
        SharedState,
        traps::{Action, Binding, SLOTS},
    },
};
use std::{mem::size_of, rc::Rc};
const USAGE: &str = "trap: usage: trap [-Plp] [[action] signal_spec ...]\n";
pub(super) const NAMES: [&str; SLOTS] = [
    "EXIT",
    "SIGHUP",
    "SIGINT",
    "SIGQUIT",
    "SIGILL",
    "SIGTRAP",
    "SIGABRT",
    "SIGBUS",
    "SIGFPE",
    "SIGKILL",
    "SIGUSR1",
    "SIGSEGV",
    "SIGUSR2",
    "SIGPIPE",
    "SIGALRM",
    "SIGTERM",
    "SIGSTKFLT",
    "SIGCHLD",
    "SIGCONT",
    "SIGSTOP",
    "SIGTSTP",
    "SIGTTIN",
    "SIGTTOU",
    "SIGURG",
    "SIGXCPU",
    "SIGXFSZ",
    "SIGVTALRM",
    "SIGPROF",
    "SIGWINCH",
    "SIGIO",
    "SIGPWR",
    "SIGSYS",
    "32",
    "33",
    "SIGRTMIN",
    "SIGRTMIN+1",
    "SIGRTMIN+2",
    "SIGRTMIN+3",
    "SIGRTMIN+4",
    "SIGRTMIN+5",
    "SIGRTMIN+6",
    "SIGRTMIN+7",
    "SIGRTMIN+8",
    "SIGRTMIN+9",
    "SIGRTMIN+10",
    "SIGRTMIN+11",
    "SIGRTMIN+12",
    "SIGRTMIN+13",
    "SIGRTMIN+14",
    "SIGRTMIN+15",
    "SIGRTMAX-14",
    "SIGRTMAX-13",
    "SIGRTMAX-12",
    "SIGRTMAX-11",
    "SIGRTMAX-10",
    "SIGRTMAX-9",
    "SIGRTMAX-8",
    "SIGRTMAX-7",
    "SIGRTMAX-6",
    "SIGRTMAX-5",
    "SIGRTMAX-4",
    "SIGRTMAX-3",
    "SIGRTMAX-2",
    "SIGRTMAX-1",
    "SIGRTMAX",
    "DEBUG",
    "ERR",
    "RETURN",
];
fn signal_number(text: &str) -> Option<usize> {
    let number = text.trim_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']);
    usize::try_from(number.parse::<i64>().ok()?).ok()
}
fn signal(name: &str) -> Option<usize> {
    if let Some(number) = signal_number(name) {
        return (number <= 64).then_some(number);
    }
    let prefixed = name.get(..3).is_some_and(|s| s.eq_ignore_ascii_case("SIG"));
    let bare = if prefixed { &name[3..] } else { name };
    if bare
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("RTMIN+"))
    {
        return signal_number(&bare[6..])
            .filter(|&n| n <= 30)
            .map(|n| n + 34);
    }
    NAMES
        .iter()
        .position(|candidate| match candidate.strip_prefix("SIG") {
            Some(signal) => signal.eq_ignore_ascii_case(bare),
            None => !prefixed && candidate.eq_ignore_ascii_case(name),
        })
}
#[derive(Default)]
struct Options {
    print: bool,
    action: bool,
    list: bool,
    operands: usize,
}
async fn options(args: &[String], fds: &FdTable, context: &Context) -> Result<Options, i32> {
    let mut options = Options::default();
    for arg in args {
        if arg == "--" {
            options.operands += 1;
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        if let Some(ch) = arg[1..].chars().find(|&ch| !option(ch, &mut options)) {
            return invalid_option(ch, fds, context).await;
        }
        options.operands += 1;
    }
    Ok(options)
}
fn option(ch: char, options: &mut Options) -> bool {
    match ch {
        'p' => options.print = true,
        'P' => options.action = true,
        'l' => options.list = true,
        _ => return false,
    }
    true
}
async fn invalid_option(ch: char, fds: &FdTable, context: &Context) -> Result<Options, i32> {
    diagnose(
        fds,
        &format!("trap: -{ch}: invalid option\n{USAGE}"),
        context,
    )
    .await?;
    Err(2)
}
pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    for arg in args {
        scan_bytes(arg.len(), context, work).await?;
    }
    let options = options(args, fds, context).await?;
    let args = &args[options.operands..];
    if options.print && options.action {
        diagnose(fds, "trap: cannot specify both -p and -P\n", context).await?;
        return Err(2);
    }
    if options.action && args.is_empty() {
        diagnose(fds, "trap: -P requires at least one signal name\n", context).await?;
        return Err(2);
    }
    if options.list {
        return list(fds, context).await;
    }
    if args.is_empty() || options.print || options.action {
        return query(args, options.action, state, fds, context, work).await;
    }
    let reset = args[0] == "-"
        || !args[0].is_empty()
            && args[0].bytes().all(|b| b.is_ascii_digit())
            && signal(&args[0]).is_some()
        || args.len() == 1 && signal(&args[0]).is_some();
    let operands = if reset && args[0] != "-" {
        args
    } else {
        &args[1..]
    };
    if operands.is_empty() {
        diagnose(fds, USAGE, context).await?;
        return Err(2);
    }
    let binding = binding(&args[0], reset, state)?;
    state.borrow_mut().traps.prepare_mutation();
    let mut code = 0;
    for operand in operands {
        let Some(signal) = signal(operand) else {
            invalid_signal(operand, fds, context).await?;
            code = 1;
            continue;
        };
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        state.borrow_mut().traps.set(signal, binding.clone());
    }
    Ok(Outcome::status(code))
}
fn binding(text: &str, reset: bool, state: &SharedState) -> Result<Option<Binding>, i32> {
    if reset {
        return Ok(None);
    }
    if text.is_empty() {
        return Ok(Some(Binding::Ignored));
    }
    let bytes = text
        .len()
        .checked_add(size_of::<Action>() + size_of::<usize>() * 2)
        .ok_or(2)?;
    let storage = state.borrow().admit_temporary(bytes)?;
    Ok(Some(Binding::Handler(Rc::new(Action {
        text: text.to_owned(),
        _storage: storage,
    }))))
}
async fn invalid_signal(name: &str, fds: &FdTable, context: &Context) -> Result<(), i32> {
    diagnose(fds, "trap: ", context).await?;
    diagnose(fds, name, context).await?;
    diagnose(fds, ": invalid signal specification\n", context).await
}
async fn query(
    args: &[String],
    action_only: bool,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if args.is_empty() {
        for signal in 0..SLOTS {
            print(signal, action_only, state, fds, context, work).await?;
        }
        return Ok(Outcome::status(0));
    }
    let mut code = 0;
    for name in args {
        let Some(signal) = signal(name) else {
            invalid_signal(name, fds, context).await?;
            code = 1;
            continue;
        };
        print(signal, action_only, state, fds, context, work).await?;
    }
    Ok(Outcome::status(code))
}
async fn print(
    signal: usize,
    action_only: bool,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    work.checkpoint(&context.cancel)
        .await
        .map_err(error_status)?;
    let binding = state.borrow().traps.get(signal).cloned();
    let Some(binding) = binding else {
        return Ok(());
    };
    let text = match &binding {
        Binding::Ignored => "",
        Binding::Handler(action) => &action.text,
    };
    scan_bytes(text.len(), context, work).await?;
    work.admit_storage(
        text.len()
            .checked_mul(4)
            .and_then(|n| n.checked_add(64))
            .ok_or(2)?,
    )
    .map_err(error_status)?;
    let output = if action_only {
        format!("{text}\n")
    } else if text == "'" {
        format!("trap -- \\' {}\n", NAMES[signal])
    } else {
        format!(
            "trap -- '{}' {}\n",
            text.replace('\'', "'\\''"),
            NAMES[signal]
        )
    };
    write(fds, output.as_bytes(), context).await
}
async fn list(fds: &FdTable, context: &Context) -> Result<Outcome, i32> {
    let mut column = 0;
    for (number, name) in NAMES.iter().enumerate().take(65).skip(1) {
        if number == 32 || number == 33 {
            continue;
        }
        column += 1;
        let separator = if column % 5 == 0 { '\n' } else { '\t' };
        write(
            fds,
            format!("{number:2}) {name}{separator}").as_bytes(),
            context,
        )
        .await?;
    }
    write(fds, b"\n", context).await?;
    Ok(Outcome::status(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{exec::StorageBudget, state::State};

    #[test]
    fn rejected_action_admission_preserves_binding_and_reset_refunds_storage() {
        let budget = StorageBudget::new(256);
        let state = State::with_memory(budget.clone()).shared();
        let original = binding("echo original", false, &state).unwrap();
        state.borrow_mut().traps.set(0, original);
        let held = budget.observation().0;
        assert!(binding(&"x".repeat(256), false, &state).is_err());
        assert_eq!(budget.observation().0, held);
        let snapshot = state.borrow().traps.inherited();
        let Some(Binding::Handler(action)) = snapshot.get(0).cloned() else {
            panic!("snapshot lost the inherited handler");
        };
        assert_eq!(action.text, "echo original");
        drop(action);
        state.borrow_mut().traps.set(0, None);
        assert_eq!(budget.observation().0, held);
        drop(snapshot);
        assert_eq!(budget.observation().0, 0);
        assert!(binding("echo recovered", false, &state).is_ok());
        assert_eq!(budget.observation().0, 0);
    }
}
