mod fields;
use super::{endpoint, error_status, write};
use crate::{
    executor::Budget,
    expand::Work,
    interpreter::Context,
    io::FdTable,
    state::{SharedState, State},
};
use fields::{Arguments, Field};

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    args.first().ok_or(2)?;
    let utf8 = character_locale(state, context, work).await?;
    let mut printer = Printer::new(fds, context, work, utf8);
    format(args, &mut printer).await?;
    printer.work = None;
    let status = format(args, &mut printer).await?;
    printer.flush_output().await?;
    if status == 0 { Ok(()) } else { Err(status) }
}

pub(super) async fn character_locale(
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<bool, i32> {
    let mut utf8 = false;
    for name in ["LC_ALL", "LC_CTYPE", "LANG"] {
        State::admit_scalar_access(state, name, &context.cancel, work)
            .await
            .map_err(error_status)?;
        let state = state.borrow();
        if let Some(locale) = state
            .scalar_parameter(name)
            .filter(|value| !value.is_empty())
        {
            utf8 = ["UTF-8", "UTF8"].iter().any(|encoding| {
                locale.eq_ignore_ascii_case(encoding)
                    || locale
                        .len()
                        .checked_sub(encoding.len() + 1)
                        .is_some_and(|start| {
                            locale.as_bytes()[start] == b'.'
                                && locale.as_bytes()[start + 1..]
                                    .eq_ignore_ascii_case(encoding.as_bytes())
                        })
            });
            break;
        }
    }
    Ok(utf8)
}

pub(super) async fn echo(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let utf8 = character_locale(state, context, work).await?;
    let mut printer = Printer::new(fds, context, work, utf8);
    echo_output(args, &mut printer).await?;
    printer.work = None;
    echo_output(args, &mut printer).await?;
    printer.flush_output().await
}

#[derive(Clone, Copy, Default)]
struct EchoOptions {
    operands: usize,
    no_newline: bool,
    escapes: bool,
}
impl EchoOptions {
    async fn parse(args: &[String], printer: &mut Printer<'_>) -> Result<Self, i32> {
        let mut options = Self::default();
        for arg in args {
            printer.scan(1).await?;
            if !arg.starts_with('-') || arg.len() == 1 {
                break;
            }
            let Some(next) = options.option(arg.as_bytes(), printer).await? else {
                break;
            };
            options = next;
        }
        Ok(options)
    }
    async fn option(&self, arg: &[u8], printer: &mut Printer<'_>) -> Result<Option<Self>, i32> {
        let mut next = Self {
            operands: self.operands + 1,
            ..*self
        };
        for flag in &arg[1..] {
            printer.scan(1).await?;
            match flag {
                b'n' => next.no_newline = true,
                b'e' => next.escapes = true,
                b'E' => next.escapes = false,
                _ => return Ok(None),
            }
        }
        Ok(Some(next))
    }
}
async fn echo_output(args: &[String], printer: &mut Printer<'_>) -> Result<(), i32> {
    let options = EchoOptions::parse(args, printer).await?;
    let mode = options.escapes.then_some(Mode::Echo);
    for (index, arg) in args[options.operands..].iter().enumerate() {
        printer.scan(1).await?;
        if index != 0 {
            printer.emit(1, b" ").await?;
        }
        if printer.operand_mode(arg.as_bytes(), mode).await? {
            return Ok(());
        }
    }
    if !options.no_newline {
        printer.emit(1, b"\n").await?;
    }
    Ok(())
}

const WRITE_CHUNK: usize = 4096;
struct Printer<'a> {
    fds: &'a FdTable,
    context: &'a Context,
    work: Option<&'a mut Work>,
    budget: Budget,
    remaining: usize,
    utf8: bool,
    output: [u8; WRITE_CHUNK],
    output_len: usize,
}
impl<'a> Printer<'a> {
    fn new(fds: &'a FdTable, context: &'a Context, work: &'a mut Work, utf8: bool) -> Self {
        Self {
            fds,
            context,
            work: Some(work),
            budget: Budget::default(),
            remaining: context.limits().expansion_bytes,
            utf8,
            output: [0; WRITE_CHUNK],
            output_len: 0,
        }
    }
    async fn scan(&mut self, bytes: usize) -> Result<(), i32> {
        for _ in 0..bytes {
            if let Some(work) = &mut self.work {
                work.checkpoint(&self.context.cancel)
                    .await
                    .map_err(error_status)?;
            } else {
                self.budget
                    .checkpoint(&self.context.cancel)
                    .await
                    .map_err(|_| 130)?;
            }
        }
        Ok(())
    }
    async fn flush_output(&mut self) -> Result<(), i32> {
        if self.output_len == 0 {
            return Ok(());
        }
        let result = write(self.fds, &self.output[..self.output_len], self.context).await;
        self.output_len = 0;
        result
    }
    async fn append_output(&mut self, mut bytes: &[u8]) -> Result<(), i32> {
        while !bytes.is_empty() {
            if self.output_len == WRITE_CHUNK {
                self.flush_output().await?;
            }
            let count = bytes.len().min(WRITE_CHUNK - self.output_len);
            self.output[self.output_len..self.output_len + count].copy_from_slice(&bytes[..count]);
            self.output_len += count;
            bytes = &bytes[count..];
        }
        Ok(())
    }
    async fn emit(&mut self, fd: u32, bytes: &[u8]) -> Result<(), i32> {
        if self.work.is_some() {
            self.remaining = self.remaining.checked_sub(bytes.len()).ok_or(2)?;
            return Ok(());
        }
        if fd == 1 {
            self.append_output(bytes).await
        } else {
            // With aliased stderr, Bash diagnoses before stdout. If stderr is
            // closed, expose the already-buffered stdout prefix before
            // returning the real diagnostic I/O failure. Cancellation does
            // not flush undelivered bytes.
            let result = self.write_diagnostic(fd, bytes).await;
            match result {
                Ok(()) => Ok(()),
                Err(status) if status == 130 => Err(status),
                Err(status) => {
                    self.flush_output().await?;
                    Err(status)
                }
            }
        }
    }
    async fn write_diagnostic(&self, fd: u32, bytes: &[u8]) -> Result<(), i32> {
        endpoint(self.fds, fd)?
            .write_all(bytes, &self.context.cancel)
            .await
            .map_err(|error| error.status())
    }
    async fn numeric_warning(&mut self, bytes: &[u8]) -> Result<(), i32> {
        if self.work.is_some() {
            return self.emit(2, bytes).await;
        }
        let result = self.write_diagnostic(2, bytes).await;
        match result {
            Err(130) => Err(130),
            _ => Ok(()),
        }
    }
    async fn padding(&mut self, mut count: usize, byte: u8) -> Result<(), i32> {
        if self.work.is_some() {
            self.remaining = self.remaining.checked_sub(count).ok_or(2)?;
            return self.scan(count).await;
        }
        const SPACES: [u8; WRITE_CHUNK] = [b' '; WRITE_CHUNK];
        const ZEROES: [u8; WRITE_CHUNK] = [b'0'; WRITE_CHUNK];
        let bytes = if byte == b'0' { &ZEROES } else { &SPACES };
        while count != 0 {
            let chunk = count.min(WRITE_CHUNK);
            self.scan(chunk).await?;
            self.emit(1, &bytes[..chunk]).await?;
            count -= chunk;
        }
        Ok(())
    }
    async fn escape(&mut self, input: &[u8], mode: Mode) -> Result<Escape, i32> {
        let escape = decode(input, mode, self.utf8);
        self.scan(escape.consumed).await?;
        if let Some(diagnostic) = escape.diagnostic {
            self.emit(2, diagnostic).await?;
        }
        self.emit(1, &escape.bytes[..escape.len]).await?;
        Ok(escape)
    }
    async fn operand(&mut self, input: &[u8], escaped: bool) -> Result<bool, i32> {
        self.operand_mode(input, escaped.then_some(Mode::Operand))
            .await
    }
    async fn operand_mode(&mut self, input: &[u8], mode: Option<Mode>) -> Result<bool, i32> {
        let mut offset = 0;
        while offset < input.len() {
            if let Some(mode) = mode.filter(|_| input[offset] == b'\\') {
                let escape = self.escape(&input[offset..], mode).await?;
                offset += escape.consumed;
                if escape.stop {
                    return Ok(true);
                }
            } else {
                let start = offset;
                while offset < input.len()
                    && offset - start < 4096
                    && (mode.is_none() || input[offset] != b'\\')
                {
                    offset += 1;
                }
                self.scan(offset - start).await?;
                self.emit(1, &input[start..offset]).await?;
            }
        }
        Ok(false)
    }
}

