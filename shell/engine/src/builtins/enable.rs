use super::*;

#[derive(Default)]
struct Options {
    all: bool,
    disabled: bool,
    print: bool,
    special: bool,
    operands: usize,
}
impl Options {
    fn flag(&mut self, flag: u8) -> Result<(), i32> {
        match flag {
            b'a' => self.all = true,
            b'n' => self.disabled = true,
            b'p' => self.print = true,
            b's' => self.special = true,
            _ => return Err(2),
        }
        Ok(())
    }
}

async fn options(args: &[String], context: &Context, work: &mut Work) -> Result<Options, i32> {
    let mut options = Options::default();
    while let Some(arg) = args.get(options.operands) {
        if arg == "--" {
            options.operands += 1;
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        flags(arg, &mut options, context, work).await?;
        options.operands += 1;
    }
    Ok(options)
}

async fn flags(
    arg: &str,
    options: &mut Options,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    for flag in arg[1..].bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        options.flag(flag)?;
    }
    Ok(())
}

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let options = options(args, context, work).await?;
    if options.print || options.operands == args.len() {
        let disabled = state.borrow().disabled_builtins;
        list(&options, disabled, fds, context, work).await?;
        return Ok(0);
    }
    let mut status = 0;
    for name in &args[options.operands..] {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if commands::set_enabled(
            name,
            &mut state.borrow_mut().disabled_builtins,
            !options.disabled,
        ) {
            continue;
        }
        status = 1;
        missing(name, fds, context).await?;
    }
    Ok(status)
}

async fn missing(name: &str, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let stderr = endpoint(fds, 2)?;
    stderr
        .write_all(b"enable: ", &context.cancel)
        .await
        .map_err(|error| error.status())?;
    stderr
        .write_all(name.as_bytes(), &context.cancel)
        .await
        .map_err(|error| error.status())?;
    stderr
        .write_all(b": not a shell builtin\n", &context.cancel)
        .await
        .map_err(|error| error.status())
}

async fn list(
    options: &Options,
    disabled: u128,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    work.checkpoint(&context.cancel)
        .await
        .map_err(error_status)?;
    let mut entries: [_; commands::COMMAND_COUNT] =
        std::array::from_fn(|index| &commands::catalogue()[index]);
    entries.sort_unstable_by_key(|command| command.name);
    for command in entries {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        let enabled = commands::enabled(command.name, disabled);
        if !selected(command, enabled, options) {
            continue;
        }
        write(
            fds,
            if enabled { b"enable " } else { b"enable -n " },
            context,
        )
        .await?;
        write(fds, command.name.as_bytes(), context).await?;
        write(fds, b"\n", context).await?;
    }
    Ok(())
}

fn selected(command: &commands::Command, enabled: bool, options: &Options) -> bool {
    if !command.query_builtin() {
        return false;
    }
    if options.special && command.class != commands::Class::SpecialBuiltin {
        return false;
    }
    options.all || enabled != options.disabled
}
