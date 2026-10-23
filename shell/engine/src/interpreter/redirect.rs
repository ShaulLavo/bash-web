use super::*;
use std::{
    cell::{Ref, RefMut},
    rc::Weak,
};

#[derive(Clone)]
pub(super) struct Descriptors {
    table: Rc<RefCell<FdTable>>,
    // Weak tables preserve named changes across temporary redirects without
    // keeping a displaced pipe writer alive until a compound command returns.
    parents: Rc<[Weak<RefCell<FdTable>>]>,
}

impl Descriptors {
    pub(super) fn new(table: FdTable) -> Self {
        Self {
            table: Rc::new(RefCell::new(table)),
            parents: Rc::from([]),
        }
    }

    pub(super) fn borrow(&self) -> Ref<'_, FdTable> {
        self.table.borrow()
    }
    pub(super) fn borrow_mut(&self) -> RefMut<'_, FdTable> {
        self.table.borrow_mut()
    }

    pub(super) async fn redirected(
        &self,
        context: &Context,
        work: &mut expand::Work,
    ) -> Result<Self, expand::Error> {
        let count = self.parents.len().checked_add(1).ok_or(2)?;
        work.admit_storage(
            count
                .checked_mul(std::mem::size_of::<Weak<RefCell<FdTable>>>())
                .ok_or(2)?,
        )?;
        let mut parents = Vec::new();
        parents.try_reserve_exact(count).map_err(|_| 2)?;
        for parent in self.parents.iter() {
            work.checkpoint(&context.cancel).await?;
            if parent.strong_count() > 0 {
                parents.push(parent.clone());
            }
        }
        parents.push(Rc::downgrade(&self.table));
        Ok(Self {
            table: Rc::new(RefCell::new(self.borrow().clone())),
            parents: parents.into(),
        })
    }

    pub(super) async fn publish(
        &self,
        fd: u32,
        endpoint: Option<io::Endpoint>,
        context: &Context,
        work: &mut expand::Work,
    ) -> Result<(), expand::Error> {
        for _ in self.parents.iter() {
            work.checkpoint(&context.cancel).await?;
        }
        for parent in self.parents.iter().filter_map(Weak::upgrade) {
            replace(&mut parent.borrow_mut(), fd, endpoint.clone());
        }
        replace(&mut self.borrow_mut(), fd, endpoint);
        Ok(())
    }
}

