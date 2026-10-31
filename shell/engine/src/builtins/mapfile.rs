mod records;

use super::{diagnose, endpoint, error_status, scan_bytes, valid_name};
use crate::{
    expand::Work,
    interpreter::Context,
    io::FdTable,
    state::{
        IndexedMode, IndexedProducer, ProducerError, Rejection, ScalarResolution, SharedState,
        State,
    },
};

const USAGE: &str =
    " [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-c quantum] [array]\n";

struct Options<'a> {
    fd: u32,
    fd_text: &'a str,
    delimiter: u8,
    count: u32,
    skip: u32,
    origin: i64,
    mode: IndexedMode,
    trim: bool,
    names: &'a [String],
}
impl Default for Options<'_> {
    fn default() -> Self {
        Self {
            fd: 0,
            fd_text: "0",
            delimiter: b'\n',
            count: 0,
            skip: 0,
            origin: 0,
            mode: IndexedMode::Replace,
            trim: false,
            names: &[],
        }
    }
}

pub(super) async fn run(
    (name, args): (&str, &[String]),
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let options = options(name, args, fds, context, work).await?;
    let input = match endpoint(fds, options.fd) {
        Ok(input) => input,
        Err(_) => {
            complain(
                name,
                &[
                    options.fd_text,
                    ": invalid file descriptor: Bad file descriptor\n",
                ],
                fds,
                context,
            )
            .await?;
            return Err(1);
        }
    };
    let operand = options
        .names
        .first()
        .map(String::as_str)
        .unwrap_or("MAPFILE");
    scan_bytes(operand.len(), context, work).await?;
    if !valid_name(operand) {
        invalid_name(name, operand, fds, context).await?;
        return Err(1);
    }
    let mut producer = match State::begin_indexed_producer(
        state,
        operand,
        options.mode,
        options.origin,
        &context.cancel,
        work,
    )
    .await
    {
        Ok(producer) => producer,
        Err(error) => return reject(name, operand, error, state, fds, context, work).await,
    };
    let chunk_bytes = if options.count == 0 { 4096 } else { 1 };
    let scratch = context
        .limits()
        .line_bytes
        .checked_add(chunk_bytes)
        .ok_or(2)?;
    work.admit_storage(scratch).map_err(error_status)?;
    let _storage = context.admit_builtin_buffer(scratch)?;
    let mut reader = records::Reader::new(
        context.limits().line_bytes,
        chunk_bytes,
        options.delimiter,
        options.trim,
    )?;
    let mut stored = 0u32;
    let mut skip = options.skip;
    loop {
        let end = reader.next(&input, context, work).await?;
        if skip != 0 {
            skip -= 1;
        } else if reader.has_record() {
            publish_record(&reader, &mut producer, state, context, work).await?;
            stored = stored.checked_add(1).ok_or(2)?;
        }
        if end == records::End::Input || (options.count != 0 && stored == options.count) {
            return Ok(0);
        }
        reader.reset();
    }
}

async fn publish_record(
    reader: &records::Reader,
    producer: &mut IndexedProducer,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let value = reader.value().map_err(|_| 2)?;
    producer
        .push(
            state,
            value,
            |bytes| context.admit_builtin_buffer(bytes),
            &context.cancel,
            work,
        )
        .await
        .map_err(producer_status)
}

fn producer_status(error: ProducerError) -> i32 {
    match error {
        ProducerError::Rejected(Rejection::Unsupported) => 2,
        ProducerError::Rejected(_) => 1,
        ProducerError::Exec(error) => error_status(error),
    }
}

async fn options<'a>(
    name: &str,
    args: &'a [String],
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Options<'a>, i32> {
    let mut result = Options::default();
    let mut remaining = args;
    while let Some((word, rest)) = remaining.split_first() {
        match word.as_str() {
            "--" => {
                remaining = rest;
                break;
            }
            "-" => break,
            word if !word.starts_with('-') => break,
            _ => remaining = option_word(name, word, rest, &mut result, fds, context, work).await?,
        }
    }
    result.names = remaining;
    Ok(result)
}

