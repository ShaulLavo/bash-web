//! Programmable completion as non-interactive shell commands.
mod generate;
mod options;
mod wordlist;
use super::{diagnose, error_status, scan_bytes, write};
use crate::{
    expand::Work,
    interpreter::{Context, Flow, Outcome},
    io::FdTable,
    state::{
        SharedState,
        completion::{Spec, StoredSpec, Target},
    },
};
pub(super) use options::Kind;
use options::{ACTIONS, Arguments, OPTIONS, TEXT_FLAGS};

pub(super) async fn run(
    kind: Kind,
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let name = kind.name();
    for arg in args {
        scan_bytes(arg.len(), context, work).await?;
    }
    let parsed = match options::parse(kind, args) {
        Ok(parsed) => parsed,
        Err(code) => {
            diagnose(
                fds,
                &format!("{name}: invalid option or argument\n"),
                context,
            )
            .await?;
            return Err(code);
        }
    };
    let result = match kind {
        Kind::Generate => generate::run(&parsed, state, fds, context, work).await,
        _ => registrations(kind, &parsed, state, fds, context, work).await,
    };
    match result {
        Err(141) => Ok(Outcome {
            code: 141,
            flow: Flow::Abort,
        }),
        result => result,
    }
}
async fn registrations(
    kind: Kind,
    args: &Arguments<'_>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if let Some(special) = args.special {
        return operate(
            kind,
            args,
            Target::Special(special),
            state,
            fds,
            context,
            work,
        )
        .await
        .map(Outcome::status);
    }
    if !args.operands.is_empty() {
        return named(kind, args, state, fds, context, work).await;
    }
    if kind == Kind::Options {
        return Err(1);
    }
    if args.remove {
        state.borrow_mut().completions.clear();
        return Ok(Outcome::status(0));
    }
    if args.supplied && !args.print {
        return Err(2);
    }
    let table = state.borrow().completions.clone();
    for index in 0..table.len() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        let (target, spec) = table.entry(index);
        print(kind, target, spec.view(), fds, context, work).await?;
    }
    Ok(Outcome::status(0))
}
async fn named(
    kind: Kind,
    args: &Arguments<'_>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut status = 0;
    for name in args.operands {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        status |= operate(kind, args, Target::Name(name), state, fds, context, work).await?;
    }
    Ok(Outcome::status(status))
}
async fn operate(
    kind: Kind,
    args: &Arguments<'_>,
    target: Target<'_>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let table = state.borrow().completions.clone();
    let previous = table
        .find(target, &context.cancel, work)
        .await
        .map_err(error_status)?;
    if args.print || kind == Kind::Options && !args.supplied {
        let Some(spec) = previous else {
            return Ok(1);
        };
        print(kind, target, spec.view(), fds, context, work).await?;
        return Ok(0);
    }
    if args.remove && previous.is_none() {
        return Ok(i32::from(table.initialized));
    }
    if kind == Kind::Options {
        let Some(previous) = &previous else {
            return Ok(1);
        };
        for text in previous.view().text.iter().flatten() {
            scan_bytes(text.len(), context, work).await?;
        }
    }
    let spec = replacement(kind, args, previous.as_deref(), state)?;
    let updated = table
        .updated(target, spec, state, &context.cancel, work)
        .await
        .map_err(error_status)?;
    state.borrow_mut().completions = updated;
    Ok(0)
}
fn replacement(
    kind: Kind,
    args: &Arguments<'_>,
    previous: Option<&StoredSpec>,
    state: &SharedState,
) -> Result<Option<std::rc::Rc<StoredSpec>>, i32> {
    if args.remove {
        return Ok(None);
    }
    let mut spec = if kind == Kind::Options {
        previous.map(StoredSpec::view).unwrap_or_default()
    } else {
        args.spec
    };
    if kind == Kind::Options {
        spec.options = (spec.options | args.spec.options) & !args.unset_options;
    }
    StoredSpec::retain(spec, &state.borrow()).map(Some)
}
async fn print(
    kind: Kind,
    target: Target<'_>,
    spec: Spec<'_>,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let target_bytes = match target {
        Target::Name(name) => name.len(),
        Target::Special(_) => 0,
    };
    scan_bytes(target_bytes, context, work).await?;
    for text in spec.text.iter().flatten() {
        scan_bytes(text.len(), context, work).await?;
    }
    write(fds, kind.name().as_bytes(), context).await?;
    for (index, name) in OPTIONS.iter().enumerate() {
        let enabled = spec.options & (1 << index) != 0;
        if !enabled && kind != Kind::Options {
            continue;
        }
        write(fds, if enabled { b" -o " } else { b" +o " }, context).await?;
        write(fds, name.as_bytes(), context).await?;
    }
    if kind == Kind::Complete {
        print_spec(spec, fds, context).await?;
    }
    write(fds, b" ", context).await?;
    match target {
        Target::Special(kind) => write(fds, &kind.flag(), context).await?,
        Target::Name(name) => quote(name, false, fds, context).await?,
    }
    write(fds, b"\n", context).await
}
async fn print_spec(spec: Spec<'_>, fds: &FdTable, context: &Context) -> Result<(), i32> {
    for (index, (name, letter)) in ACTIONS.iter().enumerate() {
        if spec.actions & (1 << index) == 0 {
            continue;
        }
        if let Some(letter) = letter {
            write(fds, &[b' ', b'-', *letter], context).await?;
        } else {
            write(fds, b" -A ", context).await?;
            write(fds, name.as_bytes(), context).await?;
        }
    }
    for (index, text) in spec.text.iter().enumerate() {
        let Some(text) = text else {
            continue;
        };
        write(fds, &[b' ', b'-', TEXT_FLAGS[index], b' '], context).await?;
        quote(text, index != 6, fds, context).await?;
    }
    Ok(())
}
async fn quote(value: &str, always: bool, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let quoted = always
        || value.is_empty()
        || value
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !b"_+,-./:=@%".contains(&byte));
    if !quoted {
        return write(fds, value.as_bytes(), context).await;
    }
    write(fds, b"'", context).await?;
    let mut pieces = value.split('\'');
    write(fds, pieces.next().unwrap_or_default().as_bytes(), context).await?;
    for piece in pieces {
        write(fds, b"'\\''", context).await?;
        write(fds, piece.as_bytes(), context).await?;
    }
    write(fds, b"'", context).await
}