fn replace(table: &mut FdTable, fd: u32, endpoint: Option<io::Endpoint>) {
    match endpoint {
        Some(endpoint) => {
            table.insert(fd, endpoint);
        }
        None => {
            table.remove(fd);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Mode {
    Command,
    Exec,
}

pub(super) async fn allocate(
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<u32, CommandError> {
    if fds.borrow().iter().count() >= context.limits().descriptors {
        return Err(crate::exec::RESOURCE_STATUS.into());
    }
    let mut fd = 10u32;
    loop {
        work.checkpoint(&context.cancel).await?;
        if fds.borrow().get(fd).is_none() {
            admit_publication(fd, fds, context, work).await?;
            return Ok(fd);
        }
        fd = fd.checked_add(1).ok_or(crate::exec::RESOURCE_STATUS)?;
    }
}

async fn admit_publication(
    fd: u32,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    for parent in fds.parents.iter().filter_map(Weak::upgrade) {
        work.checkpoint(&context.cancel).await?;
        let table = parent.borrow();
        if table.get(fd).is_none() && table.iter().count() >= context.limits().descriptors {
            return Err(crate::exec::RESOURCE_STATUS.into());
        }
    }
    Ok(())
}

#[inline(never)]
pub(super) fn apply<'a>(
    redirect: &'a Redirect,
    mode: Mode,
    target: String,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<(), CommandError>> {
    context.evaluation.frame(
        apply_body(redirect, mode, target, state, fds, context, work),
        |code| Err(code.into()),
    )
}

async fn apply_body(
    redirect: &Redirect,
    mode: Mode,
    target: String,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), CommandError> {
    let named = redirect.fd_var.is_some();
    let closing = matches!(
        redirect.kind,
        RedirectKind::DupInput | RedirectKind::DupOutput
    ) && target == "-";
    if closing {
        let fd = if named {
            closed_number(redirect, state, fds, context, work).await?
        } else {
            number(redirect)?
        };
        if named && mode == Mode::Exec {
            fds.publish(fd, None, context, work).await?;
        }
        fds.borrow_mut().remove(fd);
        return Ok(());
    }
    let endpoint = endpoint(redirect, target, state, fds, context, work).await?;
    let fd = if named {
        allocate(fds, context, work).await?
    } else {
        number(redirect)?
    };
    if named {
        bind(redirect, fd, state, fds, context, work).await?;
    }
    if named {
        fds.publish(fd, Some(endpoint.clone()), context, work)
            .await?;
    }
    if redirect.kind == RedirectKind::OutputBoth {
        fds.borrow_mut().insert(2, endpoint.clone());
    }
    fds.borrow_mut().insert(fd, endpoint);
    Ok(())
}

fn input(kind: RedirectKind) -> bool {
    matches!(
        kind,
        RedirectKind::Input
            | RedirectKind::DupInput
            | RedirectKind::HereDoc
            | RedirectKind::HereDocStrip
            | RedirectKind::HereString
            | RedirectKind::ReadWrite
    )
}

fn number(redirect: &Redirect) -> Result<u32, CommandError> {
    u32::try_from(
        redirect
            .fd
            .unwrap_or(if input(redirect.kind) { 0 } else { 1 }),
    )
    .map_err(|_| 2.into())
}

async fn endpoint(
    redirect: &Redirect,
    target: String,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<io::Endpoint, CommandError> {
    match redirect.kind {
        RedirectKind::DupInput | RedirectKind::DupOutput => {
            let label = redirect
                .fd_var
                .as_deref()
                .or(redirect.target.raw.as_deref());
            duplicate_descriptor(&target, label, redirect.expansion_line, fds, context, work).await
        }
        RedirectKind::HereDoc | RedirectKind::HereDocStrip | RedirectKind::HereString => {
            work.admit_storage(io::buffered_input_metadata_bytes())?;
            let mut text = target;
            if redirect.kind == RedirectKind::HereString {
                work.admit_storage(1)?;
                text.try_reserve_exact(1).map_err(|_| 2)?;
                text.push('\n');
            }
            Ok(io::Endpoint::bytes(text.into_bytes()))
        }
        RedirectKind::Input
        | RedirectKind::Output
        | RedirectKind::Clobber
        | RedirectKind::Append
        | RedirectKind::OutputBoth
        | RedirectKind::ReadWrite => open(redirect, &target, state, fds, context).await,
    }
}

async fn open(
    redirect: &Redirect,
    target: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Result<io::Endpoint, CommandError> {
    let path = absolute(&state.borrow().cwd, target);
    let read_write = redirect.kind == RedirectKind::ReadWrite;
    let options = OpenOptions {
        read: input(redirect.kind),
        write: !input(redirect.kind) || read_write,
        create: !input(redirect.kind) || read_write,
        truncate: matches!(
            redirect.kind,
            RedirectKind::Output | RedirectKind::Clobber | RedirectKind::OutputBoth
        ),
        append: redirect.kind == RedirectKind::Append,
    };
    let opening = io::open_path(&path, &fds.borrow(), &options);
    let opening = match opening {
        Ok(opening) => opening,
        Err(error) => return Err(open_error(error, redirect, target, fds, context).await),
    };
    let endpoint = context
        .cancel
        .run(opening.open(context.fs(), &options))
        .await
        .map_err(|_| 130)?;
    match endpoint {
        Ok(endpoint) => Ok(endpoint),
        Err(error) => Err(open_error(error, redirect, target, fds, context).await),
    }
}

fn variable(name: &str) -> (&str, Option<&str>) {
    let Some((name, index)) = name.split_once('[') else {
        return (name, None);
    };
    (name, index.strip_suffix(']'))
}

pub(super) async fn closed_number(
    redirect: &Redirect,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<u32, CommandError> {
    let binding = redirect.fd_var.as_deref().expect("named close");
    let (name, index) = variable(binding);
    work.admit_storage(
        binding
            .len()
            .saturating_add(std::mem::size_of::<WordPart>()),
    )?;
    let part = match index {
        Some(index) => WordPart::ArrayAccess {
            name: name.into(),
            index: index.into(),
        },
        None => WordPart::Variable(name.into()),
    };
    let word = Word {
        parts: vec![part],
        ..Word::literal("")
    };
    let value = expand::word(
        &word,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        context.limits().expansion_bytes,
        work,
    )
    .await?;
    match value.parse::<u32>() {
        Ok(fd) => Ok(fd),
        Err(_) => Err(diagnostic(
            redirect.expansion_line,
            binding,
            "ambiguous redirect",
            fds,
            context,
        )
        .await),
    }
}

pub(super) async fn bind(
    redirect: &Redirect,
    fd: u32,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), CommandError> {
    let binding = redirect.fd_var.as_deref().expect("named open");
    let (name, index) = variable(binding);
    work.admit_storage(binding.len().saturating_add(128))?;
    let assignment = Assignment {
        name: name.into(),
        index: index.map(str::to_owned),
        value: AssignmentValue::Scalar(Word::literal(fd.to_string())),
        append: false,
    };
    let result = assignments(vec![assignment], state, context, &mut 0, work, true, None).await;
    match result {
        Ok(_) => Ok(()),
        Err(expand::Error::Readonly { name, .. }) => {
            diagnostic(
                redirect.expansion_line,
                &name,
                "readonly variable",
                fds,
                context,
            )
            .await;
            Err(diagnostic(
                redirect.expansion_line,
                binding,
                "cannot assign fd to variable",
                fds,
                context,
            )
            .await)
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn open_error(
    error: io::IoError,
    redirect: &Redirect,
    target: &str,
    fds: &Descriptors,
    context: &Context,
) -> CommandError {
    let message = match error {
        io::IoError::Cancelled => return 130.into(),
        io::IoError::NotFound => "No such file or directory",
        io::IoError::NotDirectory => "Not a directory",
        io::IoError::AlreadyExists => "File exists",
        io::IoError::BadDescriptor => "Bad file descriptor",
        io::IoError::Runtime(2 | 63) => "Permission denied",
        io::IoError::Runtime(31) => "Is a directory",
        _ => return error.status().into(),
    };
    diagnostic(redirect.expansion_line, target, message, fds, context).await
}

pub(super) async fn diagnostic(
    line: Option<usize>,
    label: &str,
    message: &str,
    fds: &Descriptors,
    context: &Context,
) -> CommandError {
    let prefix = match line {
        Some(line) => format!("/usr/bin/bash: line {line}: "),
        None => "/usr/bin/bash: ".to_owned(),
    };
    let bytes = prefix
        .len()
        .saturating_add(label.len())
        .saturating_add(message.len())
        .saturating_add(3);
    if bytes > context.limits().expansion_bytes {
        return 2.into();
    }
    let stderr = fds.borrow().get(2);
    if let Some(stderr) = stderr {
        for part in [
            prefix.as_bytes(),
            label.as_bytes(),
            b": ",
            message.as_bytes(),
            b"\n",
        ] {
            if stderr.write_all(part, &context.cancel).await.is_err() {
                break;
            }
        }
    }
    if context.cancel.is_cancelled() {
        130.into()
    } else {
        1.into()
    }
}