async fn format(args: &[String], printer: &mut Printer<'_>) -> Result<i32, i32> {
    let input = args[0].as_bytes();
    let mut arguments = Arguments {
        values: args,
        index: 1,
        status: 0,
    };
    loop {
        printer.scan(1).await?;
        let before = arguments.index;
        if format_pass(input, &mut arguments, printer).await? {
            return Ok(arguments.status);
        }
        if before == arguments.index || arguments.index >= args.len() {
            return Ok(arguments.status);
        }
    }
}

async fn format_pass(
    input: &[u8],
    args: &mut Arguments<'_>,
    printer: &mut Printer<'_>,
) -> Result<bool, i32> {
    let mut offset = 0;
    while offset < input.len() {
        if format_piece(input, &mut offset, args, printer).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn format_piece(
    input: &[u8],
    offset: &mut usize,
    args: &mut Arguments<'_>,
    printer: &mut Printer<'_>,
) -> Result<bool, i32> {
    match input[*offset] {
        b'\\' => {
            let escape = printer.escape(&input[*offset..], Mode::Format).await?;
            *offset += escape.consumed;
        }
        b'%' => {
            printer.scan(1).await?;
            *offset += 1;
            return conversion(input, offset, args, printer).await;
        }
        _ => format_literal(input, offset, printer).await?,
    }
    Ok(false)
}

async fn format_literal(
    input: &[u8],
    offset: &mut usize,
    printer: &mut Printer<'_>,
) -> Result<(), i32> {
    let start = *offset;
    while *offset < input.len()
        && *offset - start < WRITE_CHUNK
        && !matches!(input[*offset], b'%' | b'\\')
    {
        *offset += 1;
    }
    printer.scan(*offset - start).await?;
    printer.emit(1, &input[start..*offset]).await
}

async fn conversion(
    input: &[u8],
    offset: &mut usize,
    args: &mut Arguments<'_>,
    printer: &mut Printer<'_>,
) -> Result<bool, i32> {
    if input.get(*offset) == Some(&b'%') {
        printer.scan(1).await?;
        *offset += 1;
        printer.emit(1, b"%").await?;
        return Ok(false);
    }
    if input.get(*offset) == Some(&b'b') {
        printer.scan(1).await?;
        *offset += 1;
        let stop = printer
            .operand(args.take().unwrap_or("").as_bytes(), true)
            .await?;
        if stop {
            args.status = 0;
        }
        return Ok(stop);
    }
    if let Some(field) = Field::parse(input, offset, printer).await? {
        return field.print(args, printer).await;
    }
    printer
        .emit(2, b"/usr/bin/bash: printf: unsupported format conversion\n")
        .await?;
    args.status = 2;
    Ok(true)
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Format,
    Operand,
    Echo,
}
struct Escape {
    bytes: [u8; 10],
    len: usize,
    consumed: usize,
    diagnostic: Option<&'static [u8]>,
    stop: bool,
}
impl Escape {
    fn new() -> Self {
        Self {
            bytes: [0; 10],
            len: 0,
            consumed: 1,
            diagnostic: None,
            stop: false,
        }
    }
    fn push(&mut self, byte: u8) {
        self.bytes[self.len] = byte;
        self.len += 1;
    }
}

fn decode(input: &[u8], mode: Mode, utf8: bool) -> Escape {
    let mut out = Escape::new();
    let Some(&code) = input.get(1) else {
        out.push(b'\\');
        return out;
    };
    out.consumed = 2;
    let simple = match code {
        b'a' => Some(7),
        b'b' => Some(8),
        b'e' | b'E' => Some(27),
        b'f' => Some(12),
        b'n' => Some(10),
        b'r' => Some(13),
        b't' => Some(9),
        b'v' => Some(11),
        b'\\' => Some(b'\\'),
        b'\'' | b'"' | b'?' if mode == Mode::Format => Some(code),
        _ => None,
    };
    if let Some(byte) = simple {
        out.push(byte);
        return out;
    }
    if code == b'c' && mode != Mode::Format {
        out.stop = true;
        return out;
    }
    if matches!(code, b'0'..=b'7') && (mode != Mode::Echo || code == b'0') {
        let mut value = u32::from(code - b'0');
        // Echo requires the zero prefix. Both echo and %b ignore it before
        // consuming up to three additional octal digits.
        let digits = if mode != Mode::Format && code == b'0' {
            3
        } else {
            2
        };
        for _ in 0..digits {
            let Some(&digit @ b'0'..=b'7') = input.get(out.consumed) else {
                break;
            };
            value = value * 8 + u32::from(digit - b'0');
            out.consumed += 1;
        }
        out.push(value as u8);
        return out;
    }
    if matches!(code, b'x' | b'u' | b'U') {
        let limit = match code {
            b'x' => 2,
            b'u' => 4,
            _ => 8,
        };
        let mut value = 0u32;
        for _ in 0..limit {
            let Some(digit) = input.get(out.consumed).and_then(|byte| hex(*byte)) else {
                break;
            };
            value = (value << 4) | digit;
            out.consumed += 1;
        }
        if out.consumed == 2 {
            out.diagnostic = (mode != Mode::Echo).then_some(match code {
                b'x' => b"/usr/bin/bash: printf: missing hex digit for \\x\n",
                b'u' => b"/usr/bin/bash: printf: missing unicode digit for \\u\n",
                _ => b"/usr/bin/bash: printf: missing unicode digit for \\U\n",
            });
        } else {
            if code == b'x' {
                out.push(value as u8);
            } else {
                unicode(value, utf8, &mut out);
            }
            return out;
        }
    }
    out.push(b'\\');
    out.push(code);
    out
}
fn hex(byte: u8) -> Option<u32> {
    match byte {
        b'0'..=b'9' => Some(u32::from(byte - b'0')),
        b'a'..=b'f' => Some(u32::from(byte - b'a' + 10)),
        b'A'..=b'F' => Some(u32::from(byte - b'A' + 10)),
        _ => None,
    }
}
fn unicode(value: u32, utf8: bool, out: &mut Escape) {
    // Bash accepts a 31-bit character, not just a Unicode scalar. In particular
    // surrogates and legacy five/six-byte UTF-8 must not pass through Rust char
    // validation or a lossy String conversion. The high signed-bit range emits
    // nothing in both locales, without turning the command into a failure.
    if value >= 0x8000_0000 {
        return;
    }
    if value < 0x80 {
        out.push(value as u8);
        return;
    }
    if !utf8 {
        let digits = if value <= 0xffff { 4 } else { 8 };
        out.push(b'\\');
        out.push(if digits == 4 { b'u' } else { b'U' });
        for shift in (0..digits).rev() {
            out.push(b"0123456789ABCDEF"[((value >> (shift * 4)) & 15) as usize]);
        }
        return;
    }
    let (length, prefix) = match value {
        0x80..=0x7ff => (2, 0xc0),
        0x800..=0xffff => (3, 0xe0),
        0x1_0000..=0x1f_ffff => (4, 0xf0),
        0x20_0000..=0x3ff_ffff => (5, 0xf8),
        _ => (6, 0xfc),
    };
    out.push(prefix | (value >> (6 * (length - 1))) as u8);
    for shift in (0..length - 1).rev() {
        out.push(0x80 | ((value >> (shift * 6)) & 0x3f) as u8);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Limits, Session,
        executor::{Executor, JoinHandle},
        io::{Endpoint, MemoryFs, capture, pipe},
        process::InProcessHost,
    };
    use futures::FutureExt;
    use std::rc::Rc;

    fn finish(executor: &Executor, job: JoinHandle<i32>) -> i32 {
        for _ in 0..100_000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            executor.drive(64);
        }
        panic!("printf live-budget control did not finish");
    }

    fn budget_session(limit: usize) -> (Executor, Session) {
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        let shell = Session::new(
            ex.clone(),
            Rc::new(host),
            Rc::new(MemoryFs::new(64 * 1024)),
            Limits {
                execution_bytes: limit,
                ..Limits::default()
            },
        );
        (ex, shell)
    }

    #[test]
    fn printf_buffer_live_budget_refunds_after_normal_error_and_cancellation() {
        buffer_live_budget_refunds("printf");
        buffer_live_budget_refunds("echo -ne");
    }

    fn buffer_live_budget_refunds(command: &str) {
        let limit = 1024 * 1024;
        let (ex, shell) = budget_session(limit);
        let (out, output) = capture(4096);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, out);
        fds.insert(2, Endpoint::null());
        shell.set_descriptors(fds).unwrap();
        for (source, status) in [
            ("printf ok", 0),
            (r"printf 'prefixA\xZ' 2>&-", 1),
            (r"echo -ne '\0377'", 0),
            ("echo error >&-", 1),
        ] {
            assert_eq!(finish(&ex, shell.start(source).unwrap()), status);
            drop(shell.state().borrow().admit_temporary(limit).unwrap());
        }
        assert_eq!(output.bytes(), b"okprefixA\xff");
        let (reader, writer) = pipe();
        let filler = vec![b'!'; crate::io::PIPE_CAPACITY];
        assert_eq!(writer.write(&filler).now_or_never(), Some(Ok(filler.len())));
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, writer);
        fds.insert(2, Endpoint::null());
        shell.set_descriptors(fds).unwrap();
        let job = shell.start(&format!("{command} buffered")).unwrap();
        let mut parked = false;
        for _ in 0..100_000 {
            let turn = ex.drive(1);
            if !turn.runnable && !job.is_finished() {
                parked = true;
                break;
            }
        }
        assert!(parked);
        assert!(
            shell
                .state()
                .borrow()
                .admit_temporary(limit - WRITE_CHUNK + 1)
                .is_err()
        );
        shell.interrupt();
        assert_eq!(finish(&ex, job), 130);
        drop(shell.state().borrow().admit_temporary(limit).unwrap());
        let mut actual = vec![0; filler.len()];
        assert_eq!(
            reader.read(&mut actual).now_or_never(),
            Some(Ok(filler.len()))
        );
        assert_eq!(actual, filler);
        let shutdown = shell.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..1000 {
            ex.drive(64);
            if shutdown.as_mut().now_or_never().is_some() {
                return;
            }
        }
        panic!("printf live-budget session did not shut down");
    }

    #[test]
    fn printf_buffer_rejects_insufficient_shared_live_memory_before_printf_output() {
        let limit = 1024 * 1024;
        let (ex, shell) = budget_session(limit);
        let (out, output) = capture(4096);
        let (err, errors) = capture(4096);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, out);
        fds.insert(2, err);
        shell.set_descriptors(fds).unwrap();
        let held = shell
            .state()
            .borrow()
            .admit_temporary(limit - WRITE_CHUNK + 1)
            .unwrap();
        for source in ["true", "echo hidden", r"printf 'prefixA\xZ'"] {
            assert_eq!(finish(&ex, shell.start(source).unwrap()), 2, "{source}");
            assert!(output.bytes().is_empty(), "{source}");
        }
        assert!(
            !errors
                .bytes()
                .windows(b"missing hex digit".len())
                .any(|bytes| bytes == b"missing hex digit")
        );
        assert!(shell.state().borrow().admit_temporary(WRITE_CHUNK).is_err());
        drop(held);
        for source in ["true", "echo recovered"] {
            assert_eq!(finish(&ex, shell.start(source).unwrap()), 0, "{source}");
            drop(shell.state().borrow().admit_temporary(limit).unwrap());
        }
        assert_eq!(output.bytes(), b"recovered\n");
        let shutdown = shell.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..1000 {
            ex.drive(64);
            if shutdown.as_mut().now_or_never().is_some() {
                return;
            }
        }
        panic!("printf low-budget session did not shut down");
    }
}
