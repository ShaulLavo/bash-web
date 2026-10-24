mod fields;
mod quoting;
use super::error_status;
use crate::{
    executor::Budget,
    expand::Work,
    interpreter::Context,
    io::{FdTable, IoError},
    state::{SharedState, State},
};
use fields::{Arguments, Field};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PrintFailure {
    Status(i32),
    Io(IoError),
}
impl From<i32> for PrintFailure {
    fn from(status: i32) -> Self {
        Self::Status(status)
    }
}
impl From<IoError> for PrintFailure {
    fn from(error: IoError) -> Self {
        Self::Io(error)
    }
}

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), PrintFailure> {
    let invocation = Invocation::parse(args, context, work).await?;
    let utf8 = character_locale(state, context, work).await?;
    let mut printer = Printer::new(fds, context, work, utf8);
    invocation.print(&mut printer).await?;
    if let Invocation::Assign(name, _) = invocation {
        return assign(name, invocation, state, &mut printer).await;
    }
    printer.work = None;
    let status = invocation.print(&mut printer).await?;
    printer.flush_output().await?;
    if status == 0 {
        Ok(())
    } else {
        Err(status.into())
    }
}

const USAGE: &[u8] = b"printf: usage: printf [-v var] format [arguments]\n";

#[derive(Clone, Copy)]
enum Invocation<'a> {
    Format(&'a [String]),
    Assign(&'a str, &'a [String]),
    InvalidVariable(&'a str),
    InvalidOption(u8),
    Usage,
    Error(&'static [u8]),
}

impl<'a> Invocation<'a> {
    async fn parse(args: &'a [String], context: &Context, work: &mut Work) -> Result<Self, i32> {
        let mut operands = args;
        let mut name = None;
        while let Some((first, rest)) = operands.split_first() {
            super::scan_bytes(first.len().max(1), context, work).await?;
            if first == "--" {
                operands = rest;
                break;
            }
            if first.len() <= 1 || !first.starts_with('-') {
                break;
            }
            let Some(attached) = first.strip_prefix("-v") else {
                return Ok(Self::option_error(first));
            };
            let Some((target, rest)) = Self::variable(attached, rest) else {
                return Ok(Self::Error(
                    b"/usr/bin/bash: printf: -v: option requires an argument\n",
                ));
            };
            super::scan_bytes(target.len(), context, work).await?;
            if !super::valid_name(target) {
                return Ok(Self::InvalidVariable(target));
            }
            name = Some(target);
            operands = rest;
        }
        if operands.is_empty() {
            return Ok(Self::Usage);
        }
        Ok(match name {
            Some(name) => Self::Assign(name, operands),
            None => Self::Format(operands),
        })
    }

    fn variable(attached: &'a str, rest: &'a [String]) -> Option<(&'a str, &'a [String])> {
        if !attached.is_empty() {
            return Some((attached, rest));
        }
        rest.split_first().map(|(name, rest)| (name.as_str(), rest))
    }

    fn option_error(first: &str) -> Self {
        if first == "--help" {
            return Self::Error(b"/usr/bin/bash: printf: --help: unsupported option\n");
        }
        Self::InvalidOption(first.as_bytes()[1])
    }

    async fn print(self, printer: &mut Printer<'_>) -> Result<i32, PrintFailure> {
        printer.scan(1).await?;
        match self {
            Self::Format(args) | Self::Assign(_, args) => return format(args, printer).await,
            Self::InvalidVariable(name) => {
                printer
                    .usage_diagnostic(b"/usr/bin/bash: printf: `")
                    .await?;
                printer.usage_diagnostic(name.as_bytes()).await?;
                printer
                    .usage_diagnostic(b"': not a valid identifier\n")
                    .await?;
                return Ok(2);
            }
            Self::InvalidOption(byte) => invalid_option(byte, printer).await?,
            Self::Error(diagnostic) => printer.usage_diagnostic(diagnostic).await?,
            Self::Usage => {}
        }
        // GNU Bash keeps usage status 2 when stderr is closed.
        printer.usage_diagnostic(USAGE).await?;
        Ok(2)
    }
}

async fn assign(
    name: &str,
    invocation: Invocation<'_>,
    state: &SharedState,
    printer: &mut Printer<'_>,
) -> Result<(), PrintFailure> {
    let bytes = printer.stdout_bytes;
    let work = printer.work.as_deref_mut().ok_or(2)?;
    State::admit_assignment(state, name, bytes, &printer.context.cancel, work)
        .await
        .map_err(error_status)?;
    let storage = state
        .borrow()
        .declaration_storage(name, false)
        .map_err(error_status)?;
    let saved_bytes = if state.borrow().prefix_saved(name) {
        bytes
    } else {
        0
    };
    work.admit_storage(storage.saturating_add(bytes).saturating_add(saved_bytes))
        .map_err(error_status)?;
    let target = state.borrow().assignment_name(name.to_owned())?;
    let readonly = state.borrow().is_readonly(&target);
    if readonly {
        printer.readonly_diagnostic(&target).await?;
    }
    printer.scan(bytes).await?;
    let _storage = printer.context.admit_builtin_buffer(bytes)?;
    printer.capture = Some(Vec::with_capacity(bytes));
    printer.work = None;
    let status = invocation.print(printer).await?;
    if readonly {
        printer.readonly_diagnostic(&target).await?;
        return Err(1.into());
    }
    let mut output = printer.capture.take().ok_or(2)?;
    printer.scan(output.len()).await?;
    if let Some(end) = output.iter().position(|byte| *byte == 0) {
        output.truncate(end);
    }
    let value = String::from_utf8(output.into_boxed_slice().into_vec()).map_err(|_| 2)?;
    state.borrow_mut().assign_parameter(target, value)?;
    if status == 0 {
        Ok(())
    } else {
        Err(status.into())
    }
}

async fn invalid_option(byte: u8, printer: &mut Printer<'_>) -> Result<(), PrintFailure> {
    printer
        .usage_diagnostic(b"/usr/bin/bash: printf: -")
        .await?;
    printer.usage_diagnostic(&[byte]).await?;
    printer.usage_diagnostic(b": invalid option\n").await
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
) -> Result<(), PrintFailure> {
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
    async fn parse(args: &[String], printer: &mut Printer<'_>) -> Result<Self, PrintFailure> {
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
    async fn option(
        &self,
        arg: &[u8],
        printer: &mut Printer<'_>,
    ) -> Result<Option<Self>, PrintFailure> {
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
async fn echo_output(args: &[String], printer: &mut Printer<'_>) -> Result<(), PrintFailure> {
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
    stdout_bytes: usize,
    capture: Option<Vec<u8>>,
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
            stdout_bytes: 0,
            capture: None,
        }
    }
    async fn scan(&mut self, bytes: usize) -> Result<(), PrintFailure> {
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
    async fn flush_output(&mut self) -> Result<(), PrintFailure> {
        if self.output_len == 0 {
            return Ok(());
        }
        let result = self
            .write_endpoint(1, &self.output[..self.output_len])
            .await;
        self.output_len = 0;
        result
    }
    async fn append_output(&mut self, mut bytes: &[u8]) -> Result<(), PrintFailure> {
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
    async fn emit(&mut self, fd: u32, bytes: &[u8]) -> Result<(), PrintFailure> {
        if self.work.is_some() {
            self.remaining = self.remaining.checked_sub(bytes.len()).ok_or(2)?;
            if fd == 1 {
                self.stdout_bytes += bytes.len();
            }
            return Ok(());
        }
        if fd == 1 {
            self.emit_output(bytes).await
        } else {
            // With aliased stderr, Bash diagnoses before stdout.
            let result = self.write_diagnostic(fd, bytes).await;
            match result {
                Ok(()) => Ok(()),
                Err(error @ (PrintFailure::Io(IoError::Cancelled) | PrintFailure::Status(130))) => {
                    Err(error)
                }
                Err(status) => {
                    self.flush_output().await?;
                    Err(status)
                }
            }
        }
    }
    async fn emit_output(&mut self, bytes: &[u8]) -> Result<(), PrintFailure> {
        if let Some(output) = &mut self.capture {
            output.extend_from_slice(bytes);
            return Ok(());
        }
        self.append_output(bytes).await
    }
    async fn readonly_diagnostic(&mut self, name: &str) -> Result<(), PrintFailure> {
        self.numeric_warning(b"/usr/bin/bash: ").await?;
        self.numeric_warning(name.as_bytes()).await?;
        self.numeric_warning(b": readonly variable\n").await
    }
    async fn write_endpoint(&self, fd: u32, bytes: &[u8]) -> Result<(), PrintFailure> {
        self.fds
            .get(fd)
            .ok_or(IoError::BadDescriptor)?
            .write_all(bytes, &self.context.cancel)
            .await
            .map_err(PrintFailure::Io)
    }
    async fn write_diagnostic(&self, fd: u32, bytes: &[u8]) -> Result<(), PrintFailure> {
        self.write_endpoint(fd, bytes).await
    }
    async fn usage_diagnostic(&mut self, bytes: &[u8]) -> Result<(), PrintFailure> {
        if self.work.is_some() {
            return self.emit(2, bytes).await;
        }
        match self.write_diagnostic(2, bytes).await {
            Err(
                error @ (PrintFailure::Io(IoError::Cancelled | IoError::BrokenPipe)
                | PrintFailure::Status(130 | 141)),
            ) => Err(error),
            _ => Ok(()),
        }
    }
    async fn numeric_warning(&mut self, bytes: &[u8]) -> Result<(), PrintFailure> {
        if self.work.is_some() {
            return self.emit(2, bytes).await;
        }
        let result = self.write_diagnostic(2, bytes).await;
        match result {
            Err(error @ (PrintFailure::Io(IoError::Cancelled) | PrintFailure::Status(130))) => {
                Err(error)
            }
            _ => Ok(()),
        }
    }
    async fn padding(&mut self, mut count: usize, byte: u8) -> Result<(), PrintFailure> {
        if self.work.is_some() {
            self.remaining = self.remaining.checked_sub(count).ok_or(2)?;
            self.stdout_bytes += count;
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
    async fn escape(&mut self, input: &[u8], mode: Mode) -> Result<Escape, PrintFailure> {
        let escape = decode(input, mode, self.utf8);
        self.scan(escape.consumed).await?;
        if let Some(diagnostic) = escape.diagnostic {
            if self.capture.is_some() {
                self.usage_diagnostic(diagnostic).await?;
            } else {
                self.emit(2, diagnostic).await?;
            }
        }
        self.emit(1, &escape.bytes[..escape.len]).await?;
        Ok(escape)
    }
    async fn escaped_field(
        &mut self,
        input: &[u8],
        precision: Option<usize>,
        emit: bool,
    ) -> Result<(usize, bool), PrintFailure> {
        let limit = precision.unwrap_or(usize::MAX);
        let mut output = OperandOutput {
            remaining: limit,
            emit,
        };
        let mut offset = 0;
        while offset < input.len() {
            if input[offset] != b'\\' {
                let input = &input[offset..input.len().min(offset + WRITE_CHUNK)];
                let length = input
                    .iter()
                    .position(|byte| *byte == b'\\')
                    .unwrap_or(input.len());
                self.scan(length).await?;
                output.piece(&input[..length], self).await?;
                offset += length;
                continue;
            }
            let escape = decode(&input[offset..], Mode::Operand, self.utf8);
            self.scan(escape.consumed).await?;
            if let Some(diagnostic) = escape.diagnostic.filter(|_| !emit) {
                self.usage_diagnostic(diagnostic).await?;
            }
            output.piece(&escape.bytes[..escape.len], self).await?;
            offset += escape.consumed;
            if escape.stop {
                return Ok((limit - output.remaining, true));
            }
        }
        Ok((limit - output.remaining, false))
    }
    async fn operand(&mut self, input: &[u8], escaped: bool) -> Result<bool, PrintFailure> {
        self.operand_mode(input, escaped.then_some(Mode::Operand))
            .await
    }
    async fn operand_mode(
        &mut self,
        input: &[u8],
        mode: Option<Mode>,
    ) -> Result<bool, PrintFailure> {
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

struct OperandOutput {
    remaining: usize,
    emit: bool,
}
impl OperandOutput {
    async fn piece(&mut self, bytes: &[u8], printer: &mut Printer<'_>) -> Result<(), PrintFailure> {
        let bytes = &bytes[..bytes.len().min(self.remaining)];
        self.remaining -= bytes.len();
        if self.emit {
            printer.emit(1, bytes).await?;
        }
        Ok(())
    }
}

async fn format(args: &[String], printer: &mut Printer<'_>) -> Result<i32, PrintFailure> {
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
) -> Result<bool, PrintFailure> {
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
) -> Result<bool, PrintFailure> {
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
) -> Result<(), PrintFailure> {
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
) -> Result<bool, PrintFailure> {
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

    #[test]
    fn output_boundary_only_aborts_typed_broken_pipe() {
        use super::super::output_outcome;
        use crate::interpreter::Flow;
        let success = output_outcome(Ok(())).unwrap();
        assert_eq!(success.code, 0);
        assert!(matches!(success.flow, Flow::Normal));
        let broken = output_outcome(Err(PrintFailure::Io(IoError::BrokenPipe))).unwrap();
        assert_eq!(broken.code, 141);
        assert!(matches!(broken.flow, Flow::Abort));
        for status in [0, 1, 2, 23, 130, 141, crate::exec::RESOURCE_STATUS] {
            assert_eq!(
                output_outcome(Err(PrintFailure::Status(status))).unwrap_err(),
                status
            );
        }
        for error in [
            IoError::BadDescriptor,
            IoError::Cancelled,
            IoError::LimitExceeded,
            IoError::NotFound,
            IoError::AlreadyExists,
            IoError::NotDirectory,
            IoError::Unsupported,
            IoError::InvalidPath,
            IoError::WriteZero,
            IoError::Runtime(32),
            IoError::Runtime(141),
        ] {
            let status = error.status();
            assert_eq!(
                output_outcome(Err(PrintFailure::Io(error))).unwrap_err(),
                status
            );
        }
    }

    fn printer_descriptors(output: Endpoint, diagnostic: Endpoint) -> FdTable {
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, output);
        fds.insert(2, diagnostic);
        fds
    }

    fn broken_diagnostic(source: &str, expected_status: i32, expected_output: &[u8]) {
        let limit = 1024 * 1024;
        let (ex, shell) = budget_session(limit);
        let (out, output) = capture(4096);
        let (reader, broken) = pipe();
        drop(reader);
        shell
            .set_descriptors(printer_descriptors(out, broken))
            .unwrap();
        assert_eq!(
            finish(&ex, shell.start(source).unwrap()),
            expected_status,
            "{source}"
        );
        assert_eq!(output.bytes(), expected_output, "{source}");
        drop(shell.state().borrow().admit_temporary(limit).unwrap());
    }

    #[test]
    fn typed_diagnostics_preserve_usage_warning_readonly_and_flush_policies() {
        broken_diagnostic("printf; echo BAD", 141, b"");
        broken_diagnostic("printf '%d' bad; echo survived", 0, b"0survived\n");
        broken_diagnostic(
            "readonly locked=old; printf -v locked %s new; echo survived:$?:$locked",
            0,
            b"survived:1:old\n",
        );
        broken_diagnostic(r"printf 'prefix\xZ'; echo BAD", 141, b"prefix");
    }

    #[test]
    fn broken_stdout_unwinds_only_current_execution_and_refunds_print_storage() {
        let limit = 1024 * 1024;
        for source in ["echo lost", "printf '%9000s' lost", "printf '%q' 'a b'"] {
            let (ex, shell) = budget_session(limit);
            let (reader, writer) = pipe();
            drop(reader);
            shell
                .set_descriptors(printer_descriptors(writer, Endpoint::null()))
                .unwrap();
            assert_eq!(
                finish(&ex, shell.start(&format!("{source}; exit 23")).unwrap()),
                141
            );
            drop(shell.state().borrow().admit_temporary(limit).unwrap());
            assert_eq!(finish(&ex, shell.start("true").unwrap()), 0);
        }
    }

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

    fn shutdown_budget_session(ex: &Executor, shell: &Session) {
        let shutdown = shell.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..1000 {
            ex.drive(64);
            if shutdown.as_mut().now_or_never().is_some() {
                return;
            }
        }
        panic!("printf budget session did not shut down");
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
            ("printf -v x '%8193s' hi", 0),
            (r"printf -v x '%b' '\377'", 2),
            ("readonly locked=old; printf -v locked %s changed 2>&-", 1),
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
        shell
            .set_descriptors(printer_descriptors(writer, Endpoint::null()))
            .unwrap();
        let job = shell.start(&format!("{command} buffered")).unwrap();
        crate::interpreter::printer_controls::assert_parked(&ex, &job);
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
        assert_eq!(
            crate::interpreter::printer_controls::read_available(&reader, filler.len()),
            filler
        );
        shutdown_budget_session(&ex, &shell);
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
        shutdown_budget_session(&ex, &shell);
    }
}
