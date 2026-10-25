use super::{CommandError, Context, Descriptors, PreparedCommand, commands, expand};
use crate::{io::FdTable, state::SharedState};
use shell_parser::parser::{Redirect, RedirectKind};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

pub(super) struct CallerDescriptors {
    caller: Weak<RefCell<FdTable>>,
    temporary: Vec<u32>,
    generated: Rc<Cell<u64>>,
    parent: Option<Rc<Self>>,
    _allocation: crate::exec::Allocation,
}

impl Context {
    pub(super) fn with_caller_descriptors(
        &self,
        caller: Weak<RefCell<FdTable>>,
        temporary: Vec<u32>,
        generated: Rc<Cell<u64>>,
    ) -> Result<Self, i32> {
        let bytes = std::mem::size_of::<CallerDescriptors>()
            + temporary.capacity() * std::mem::size_of::<u32>()
            + 4 * std::mem::size_of::<usize>()
            + std::mem::size_of::<Cell<u64>>();
        let allocation = self.evaluation.admit_execution(bytes)?;
        Ok(Self {
            caller_descriptors: Some(Rc::new(CallerDescriptors {
                caller,
                temporary,
                generated,
                parent: self.caller_descriptors.clone(),
                _allocation: allocation,
            })),
            ..self.clone()
        })
    }

    pub(super) fn persist_descriptors(
        &self,
        targets: &[u32],
        prepared: &FdTable,
        live: &Descriptors,
    ) {
        for &fd in targets {
            let endpoint = prepared.get(fd);
            replace_binding(&mut live.borrow_mut(), fd, endpoint.clone());
            self.persist_caller_descriptor(fd, endpoint);
        }
    }

    fn persist_caller_descriptor(&self, fd: u32, endpoint: Option<crate::io::Endpoint>) {
        let mut scope = self.caller_descriptors.as_ref();
        while let Some(owner) = scope {
            if owner.temporary.contains(&fd) || generated(owner.generated.get(), fd) {
                break;
            }
            if let Some(caller) = owner.caller.upgrade() {
                replace_binding(&mut caller.borrow_mut(), fd, endpoint.clone());
            }
            scope = owner.parent.as_ref();
        }
    }
}

fn generated(mask: u64, fd: u32) -> bool {
    fd < 64 && mask & (1u64 << fd) != 0
}

fn replace_binding(table: &mut FdTable, fd: u32, endpoint: Option<crate::io::Endpoint>) {
    match endpoint {
        Some(endpoint) => {
            table.insert(fd, endpoint);
        }
        None => {
            table.remove(fd);
        }
    }
}

pub(super) fn command_context(
    prepared: &mut PreparedCommand,
    state: &SharedState,
    caller: &Descriptors,
    context: &Context,
) -> Result<Context, i32> {
    let Some(name) = prepared.argv.first() else {
        return Ok(context.clone());
    };
    let handler = commands::enabled_handler(name, state.borrow().disabled_builtins);
    let owns_caller = state.borrow().functions().contains_key(name)
        || matches!(
            handler,
            Some(
                commands::Handler::Eval
                    | commands::Handler::Source
                    | commands::Handler::Command
                    | commands::Handler::BuiltinWrapper
            )
        );
    if !owns_caller {
        return Ok(context.clone());
    }
    let Ok(execution) = &mut prepared.execution else {
        return Ok(context.clone());
    };
    let fds = execution.fds.as_ref().unwrap().borrow();
    let generated = open_mask(&fds) & !open_mask(&caller.borrow());
    context.with_caller_descriptors(
        Rc::downgrade(caller),
        std::mem::take(&mut execution.redirected),
        Rc::new(Cell::new(generated)),
    )
}

pub(super) fn redirected(
    redirs: &[Redirect],
    work: &mut expand::Work,
) -> Result<Vec<u32>, CommandError> {
    let count = redirs.len().checked_mul(2).ok_or(2)?;
    work.admit_storage(count * std::mem::size_of::<u32>())?;
    let mut descriptors = Vec::new();
    descriptors.try_reserve_exact(count).map_err(|_| 2)?;
    for redirect in redirs {
        descriptors.push(redirect_fd(redirect)?);
        if redirect.kind == RedirectKind::OutputBoth {
            descriptors.push(2);
        }
    }
    Ok(descriptors)
}

pub(super) fn redirect_fd(redirect: &Redirect) -> Result<u32, CommandError> {
    let input = matches!(
        redirect.kind,
        RedirectKind::Input
            | RedirectKind::DupInput
            | RedirectKind::HereDoc
            | RedirectKind::HereDocStrip
            | RedirectKind::HereString
            | RedirectKind::ReadWrite
    );
    u32::try_from(redirect.fd.unwrap_or(if input { 0 } else { 1 })).map_err(|_| 2.into())
}

pub(super) fn open_mask(fds: &FdTable) -> u64 {
    fds.iter().fold(
        0,
        |mask, (&fd, _)| {
            if fd < 64 { mask | (1u64 << fd) } else { mask }
        },
    )
}
