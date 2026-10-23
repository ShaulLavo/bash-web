use super::{Context, Descriptors, Flow, Outcome, command_builtin, eval};
use crate::{
    exec::Scope,
    io::{self, Endpoint, IoError, OpenOptions},
    state::{SharedState, SourceFrame, absolute},
};

pub(super) fn run(
    name: &str,
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    evaluation.reader_frame(
        |scope| run_body(name.to_owned(), args, state, fds, context, scope),
        Outcome::status,
    )
}

async fn run_body(
    name: String,
    mut args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    evaluation: Scope,
) -> Outcome {
    let options_ended = args.first().is_some_and(|arg| arg == "--");
    if options_ended {
        args.remove(0);
    }
    let Some(filename) = args.first() else {
        return failure(&name, "filename argument required", 2, &fds, &context).await;
    };
    if !options_ended && filename.starts_with('-') && filename != "-" {
        return failure(&name, "invalid option", 2, &fds, &context).await;
    }
    let endpoint = match find(filename, &state, &fds, &context).await {
        Ok(endpoint) => endpoint,
        Err(IoError::Cancelled) => return Outcome::status(130),
        Err(error) => return failure(filename, &error.to_string(), 1, &fds, &context).await,
    };
    let (text, storage) = match read(endpoint, &evaluation, &context).await {
        Ok(text) => text,
        Err(code) => return Outcome::status(code),
    };
    let source = match eval::join(vec![text], &evaluation, &context).await {
        Ok(source) => source,
        Err(code) => return Outcome::status(code),
    };
    drop(storage);
    let filename = args.remove(0);
    let frame = match SourceFrame::enter(state.clone(), args) {
        Ok(frame) => frame,
        Err(code) => return Outcome::status(code),
    };
    let mut result = eval::read(source, evaluation, &filename, state, fds, context).await;
    frame.finish();
    if result.flow == Flow::Return {
        result.flow = Flow::Normal;
    }
    result
}

async fn failure(
    name: &str,
    reason: &str,
    code: i32,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let diagnostic = format!("/usr/bin/bash: {name}: {reason}\n");
    let status = command_builtin::diagnostic(fds, context, diagnostic.as_bytes()).await;
    Outcome::status(status.err().unwrap_or(code))
}

async fn open(path: &str, fds: &Descriptors, context: &Context) -> Result<Endpoint, IoError> {
    let options = OpenOptions::default();
    let request = io::open_path(path, &fds.borrow(), &options)?;
    context
        .cancel
        .run(request.open(context.fs(), &options))
        .await
        .map_err(|_| IoError::Cancelled)?
}

async fn candidate(
    cwd: &str,
    directory: &str,
    name: &str,
    fds: &Descriptors,
    context: &Context,
) -> Result<Endpoint, IoError> {
    let bytes = cwd
        .len()
        .checked_add(directory.len())
        .and_then(|bytes| bytes.checked_add(name.len()))
        .and_then(|bytes| bytes.checked_add(2))
        .ok_or(IoError::LimitExceeded)?;
    if bytes > context.limits().path_bytes {
        return Err(IoError::LimitExceeded);
    }
    let _storage = context
        .admit_builtin_buffer(bytes.saturating_mul(2))
        .map_err(|_| IoError::LimitExceeded)?;
    let path = if directory.is_empty() {
        name.to_owned()
    } else {
        format!("{directory}/{name}")
    };
    open(&absolute(cwd, &path), fds, context).await
}

async fn find(
    name: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Result<Endpoint, IoError> {
    let (cwd, path, _storage) = {
        let state = state.borrow();
        let path = if name.contains('/') {
            ""
        } else {
            state.scalar_parameter("PATH").unwrap_or("")
        };
        let bytes = state
            .cwd
            .len()
            .checked_add(path.len())
            .ok_or(IoError::LimitExceeded)?;
        let storage = context
            .admit_builtin_buffer(bytes)
            .map_err(|_| IoError::LimitExceeded)?;
        (state.cwd.clone(), path.to_owned(), storage)
    };
    if name.contains('/') {
        return candidate(&cwd, "", name, fds, context).await;
    }
    let mut budget = crate::executor::Budget::default();
    for directory in path.split(':') {
        if budget.checkpoint(&context.cancel).await.is_err() {
            return Err(IoError::Cancelled);
        }
        let endpoint = match candidate(&cwd, directory, name, fds, context).await {
            Ok(endpoint) => source_file(endpoint)?,
            Err(error @ (IoError::Cancelled | IoError::LimitExceeded)) => return Err(error),
            Err(_) => None,
        };
        if let Some(endpoint) = endpoint {
            return Ok(endpoint);
        }
    }
    candidate(&cwd, "", name, fds, context).await
}

fn source_file(endpoint: Endpoint) -> Result<Option<Endpoint>, IoError> {
    let directory = endpoint.descriptor_kind()? == io::DescriptorKind::Directory;
    Ok((!directory).then_some(endpoint))
}

async fn read(
    endpoint: Endpoint,
    scope: &Scope,
    context: &Context,
) -> Result<(String, crate::exec::StorageAllocation), i32> {
    let mut storage = scope.admit_storage(4096)?;
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        let count = endpoint
            .read_cancelled(&mut chunk, &context.cancel)
            .await
            .map_err(|error| error.status())?;
        if count == 0 {
            return String::from_utf8(bytes)
                .map(|text| (text, storage))
                .map_err(|_| 2);
        }
        let size = bytes.len().checked_add(count).ok_or(2)?;
        if size > context.limits().source_bytes {
            return Err(2);
        }
        storage.resize(4096usize.checked_add(size).ok_or(2)?)?;
        bytes.try_reserve_exact(count).map_err(|_| 2)?;
        bytes.extend_from_slice(&chunk[..count]);
        crate::executor::yield_now().await;
    }
}
