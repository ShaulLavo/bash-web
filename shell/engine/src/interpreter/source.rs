use super::{Context, Descriptors, Flow, Outcome, eval};
use crate::{
    exec::{JoinedSource, Scope, StorageAllocation},
    io::{self, Endpoint, IoError, OpenOptions},
    state::{SharedState, SourceFrame, absolute},
};

pub(super) fn run(
    name: &str,
    args: Vec<String>,
    line: Option<usize>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    evaluation.reader_frame(
        |scope| run_body(name.to_owned(), args, line, state, fds, context, scope),
        Outcome::status,
    )
}

async fn run_body(
    name: String,
    mut args: Vec<String>,
    line: Option<usize>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    evaluation: Scope,
) -> Outcome {
    let diagnostic = eval::Diagnostic::new(&name, line, &fds, &context);
    let options_ended = args.first().is_some_and(|arg| arg == "--");
    if options_ended {
        args.remove(0);
    }
    let Some(filename) = args.first() else {
        return diagnostic.usage(None).await;
    };
    if !options_ended && filename.starts_with('-') && filename != "-" {
        return diagnostic.usage(Some(filename)).await;
    }
    let file = match find(filename, &state, &fds, &context).await {
        Ok(file) => file,
        Err(IoError::Cancelled) => return Outcome::status(130),
        Err(error) => return diagnostic.failure(&[filename], &io_message(error), 1).await,
    };
    let reader = match crate::exec::ReaderLocation::file(file.name, &evaluation) {
        Ok(reader) => reader,
        Err(code) => {
            return diagnostic
                .failure(&[&name, filename], STORAGE_LIMIT, code)
                .await;
        }
    };
    let source = match read(file.endpoint, &evaluation, &context).await {
        Ok(text) => text,
        Err(ReadError::Io(IoError::Cancelled)) => return Outcome::status(130),
        Err(ReadError::Io(error)) => {
            let code = error.status();
            return diagnostic
                .failure(&[&name, filename], &io_message(error), code)
                .await;
        }
        Err(ReadError::Refused(message)) => {
            return diagnostic.failure(&[&name, filename], message, 2).await;
        }
    };
    let filename = args.remove(0);
    let reader_context = Context {
        reader,
        ..context.clone()
    };
    let frame = match SourceFrame::enter(state.clone(), args) {
        Ok(frame) => frame,
        Err(code) => {
            return diagnostic
                .failure(&[&name, &filename], STORAGE_LIMIT, code)
                .await;
        }
    };
    let result = eval::read(
        source,
        evaluation,
        Some(&filename),
        state,
        fds.clone(),
        reader_context,
    )
    .await;
    frame.finish();
    let mut result = match result {
        Ok(result) => result,
        Err(message) => return diagnostic.failure(&[&name, &filename], &message, 2).await,
    };
    if result.flow == Flow::Return {
        result.flow = Flow::Normal;
    }
    result
}

const STORAGE_LIMIT: &str = "shell source storage limit exceeded";
const SOURCE_LIMIT: &str = "shell source limit exceeded";

