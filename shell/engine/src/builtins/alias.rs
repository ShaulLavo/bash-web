use super::{diagnose, error_status, scan_bytes, write};
use crate::{
    expand::Work,
    interpreter::{Context, Outcome},
    io::FdTable,
    state::SharedState,
};

const ALIAS_USAGE: &str = "alias: usage: alias [-p] [name[=value] ... ]\n";
const UNALIAS_USAGE: &str = "unalias: usage: unalias [-a] name [name ...]\n";

pub(super) async fn run(
    name: &str,
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    for arg in args {
        scan_bytes(arg.len(), context, work).await?;
    }
    let (index, flag) = match options(name, args) {
        Ok(options) => options,
        Err(ch) => {
            let usage = if name == "alias" { ALIAS_USAGE } else { UNALIAS_USAGE };
            diagnose(fds, &format!("{name}: -{ch}: invalid option\n{usage}"), context).await?;
            return Err(2);
        }
    };
    let args = &args[index..];
    if name == "unalias" {
        return remove(args, flag, state, fds, context, work).await;
    }
    if args.is_empty() || flag {
        list(state, fds, context, work).await?;
        return Ok(Outcome::status(0));
    }
    let mut status = 0;
    for arg in args {
        status |= operand(arg, state, fds, context, work).await?;
    }
    Ok(Outcome::status(status))
}

fn options(name: &str, args: &[String]) -> Result<(usize, bool), char> {
    let expected = if name == "alias" { 'p' } else { 'a' };
    let mut index = 0;
    let mut flag = false;
    while let Some(arg) = args.get(index) {
        if arg == "--" {
            return Ok((index + 1, flag));
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        if let Some(ch) = arg[1..].chars().find(|&ch| ch != expected) {
            return Err(ch);
        }
        flag = true;
        index += 1;
    }
    Ok((index, flag))
}

async fn operand(
    arg: &str,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    if let Some((name, value)) = arg.split_once('=')
        && !name.is_empty()
    {
        if name.contains([
            '/', '$', '`', '\\', '\'', '"', '=', ' ', '\t', '\n', '|', '&', ';', '(', ')', '<', '>',
        ]) {
            diagnose(
                fds,
                &format!("alias: `{name}': invalid alias name\n"),
                context,
            )
            .await?;
            return Ok(1);
        }
        let aliases = state.borrow().aliases();
        scan_bytes(aliases.bytes(), context, work).await?;
        state.borrow_mut().update_alias(name, Some(value))?;
        return Ok(0);
    }
    let aliases = state.borrow().aliases();
    if let Some(value) = aliases.values().and_then(|values| values.get(arg)) {
        print(arg, value, fds, context, work).await?;
        return Ok(0);
    }
    diagnose(fds, &format!("alias: {arg}: not found\n"), context).await?;
    Ok(1)
}

async fn list(
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let aliases = state.borrow().aliases();
    let Some(values) = aliases.values() else {
        return Ok(());
    };
    scan_bytes(aliases.bytes(), context, work).await?;
    work.admit_storage(values.len().saturating_mul(std::mem::size_of::<&String>()))
        .map_err(error_status)?;
    let mut names: Vec<_> = values.keys().collect();
    names.sort_unstable();
    for name in names {
        print(name, &values[name], fds, context, work).await?;
    }
    Ok(())
}

async fn print(
    name: &str,
    value: &str,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    scan_bytes(name.len().saturating_add(value.len()), context, work).await?;
    write(
        fds,
        if name.starts_with('-') {
            b"alias -- "
        } else {
            b"alias "
        },
        context,
    )
    .await?;
    write(fds, name.as_bytes(), context).await?;
    write(fds, b"=", context).await?;
    let mut parts = value.split('\'').peekable();
    let mut first = true;
    while let Some(part) = parts.next() {
        if !part.is_empty() || (!first && parts.peek().is_some()) || value.is_empty() {
            write(fds, b"'", context).await?;
            write(fds, part.as_bytes(), context).await?;
            write(fds, b"'", context).await?;
        }
        if parts.peek().is_some() {
            write(fds, b"\\'", context).await?;
        }
        first = false;
    }
    write(fds, b"\n", context).await
}

async fn remove(
    args: &[String],
    all: bool,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if all {
        state.borrow_mut().clear_aliases();
        return Ok(Outcome::status(0));
    }
    if args.is_empty() {
        diagnose(fds, UNALIAS_USAGE, context).await?;
        return Err(2);
    }
    let mut status = 0;
    for arg in args {
        let aliases = state.borrow().aliases();
        scan_bytes(aliases.bytes(), context, work).await?;
        if aliases
            .values()
            .is_some_and(|values| values.contains_key(arg))
        {
            state.borrow_mut().update_alias(arg, None)?;
            continue;
        }
        diagnose(fds, &format!("unalias: {arg}: not found\n"), context).await?;
        status = 1;
    }
    Ok(Outcome::status(status))
}
