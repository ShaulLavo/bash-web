//! Type classification adapted from Bashkit introspect.rs at the pinned revision.
//! Catalogue, descriptors, bounded PATH scan and AST rendering keep local owners.
use super::*;
use command_builtin::{LookupWork, Resolution, diagnostic, output};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Describe,
    Type,
    Path,
}
struct Options {
    mode: Mode,
    force_path: bool,
    all: bool,
    no_functions: bool,
    operands: usize,
}
impl Options {
    fn flag(&mut self, flag: u8) -> bool {
        match flag {
            b't' => self.mode = Mode::Type,
            b'p' => self.mode = Mode::Path,
            b'P' => {
                self.mode = Mode::Path;
                self.force_path = true;
            }
            b'a' => self.all = true,
            b'f' => self.no_functions = true,
            _ => return false,
        }
        true
    }
}
async fn options(
    args: &[String],
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Options, i32> {
    let mut options = Options {
        mode: Mode::Describe,
        force_path: false,
        all: false,
        no_functions: false,
        operands: 0,
    };
    for arg in args {
        if arg == "--" {
            options.operands += 1;
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        flags(arg, &mut options, fds, context, work).await?;
        options.operands += 1;
    }
    Ok(options)
}
async fn flags(
    arg: &str,
    options: &mut Options,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), i32> {
    for flag in arg[1..].bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(admission_status)?;
        if options.flag(flag) {
            continue;
        }
        diagnostic(
            fds,
            context,
            b"type: invalid option\ntype: usage: type [-afptP] name [name ...]\n",
        )
        .await?;
        return Err(2);
    }
    Ok(())
}

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Outcome, i32> {
    let options = options(args, fds, context, work).await?;
    let mut lookup = LookupWork::new(context.limits());
    let mut all_found = true;
    for name in &args[options.operands..] {
        for _ in name.bytes() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(admission_status)?;
        }
        let found = describe(name, &options, state, fds, context, work, &mut lookup).await?;
        all_found &= found;
        if !found && options.mode == Mode::Describe {
            diagnostic(fds, context, b"type: ").await?;
            diagnostic(fds, context, name.as_bytes()).await?;
            diagnostic(fds, context, b": not found\n").await?;
        }
    }
    Ok(Outcome::status(i32::from(!all_found)))
}

async fn classification(
    name: &str,
    kind: &str,
    mode: Mode,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), i32> {
    if mode == Mode::Path {
        return Ok(());
    }
    if mode == Mode::Type {
        output(fds, context, kind.as_bytes()).await?;
        return output(fds, context, b"\n").await;
    }
    output(fds, context, name.as_bytes()).await?;
    output(fds, context, b" is ").await?;
    let description = match kind {
        "keyword" => "a shell keyword\n",
        "builtin" => "a shell builtin\n",
        _ => "a function\n",
    };
    output(fds, context, description.as_bytes()).await
}

async fn shell_classifications(
    name: &str,
    options: &Options,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<bool, i32> {
    if options.force_path {
        return Ok(false);
    }
    let command = commands::lookup(name);
    let mut found = false;
    if command.is_some_and(commands::Command::query_keyword) {
        classification(name, "keyword", options.mode, fds, context).await?;
        found = true;
    }
    if found && !options.all {
        return Ok(true);
    }
    let function = state.borrow().functions().get(name).cloned();
    if let Some(function) = function.filter(|_| !options.no_functions) {
        classification(name, "function", options.mode, fds, context).await?;
        if options.mode == Mode::Describe {
            command_builtin::function_description(name, &function, fds, context, work).await?;
        }
        found = true;
    }
    if found && !options.all {
        return Ok(true);
    }
    if command.is_some_and(commands::Command::query_builtin) {
        classification(name, "builtin", options.mode, fds, context).await?;
        found = true;
    }
    Ok(found)
}

async fn describe(
    name: &str,
    options: &Options,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
    lookup: &mut LookupWork,
) -> Result<bool, i32> {
    let mut found = shell_classifications(name, options, state, fds, context, work).await?;
    if found && !options.all {
        return Ok(true);
    }
    let mut search =
        command_builtin::ExecutableSearch::new(name, state, false, None, context, lookup)?;
    loop {
        let resolution = search.next(name, context, lookup).await?;
        let path = match resolution {
            Resolution::Executable(path) => path,
            Resolution::NonExecutable(path, _) if !options.all && !name.contains('/') => path,
            _ => return Ok(found),
        };
        file(name, path, options.mode, fds, context).await?;
        found = true;
        if !options.all || name.contains('/') {
            return Ok(true);
        }
    }
}
async fn file(
    name: &str,
    path: command_builtin::PathString,
    mode: Mode,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), i32> {
    if mode == Mode::Type {
        return output(fds, context, b"file\n").await;
    }
    if mode == Mode::Describe {
        output(fds, context, name.as_bytes()).await?;
        output(fds, context, b" is ").await?;
    }
    output(fds, context, path.text.as_bytes()).await?;
    output(fds, context, b"\n").await
}
