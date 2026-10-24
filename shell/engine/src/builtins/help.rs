use super::{diagnose, error_status, scan_bytes, write};
use crate::{
    commands::{self, Builtin, Command, Handler},
    expand::{Work, pattern::Pattern},
    interpreter::{Context, Outcome},
    io::FdTable,
    state::SharedState,
};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Mode {
    Full,
    Synopsis,
    Manual,
    Description,
}

struct Topic {
    command: &'static Command,
    operands: &'static str,
    description: &'static str,
}

fn topic(command: &'static Command) -> Option<Topic> {
    let (operands, description) = match command.handler()? {
        Handler::Command => (
            " [-pvV] command [arg ...]",
            "Run or describe a command without function lookup.",
        ),
        Handler::BuiltinWrapper => (
            " [shell-builtin [arg ...]]",
            "Run a shell builtin without function lookup.",
        ),
        Handler::Type => (
            " [-afptP] name [name ...]",
            "Describe how command names resolve.",
        ),
        Handler::Exec => (
            " [command [arg ...]]",
            "Replace the shell command or apply redirections.",
        ),
        Handler::Eval => (
            " [arg ...]",
            "Join arguments and execute them as shell input.",
        ),
        Handler::Let => (
            " expression [expression ...]",
            "Evaluate arithmetic expressions.",
        ),
        Handler::Builtin(builtin) => builtin_topic(builtin, command.name),
    };
    Some(Topic {
        command,
        operands,
        description,
    })
}

fn builtin_topic(builtin: Builtin, name: &str) -> (&'static str, &'static str) {
    match builtin {
        Builtin::Help => (
            " [-dms] [pattern ...]",
            "Display information about builtin commands.",
        ),
        Builtin::Noop if name == ":" => ("", "Null command."),
        Builtin::Noop => ("", "Return a successful result."),
        Builtin::False => ("", "Return an unsuccessful result."),
        Builtin::Echo => (" [-neE] [arg ...]", "Write arguments to standard output."),
        Builtin::Printf => (
            " [-v var] format [arg ...]",
            "Format and write arguments or assign the result to a variable.",
        ),
        Builtin::Read => (" [options] [name ...]", "Read input into shell variables."),
        Builtin::Getopts => (" optstring name [arg ...]", "Parse option arguments."),
        Builtin::Caller => (" [index]", "Display a shell function call frame."),
        Builtin::Trap => (
            " [options] [action signal ...]",
            "Register or display shell traps.",
        ),
        Builtin::Declaration => (
            " [options] [name[=value] ...]",
            "Set or display variable and function attributes.",
        ),
        Builtin::Cd => (" [options] [dir]", "Change the current directory."),
        Builtin::Pwd => ("", "Print the current directory."),
        Builtin::Pushd => (
            " [-n] [+N | -N | dir]",
            "Add or rotate a directory on the directory stack.",
        ),
        Builtin::Popd => (
            " [-n] [+N | -N]",
            "Remove a directory from the directory stack.",
        ),
        Builtin::Dirs => (
            " [-clpv] [+N | -N]",
            "Display or clear the directory stack.",
        ),
        Builtin::Set => (
            " [options] [--] [arg ...]",
            "Set shell options or positional parameters.",
        ),
        Builtin::Shift => (" [n]", "Remove leading positional parameters."),
        Builtin::Shopt => (
            " [-pqsu] [-o] [name ...]",
            "Set or display shell option values.",
        ),
        Builtin::Alias if name == "unalias" => (" [-a] [name ...]", "Remove alias definitions."),
        Builtin::Alias => (
            " [-p] [name[=value] ...]",
            "Set or display alias definitions.",
        ),
        Builtin::ExitReturn if name == "return" => {
            (" [n]", "Return from the current shell function.")
        }
        Builtin::ExitReturn => (" [n]", "Exit the shell with a status."),
        Builtin::Jobs => ("", "List shell jobs."),
        Builtin::Wait => (" [job]", "Wait for a shell job to finish."),
        Builtin::Kill => (" [signal-option] job", "Signal a shell job."),
        Builtin::Unset => (" [-fvn] [name ...]", "Remove shell variables or functions."),
        Builtin::Test if name == "[" => (" [expression] ]", "Evaluate a conditional expression."),
        Builtin::Test => (" [expression]", "Evaluate a conditional expression."),
        Builtin::LoopControl if name == "break" => (" [n]", "Leave enclosing loops."),
        Builtin::LoopControl => (" [n]", "Continue the next iteration of enclosing loops."),
        Builtin::Completion => (
            " [options] [word ...]",
            "Generate or configure shell completion candidates.",
        ),
    }
}

async fn parts(
    values: &[&str],
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    for value in values {
        scan_bytes(value.len(), context, work).await?;
        write(fds, value.as_bytes(), context).await?;
    }
    Ok(())
}