async fn option_word<'a>(
    name: &str,
    word: &'a str,
    rest: &'a [String],
    options: &mut Options<'a>,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<&'a [String], i32> {
    let bytes = word.as_bytes();
    let mut offset = 1;
    while bytes.get(offset) == Some(&b't') {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        options.trim = true;
        offset += 1;
    }
    let Some(&flag) = bytes.get(offset) else {
        return Ok(rest);
    };
    work.checkpoint(&context.cancel)
        .await
        .map_err(error_status)?;
    if flag == b'C' {
        complain(name, &["-C: callbacks are not supported\n"], fds, context).await?;
        return Err(2);
    }
    if !matches!(flag, b'd' | b'n' | b'O' | b's' | b'u' | b'c') {
        let byte = [flag];
        complain(
            name,
            &[
                "-",
                std::str::from_utf8(&byte).unwrap_or("?"),
                ": invalid option\n",
            ],
            fds,
            context,
        )
        .await?;
        usage(name, fds, context).await?;
        return Err(2);
    }
    if offset + 1 < word.len() {
        option_value(name, flag, &word[offset + 1..], options, fds, context, work).await?;
        return Ok(rest);
    }
    let Some((value, remaining)) = rest.split_first() else {
        usage(name, fds, context).await?;
        return Err(2);
    };
    option_value(name, flag, value, options, fds, context, work).await?;
    Ok(remaining)
}

async fn option_value<'a>(
    name: &str,
    flag: u8,
    value: &'a str,
    options: &mut Options<'a>,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    if flag == b'd' {
        options.delimiter = value.bytes().next().unwrap_or(0);
        return Ok(());
    }
    let converted = number(value, context, work).await;
    let converted = match converted {
        Ok(number)
            if (flag != b'c' || number != 0) && (flag != b'u' || number <= i32::MAX as u32) =>
        {
            number
        }
        Ok(_) | Err(1) => {
            complain(name, &[value, ": ", numeric_diagnostic(flag)], fds, context).await?;
            return Err(1);
        }
        Err(status) => return Err(status),
    };
    match flag {
        b'n' => options.count = converted,
        b's' => options.skip = converted,
        b'O' => {
            options.origin = i64::from(converted);
            options.mode = IndexedMode::Overlay;
        }
        b'u' => {
            options.fd = converted;
            options.fd_text = value;
        }
        b'c' => {}
        _ => unreachable!(),
    }
    Ok(())
}

fn numeric_diagnostic(flag: u8) -> &'static str {
    match flag {
        b'O' => "invalid array origin\n",
        b'c' => "invalid callback quantum\n",
        b'u' => "invalid file descriptor specification\n",
        _ => "invalid line count\n",
    }
}

async fn number(value: &str, context: &Context, work: &mut Work) -> Result<u32, i32> {
    scan_bytes(value.len(), context, work).await?;
    let number = value.trim_matches(|ch: char| ch.is_ascii_whitespace() || ch == '\u{b}');
    let (negative, digits) = match number.as_bytes().split_first() {
        Some((b'-', digits)) => (true, digits),
        Some((b'+', digits)) => (false, digits),
        _ => (false, number.as_bytes()),
    };
    if digits.is_empty() {
        return Err(1);
    }
    let mut result = 0u32;
    for &byte in digits {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if !byte.is_ascii_digit() {
            return Err(1);
        }
        result = result
            .checked_mul(10)
            .and_then(|n| n.checked_add(u32::from(byte - b'0')))
            .ok_or(1)?;
    }
    if negative && result != 0 {
        return Err(1);
    }
    Ok(result)
}

async fn invalid_name(
    name: &str,
    target: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    complain(
        name,
        &["`", target, "': not a valid identifier\n"],
        fds,
        context,
    )
    .await
}

