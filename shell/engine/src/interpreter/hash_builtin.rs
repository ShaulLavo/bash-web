//! Explicit hash operations never execute a path or infer executable permission.
use super::*;
use crate::state::command_hash::Entry;
use command_builtin::{LookupWork, Resolution, diagnostic, output};

#[derive(Clone, Copy)]
enum Action<'a> {
    Lookup,
    Delete,
    Query,
    Set(&'a str),
}
struct Options<'a> {
    action: Action<'a>,
    list: bool,
    reset: bool,
    operands: &'a [String],
}
pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<i32, i32> {
    work.checkpoint(&context.cancel)
        .await
        .map_err(admission_status)?;
    let options = match options(args, context, work).await {
        Ok(options) => options,
        Err(code) => {
            diagnostic(fds, context, b"hash: invalid option or argument\nhash: usage: hash [-lr] [-p pathname] [-dt] [name ...]\n").await?;
            return Err(code);
        }
    };
    if options.reset {
        let table = state.borrow().command_hash.clone();
        let empty = table
            .cleared(&context.cancel, work)
            .await
            .map_err(admission_status)?;
        state.borrow_mut().command_hash = empty;
    }
    if options.operands.is_empty() {
        if options.reset {
            return Ok(0);
        }
        return list(&options, state, fds, context, work).await;
    }
    let mut status = 0;
    let mut lookup = LookupWork::new(context.limits());
    for name in options.operands {
        status |= operate(name, &options, state, fds, context, work, &mut lookup).await?;
    }
    Ok(status)
}

async fn options<'a>(
    args: &'a [String],
    context: &Context,
    work: &mut expand::Work,
) -> Result<Options<'a>, i32> {
    for arg in args {
        scan(arg, context, work).await?;
    }
    let mut result = Options {
        action: Action::Lookup,
        list: false,
        reset: false,
        operands: &[],
    };
    let mut cursor = 0;
    while let Some(arg) = args.get(cursor) {
        cursor += 1;
        if arg == "--" {
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            cursor -= 1;
            break;
        }
        parse_flags(&arg[1..], args, &mut cursor, &mut result)?;
    }
    result.operands = &args[cursor..];
    Ok(result)
}
fn parse_flags<'a>(
    flags: &'a str,
    args: &'a [String],
    cursor: &mut usize,
    options: &mut Options<'a>,
) -> Result<(), i32> {
    let (switches, pathname) = flags
        .split_once('p')
        .map_or((flags, None), |(head, tail)| (head, Some(tail)));
    for flag in switches.bytes() {
        match flag {
            b'r' => options.reset = true,
            b'l' => options.list = true,
            b'd' => options.action = Action::Delete,
            b't' => options.action = Action::Query,
            _ => return Err(2),
        }
    }
    if let Some(path) = pathname {
        let path = if path.is_empty() {
            *cursor += 1;
            args.get(*cursor - 1).ok_or(2)?
        } else {
            path
        };
        options.action = Action::Set(path);
    }
    Ok(())
}
async fn scan(text: &str, context: &Context, work: &mut expand::Work) -> Result<(), i32> {
    for _ in text.bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(admission_status)?;
    }
    Ok(())
}
async fn change(
    name: &str,
    path: Option<&str>,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    let table = state.borrow().command_hash.clone();
    let updated = table
        .updated(name, path, state, &context.cancel, work)
        .await
        .map_err(admission_status)?;
    state.borrow_mut().command_hash = updated;
    Ok(())
}
async fn missing(name: &str, fds: &Descriptors, context: &Context) -> Result<i32, i32> {
    diagnostic(fds, context, b"hash: ").await?;
    diagnostic(fds, context, name.as_bytes()).await?;
    diagnostic(fds, context, b": not found\n").await?;
    Ok(1)
}
async fn operate(
    name: &str,
    options: &Options<'_>,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
    lookup: &mut LookupWork,
) -> Result<i32, i32> {
    match options.action {
        Action::Set(path) => {
            if name.contains('/') || path.is_empty() {
                return Ok(0);
            }
            change(name, Some(path), state, context, work).await?;
            Ok(0)
        }
        Action::Query | Action::Delete => {
            query_name(name, options, state, fds, context, work).await
        }
        Action::Lookup => lookup_name(name, state, fds, context, work, lookup).await,
    }
}
async fn query_name(
    name: &str,
    options: &Options<'_>,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<i32, i32> {
    let Some(entry) = command_builtin::hashed(name, state, context, work).await? else {
        return missing(name, fds, context).await;
    };
    if matches!(options.action, Action::Delete) {
        change(name, None, state, context, work).await?;
        return Ok(0);
    }
    print(
        &entry,
        options.list,
        false,
        options.operands.len() > 1,
        fds,
        context,
        work,
    )
    .await?;
    Ok(0)
}

async fn lookup_name(
    name: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
    lookup: &mut LookupWork,
) -> Result<i32, i32> {
    if name.contains('/') {
        return Ok(0);
    }
    if commands::lookup(name).is_some_and(commands::Command::query_builtin)
        || state.borrow().functions().contains_key(name)
    {
        return Ok(0);
    }
    let resolution = command_builtin::executable(name, state, false, None, context, lookup).await?;
    if let Resolution::Executable(path) = resolution {
        change(name, Some(&path.text), state, context, work).await?;
        return Ok(0);
    }
    change(name, None, state, context, work).await?;
    missing(name, fds, context).await
}
async fn list(
    options: &Options<'_>,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<i32, i32> {
    let table = state.borrow().command_hash.clone();
    if table.entries().is_empty() {
        if !options.list {
            output(fds, context, b"hash: hash table empty\n").await?;
        }
        return Ok(0);
    }
    if !options.list {
        output(fds, context, b"hits\tcommand\n").await?;
    }
    for entry in table.entries() {
        print(entry, options.list, true, false, fds, context, work).await?;
    }
    Ok(0)
}
async fn print(
    entry: &Entry,
    reusable: bool,
    table: bool,
    names: bool,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    scan(&entry.name, context, work).await?;
    scan(&entry.path, context, work).await?;
    if reusable {
        output(fds, context, b"builtin hash -p ").await?;
        print_path(&entry.path, table, fds, context).await?;
        output(fds, context, b" ").await?;
        output(fds, context, entry.name.as_bytes()).await?;
        return output(fds, context, b"\n").await;
    }
    if table {
        output(fds, context, b"   0\t").await?;
    }
    if names {
        output(fds, context, entry.name.as_bytes()).await?;
        output(fds, context, b"\t").await?;
    }
    output(fds, context, entry.path.as_bytes()).await?;
    output(fds, context, b"\n").await
}
async fn print_path(
    path: &str,
    quote: bool,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), i32> {
    let quote = quote
        && path
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && !b"_+,-./:=@%".contains(&b));
    if !quote {
        return output(fds, context, path.as_bytes()).await;
    }
    output(fds, context, b"'").await?;
    let mut pieces = path.split('\'');
    output(fds, context, pieces.next().unwrap_or_default().as_bytes()).await?;
    for piece in pieces {
        output(fds, context, b"'\\''").await?;
        output(fds, context, piece.as_bytes()).await?;
    }
    output(fds, context, b"'").await
}