#[derive(Debug)]
enum ReadError {
    Refused(&'static str),
    Io(IoError),
}

impl From<i32> for ReadError {
    fn from(_: i32) -> Self {
        Self::Refused(STORAGE_LIMIT)
    }
}

fn io_message(error: IoError) -> String {
    let errno = match error {
        IoError::BadDescriptor => 8,
        IoError::NotFound => 44,
        IoError::NotDirectory => 54,
        IoError::AlreadyExists => 20,
        IoError::Runtime(31) => return "is a directory".to_owned(),
        IoError::Runtime(errno) => errno,
        error => return error.to_string(),
    };
    crate::process::ProcessError::StartFailed(errno).to_string()
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

struct OpenedSource {
    endpoint: Endpoint,
    name: String,
}

async fn candidate(
    cwd: &str,
    directory: &str,
    name: &str,
    fds: &Descriptors,
    context: &Context,
) -> Result<OpenedSource, IoError> {
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
    let endpoint = open(&absolute(cwd, &path), fds, context).await?;
    Ok(OpenedSource {
        endpoint,
        name: path,
    })
}

async fn find(
    name: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Result<OpenedSource, IoError> {
    let (cwd, path, _storage) = {
        let state = state.borrow();
        let path = if name.contains('/') || !state.sourcepath {
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

fn source_file(file: OpenedSource) -> Result<Option<OpenedSource>, IoError> {
    let directory = file.endpoint.descriptor_kind()? == io::DescriptorKind::Directory;
    Ok((!directory).then_some(file))
}

const READ_CHUNK_BYTES: usize = 4096;
const READER_METADATA_BYTES: usize = 4096;

fn source_storage(capacity: usize) -> Result<usize, ReadError> {
    // The buffer and later Rc<str> copy overlap. Keep both copies, their
    // reference-count headers and reader task metadata admitted until reaping.
    capacity
        .checked_mul(2)
        .and_then(|bytes| bytes.checked_add(READ_CHUNK_BYTES + READER_METADATA_BYTES))
        .and_then(|bytes| {
            bytes.checked_add(4 * size_of::<usize>() + size_of::<StorageAllocation>())
        })
        .ok_or(ReadError::Refused(STORAGE_LIMIT))
}

fn reserve(
    bytes: &mut Vec<u8>,
    size: usize,
    storage: &mut StorageAllocation,
) -> Result<(), ReadError> {
    if size <= bytes.capacity() {
        return Ok(());
    }
    let capacity = bytes
        .capacity()
        .checked_mul(2)
        .ok_or(ReadError::Refused(STORAGE_LIMIT))?
        .max(size)
        .max(8);
    storage.resize(source_storage(capacity)?)?;
    bytes
        .try_reserve(size - bytes.len())
        .map_err(|_| ReadError::Refused(STORAGE_LIMIT))?;
    storage.resize(source_storage(bytes.capacity())?)?;
    Ok(())
}

async fn read(
    endpoint: Endpoint,
    scope: &Scope,
    context: &Context,
) -> Result<JoinedSource, ReadError> {
    let mut storage = scope.admit_storage(source_storage(0)?)?;
    let mut bytes = Vec::new();
    let mut chunk = [0; READ_CHUNK_BYTES];
    loop {
        let count = endpoint
            .read_cancelled(&mut chunk, &context.cancel)
            .await
            .map_err(ReadError::Io)?;
        if count == 0 {
            let text = String::from_utf8(bytes)
                .map_err(|_| ReadError::Refused("invalid UTF-8 in shell source"))?;
            return Ok(JoinedSource::new(text, storage));
        }
        let size = bytes
            .len()
            .checked_add(count)
            .ok_or(ReadError::Refused(SOURCE_LIMIT))?;
        if size > context.limits().source_bytes {
            return Err(ReadError::Refused(SOURCE_LIMIT));
        }
        reserve(&mut bytes, size, &mut storage)?;
        bytes.extend_from_slice(&chunk[..count]);
        crate::executor::yield_now().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{exec::StorageBudget, interpreter::Limits};

    #[test]
    fn source_buffer_growth_is_amortized_and_charged_through_retention() {
        let budget = StorageBudget::new(1024 * 1024);
        let mut storage = budget.admit(source_storage(0).unwrap()).unwrap();
        let mut bytes = Vec::new();
        let mut growths = 0;
        for _ in 0..64 {
            let capacity = bytes.capacity();
            let size = bytes.len() + READ_CHUNK_BYTES;
            reserve(&mut bytes, size, &mut storage).unwrap();
            growths += usize::from(bytes.capacity() != capacity);
            assert_eq!(storage.bytes(), source_storage(bytes.capacity()).unwrap());
            bytes.resize(size, b' ');
        }
        assert_eq!(bytes.len(), Limits::default().source_bytes);
        assert_eq!(growths, 7);
        let charged = storage.bytes();
        let text = String::from_utf8(bytes).unwrap();
        let source = JoinedSource::new(text, storage).retain();
        let child = source.clone();
        drop(source);
        assert_eq!(budget.observation().0, charged);
        drop(child);
        assert_eq!(budget.observation().0, 0);
    }
}