async fn display(
    topic: &Topic,
    mode: Mode,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let name = topic.command.name;
    let operands = topic.operands;
    let description = topic.description;
    let values: &[&str] = match mode {
        Mode::Synopsis => &[name, ": ", name, operands, "\n"],
        Mode::Description => &[name, " - ", description, "\n"],
        Mode::Full => &[name, ": ", name, operands, "\n    ", description, "\n"],
        Mode::Manual => &[
            "NAME\n    ",
            name,
            " - ",
            description,
            "\n\nSYNOPSIS\n    ",
            name,
            operands,
            "\n\nDESCRIPTION\n    ",
            description,
            "\n\nIMPLEMENTATION\n    bash-web\n",
        ],
    };
    parts(values, fds, context, work).await
}

fn option(flag: char) -> Result<Mode, char> {
    match flag {
        's' => Ok(Mode::Synopsis),
        'm' => Ok(Mode::Manual),
        'd' => Ok(Mode::Description),
        _ => Err(flag),
    }
}

async fn options(
    args: &[String],
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(Mode, usize), i32> {
    if args.first().is_some_and(|arg| arg == "--help") {
        let help = topic(commands::lookup("help").ok_or(1)?).ok_or(1)?;
        display(&help, Mode::Full, fds, context, work).await?;
        return Err(2);
    }
    let mut mode = Mode::Full;
    for (index, arg) in args.iter().enumerate() {
        scan_bytes(arg.len(), context, work).await?;
        if arg == "--" {
            return Ok((mode, index + 1));
        }
        if arg == "-" || !arg.starts_with('-') {
            return Ok((mode, index));
        }
        mode = parse_flags(arg, mode, fds, context).await?;
    }
    Ok((mode, args.len()))
}

async fn parse_flags(
    arg: &str,
    mut mode: Mode,
    fds: &FdTable,
    context: &Context,
) -> Result<Mode, i32> {
    for flag in arg[1..].chars() {
        let Ok(selected) = option(flag) else {
            diagnose(
                fds,
                &format!("help: -{flag}: invalid option\nhelp: usage: help [-dms] [pattern ...]\n"),
                context,
            )
            .await?;
            return Err(2);
        };
        mode = mode.max(selected);
    }
    Ok(mode)
}

async fn query(
    text: &str,
    topics: &[Topic],
    mode: Mode,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    let exact = topics.iter().any(|topic| topic.command.name == text);
    let prefix = topics
        .iter()
        .any(|topic| topic.command.name.starts_with(text));
    let mut pattern = Pattern::literal(text, state, work, &context.cancel)
        .await
        .map_err(error_status)?;
    if !prefix && text.contains(['*', '?', '[']) {
        parts(
            &["Shell commands matching keyword `", text, "'\n\n"],
            fds,
            context,
            work,
        )
        .await?;
    }
    let mut found = false;
    for topic in topics {
        let matches = if exact {
            topic.command.name == text
        } else if prefix {
            topic.command.name.starts_with(text)
        } else {
            pattern
                .matches_full(topic.command.name, work, &context.cancel)
                .await
                .map_err(error_status)?
        };
        if matches {
            display(topic, mode, fds, context, work).await?;
            found = true;
        }
    }
    Ok(found)
}

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let (mode, start) = options(args, fds, context, work).await?;
    work.admit_storage(
        commands::catalogue()
            .len()
            .saturating_mul(std::mem::size_of::<Topic>()),
    )
    .map_err(error_status)?;
    let mut topics: Vec<_> = commands::catalogue().iter().filter_map(topic).collect();
    topics.sort_unstable_by_key(|topic| topic.command.name);
    if start == args.len() {
        parts(&["bash-web shell builtins\nUse 'help name' for a topic. Options: -d description, -m manual, -s synopsis.\n"], fds, context, work).await?;
        for topic in &topics {
            parts(
                &[topic.command.name, topic.operands, "\n"],
                fds,
                context,
                work,
            )
            .await?;
        }
        return Ok(Outcome::status(0));
    }
    let mut found = false;
    for text in &args[start..] {
        found |= query(text, &topics, mode, state, fds, context, work).await?;
    }
    if !found {
        work.admit_storage(args.last().ok_or(1)?.len().saturating_add(40))
            .map_err(error_status)?;
        diagnose(
            fds,
            &format!("help: no help topics match `{}'.\n", args.last().ok_or(1)?),
            context,
        )
        .await?;
    }
    Ok(Outcome::status(if found { 0 } else { 1 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_exactly_the_executable_builtin_catalogue() {
        for command in commands::catalogue() {
            assert_eq!(
                topic(command).is_some(),
                command.query_builtin(),
                "{}",
                command.name
            );
        }
    }
}