async fn reject(
    name: &str,
    operand: &str,
    error: ProducerError,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<i32, i32> {
    let rejection = match error {
        ProducerError::Exec(error) => return Err(error_status(error)),
        ProducerError::Rejected(rejection) => rejection,
    };
    let target = {
        let state = state.borrow();
        let target = match state.resolve_scalar_target(operand) {
            ScalarResolution::Target(target) => target,
            _ => operand,
        };
        work.admit_storage(target.len()).map_err(error_status)?;
        target.to_owned()
    };
    match rejection {
        Rejection::InvalidTarget => invalid_name(name, &target, fds, context).await?,
        Rejection::Readonly => {
            complain(name, &[&target, ": readonly variable\n"], fds, context).await?
        }
        Rejection::NoAssign => {}
        Rejection::Unsupported => {
            complain(name, &[&target, ": unsupported target\n"], fds, context).await?
        }
    }
    Ok(if rejection == Rejection::Unsupported {
        2
    } else {
        1
    })
}

async fn complain(name: &str, parts: &[&str], fds: &FdTable, context: &Context) -> Result<(), i32> {
    for part in [name, ": "].into_iter().chain(parts.iter().copied()) {
        if diagnose(fds, part, context).await == Err(130) {
            return Err(130);
        }
    }
    Ok(())
}

async fn usage(name: &str, fds: &FdTable, context: &Context) -> Result<(), i32> {
    complain(name, &["usage: ", name, USAGE], fds, context).await
}

#[cfg(test)]
mod tests {
    use crate::{
        Limits, Session,
        executor::{Executor, JoinHandle},
        io::{Endpoint, FdTable, MemoryFs, pipe},
        process::InProcessHost,
    };
    use futures::FutureExt;
    use std::rc::Rc;

    const LIMIT: usize = 262_144;
    struct InputSession {
        executor: Executor,
        shell: Session,
        host: Rc<InProcessHost>,
    }
    impl InputSession {
        fn new() -> Self {
            let executor = Executor::new();
            let host = Rc::new(InProcessHost::new(executor.clone()));
            let filesystem = Rc::new(MemoryFs::new(1024));
            let limits = Limits {
                execution_bytes: LIMIT,
                ..Limits::default()
            };
            let shell = Session::new(executor.clone(), host.clone(), filesystem, limits);
            let result = Self {
                executor,
                shell,
                host,
            };
            result.finish(result.shell.start("true").unwrap());
            result
        }
        fn input(&self, input: Endpoint) {
            let mut descriptors = FdTable::default();
            descriptors.insert(0, input);
            descriptors.insert(1, Endpoint::null());
            descriptors.insert(2, Endpoint::null());
            self.shell.set_descriptors(descriptors).unwrap();
        }
        fn finish(&self, job: JoinHandle<i32>) -> i32 {
            assert!(
                (0..100_000).any(|_| {
                    self.executor.drive(64);
                    job.is_finished()
                }),
                "bounded mapfile completion"
            );
            job.now_or_never().unwrap()
        }
        fn assert_values(&self, expected: &[&str]) {
            let state = self.shell.state();
            let state = state.borrow();
            assert_eq!(state.array_count("a"), expected.len());
            for (index, value) in expected.iter().enumerate() {
                assert_eq!(state.array_element("a", index as i64), Some(*value));
            }
        }
        fn refunded(&self) {
            let state = self.shell.state();
            let state = state.borrow();
            drop(
                state
                    .admit_temporary(LIMIT - state.prefix_capacity_bytes())
                    .unwrap(),
            );
        }
    }
    impl Drop for InputSession {
        fn drop(&mut self) {
            let mut shutdown = Box::pin(self.shell.shutdown());
            assert!(
                (0..1000).any(|_| {
                    self.executor.drive(64);
                    shutdown.as_mut().now_or_never().is_some()
                }),
                "mapfile fixture shutdown"
            );
            assert_eq!(self.executor.drive(64).pending, 0);
            assert_eq!(self.host.active_count(), 0);
            assert_eq!(self.host.retained_count(), 0);
        }
    }

    #[test]
    fn mapfile_completion_cancellation_and_shutdown_refund_live_scratch() {
        pending_publication(false);
        pending_publication(true);
    }

    fn pending_publication(overlay: bool) {
        let fixture = InputSession::new();
        fixture.input(Endpoint::bytes(b"o0\no1\no2\no3\n".to_vec()));
        assert_eq!(
            fixture.finish(fixture.shell.start("mapfile -t a").unwrap()),
            0
        );
        fixture.refunded();
        let (reader, writer) = pipe();
        assert_eq!(
            writer.write(b"x\ny\nunfinished").now_or_never(),
            Some(Ok(14))
        );
        fixture.input(reader);
        let source = if overlay {
            "mapfile -t -O 1 a"
        } else {
            "mapfile -t a"
        };
        let pending = fixture.shell.start(source).unwrap();
        crate::interpreter::printer_controls::assert_parked(&fixture.executor, &pending);
        let expected: &[&str] = if overlay {
            &["o0", "x", "y", "o3"]
        } else {
            &["x", "y"]
        };
        fixture.assert_values(expected);
        assert!(
            fixture
                .shell
                .state()
                .borrow()
                .admit_temporary(LIMIT - 65_535)
                .is_err()
        );
        fixture.shell.interrupt();
        assert_eq!(fixture.finish(pending), 130);
        fixture.assert_values(expected);
        fixture.refunded();
        assert_eq!(fixture.finish(fixture.shell.start("true").unwrap()), 0);
        let (reader, writer2) = pipe();
        fixture.input(reader);
        let pending = fixture.shell.start("mapfile -t a").unwrap();
        crate::interpreter::printer_controls::assert_parked(&fixture.executor, &pending);
        let mut shutdown = Box::pin(fixture.shell.shutdown());
        assert!((0..1000).any(|_| {
            fixture.executor.drive(64);
            shutdown.as_mut().now_or_never().is_some()
        }));
        drop(shutdown);
        drop(pending);
        fixture.refunded();
        drop(writer);
        drop(writer2);
    }
}
