mod fields;
mod timeout;

use std::{
    future::{Future, poll_fn},
    task::Poll,
    time::Instant,
};
use timeout::Timeout;

use super::{diagnose, endpoint, error_status, printf};
use crate::{
    expand::{Ifs, Work},
    interpreter::{Context, Outcome},
    io::{DescriptorKind, Endpoint, FdTable, IoError},
    state::{SharedState, State},
};

#[derive(Clone, Copy, Default)]
enum Count {
    #[default]
    Line,
    AtMost(usize),
    Exactly(usize),
}

impl Count {
    fn maximum(self) -> usize {
        match self {
            Self::Line => usize::MAX,
            Self::AtMost(count) | Self::Exactly(count) => count,
        }
    }

    fn with_maximum(self, count: usize) -> Self {
        if self.exact() {
            return Self::Exactly(count);
        }
        Self::AtMost(count)
    }

    fn exact(self) -> bool {
        matches!(self, Self::Exactly(_))
    }
}

#[derive(Default)]
struct Options<'a> {
    fd: u32,
    raw: bool,
    count: Count,
    delimiter: Option<u8>,
    prompt: Option<&'a str>,
    silent: bool,
    timeout: Option<Timeout>,
    names: &'a [String],
}

async fn options<'a>(
    args: &'a [String],
    context: &Context,
    fds: &FdTable,
    work: &mut Work,
) -> Result<Options<'a>, i32> {
    let mut result = Options::default();
    let mut iter = args.iter();
    while let Some(arg) = iter.as_slice().first() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if arg == "--" {
            iter.next();
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            break;
        }
        iter.next();
        option_word(arg, &mut iter, &mut result, context, fds, work).await?;
    }
    result.names = iter.as_slice();
    Ok(result)
}

async fn option_word<'a>(
    arg: &'a str,
    iter: &mut std::slice::Iter<'a, String>,
    options: &mut Options<'a>,
    context: &Context,
    fds: &FdTable,
    work: &mut Work,
) -> Result<(), i32> {
    for (index, flag) in arg.bytes().enumerate().skip(1) {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if flag == b'r' {
            options.raw = true;
            continue;
        }
        if flag == b's' {
            options.silent = true;
            continue;
        }
        if !matches!(flag, b'n' | b'N' | b'u' | b'd' | b'p' | b't') {
            return Err(2);
        }
        let value = if index + 1 < arg.len() {
            &arg[index + 1..]
        } else {
            iter.next().map(String::as_str).ok_or(2)?
        };
        return option_value(flag, value, options, context, fds, work).await;
    }
    Ok(())
}

async fn option_value<'a>(
    flag: u8,
    value: &'a str,
    options: &mut Options<'a>,
    context: &Context,
    fds: &FdTable,
    work: &mut Work,
) -> Result<(), i32> {
    match flag {
        b'n' => {
            options.count = options
                .count
                .with_maximum(count(value, context, work).await?)
        }
        b'N' => options.count = Count::Exactly(count(value, context, work).await?),
        b'd' => options.delimiter = Some(value.bytes().next().unwrap_or(0)),
        b'p' => options.prompt = Some(value),
        b't' => options.timeout = Some(timeout_option(value, context, fds, work).await?),
        b'u' => {
            options.fd = value
                .parse::<i64>()
                .ok()
                .and_then(|fd| u32::try_from(fd).ok())
                .ok_or(1)?;
        }
        _ => return Err(2),
    }
    Ok(())
}

async fn timeout_option(
    value: &str,
    context: &Context,
    fds: &FdTable,
    work: &mut Work,
) -> Result<Timeout, i32> {
    let parsed = timeout::parse(value, &context.cancel, work)
        .await
        .map_err(error_status)?;
    if let Some(timeout) = parsed {
        return Ok(timeout);
    }
    diagnose(fds, "read: ", context).await?;
    diagnose(fds, value, context).await?;
    diagnose(fds, ": invalid timeout specification\n", context).await?;
    Err(1)
}

async fn count(value: &str, context: &Context, work: &mut Work) -> Result<usize, i32> {
    let value = value.trim_matches(|ch: char| ch.is_ascii_whitespace() || ch == '\u{b}');
    let negative = value.starts_with('-');
    let digits = value.strip_prefix(['+', '-']).unwrap_or(value);
    if digits.is_empty() {
        return Err(1);
    }
    let mut count = 0usize;
    for byte in digits.bytes() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if !byte.is_ascii_digit() {
            return Err(1);
        }
        count = count
            .checked_mul(10)
            .and_then(|n| n.checked_add(usize::from(byte - b'0')))
            .filter(|n| *n <= i32::MAX as usize)
            .ok_or(1)?;
    }
    if negative && count != 0 {
        return Err(1);
    }
    Ok(count)
}

pub(super) async fn run(
    args: &[String],
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let mut options = options(args, context, fds, work).await?;
    if options.timeout == Some(Timeout::Ready) {
        let ready = endpoint(fds, options.fd)?.read_ready().unwrap_or(false);
        return Ok(Outcome::status(if ready { 0 } else { 1 }));
    }
    if let Some(name) = options.names.first() {
        validate_name(name, fds, context, work).await?;
    }
    let input = endpoint(fds, options.fd)?;
    prepare_terminal(&options, &input, fds, context).await?;
    if options.timeout.is_none() {
        options.timeout = default_timeout(state, context, work).await?;
    }
    read_record(&options, &input, state, fds, context, work).await
}

async fn default_timeout(
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Option<Timeout>, i32> {
    State::admit_scalar_access(state, "TMOUT", &context.cancel, work)
        .await
        .map_err(error_status)?;
    let length = state.borrow().scalar_parameter("TMOUT").map_or(0, str::len);
    work.admit_storage(length).map_err(error_status)?;
    let _storage = context.admit_builtin_buffer(length)?;
    let value = state
        .borrow()
        .scalar_parameter("TMOUT")
        .unwrap_or("")
        .to_owned();
    Ok(
        match timeout::parse(&value, &context.cancel, work)
            .await
            .map_err(error_status)?
        {
            Some(timeout @ Timeout::After(_)) => Some(timeout),
            _ => None,
        },
    )
}

async fn prepare_terminal(
    options: &Options<'_>,
    input: &Endpoint,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    if options.count.maximum() == 0 || (options.prompt.is_none() && !options.silent) {
        return Ok(());
    }
    if input.descriptor_kind().map_err(|error| error.status())? != DescriptorKind::Terminal {
        return Ok(());
    }
    if options.silent {
        return Err(2);
    }
    if let Some(prompt) = options.prompt
        && diagnose(fds, prompt, context).await == Err(130)
    {
        return Err(130);
    }
    Ok(())
}

async fn validate_name(
    name: &str,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    super::scan_bytes(name.len(), context, work).await?;
    if super::valid_name(name) {
        return Ok(());
    }
    invalid_name(name, fds, context).await?;
    Err(1)
}

async fn invalid_name(name: &str, fds: &FdTable, context: &Context) -> Result<(), i32> {
    diagnose(fds, "/usr/bin/bash: read: `", context).await?;
    diagnose(fds, name, context).await?;
    diagnose(fds, "': not a valid identifier\n", context).await
}

async fn assign_value(
    name: &str,
    value: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    State::admit_assignment(state, name, value.len(), &context.cancel, work)
        .await
        .map_err(error_status)?;
    work.admit_storage(name.len().saturating_add(value.len()))
        .map_err(error_status)?;
    let _storage = context.admit_builtin_buffer(value.len())?;
    state
        .borrow_mut()
        .assign_parameter(name.to_owned(), value.to_owned())
}

async fn assign(
    reader: Reader,
    code: i32,
    options: &Options<'_>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let text = std::str::from_utf8(&reader.bytes).map_err(|_| 2)?;
    if options.names.is_empty() {
        assign_value("REPLY", text, state, context, work)
            .await
            .map_err(|status| destination_status(status, false))?;
        return Ok(Outcome::status(code));
    }
    let mut fields = fields::Fields::new(text, &reader.protected, &reader.ifs);
    for (index, name) in options.names.iter().enumerate() {
        validate_name(name, fds, context, work).await?;
        let last = index + 1 == options.names.len();
        let value = match (options.count.exact(), index) {
            (true, 0) => text,
            (true, _) => "",
            (false, _) => fields.value(last, context, work).await?,
        };
        assign_value(name, value, state, context, work)
            .await
            .map_err(|status| destination_status(status, last))?;
    }
    Ok(Outcome::status(code))
}

/// Bash's read returns 2 when REPLY or a non-final destination rejects its
/// value (readonly, for example); only the final named destination keeps 1.
fn destination_status(status: i32, last: bool) -> i32 {
    if status == 1 && !last {
        return 2;
    }
    status
}

struct Reader {
    remaining: usize,
    delimiter: Option<u8>,
    raw: bool,
    escaped: bool,
    utf8: bool,
    pending: [u8; 4],
    pending_len: usize,
    ifs: Ifs,
    trim: [bool; 3],
    protected: Vec<u8>,
    trailing: usize,
    bytes: Vec<u8>,
    ceiling: usize,
}

async fn read_record(
    options: &Options<'_>,
    input: &Endpoint,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let count = options.count.maximum();
    let utf8 = !matches!(options.count, Count::Line)
        && printf::character_locale(state, context, work).await?;
    let ifs = Ifs::new(state, &context.cancel, usize::MAX, work)
        .await
        .map_err(error_status)?;
    let trim = if options.names.is_empty() || options.count.exact() {
        [false; 3]
    } else {
        [ifs.contains(' '), ifs.contains('\t'), ifs.contains('\n')]
    };
    let ceiling = count
        .saturating_mul(if utf8 { 4 } else { 1 })
        .min(context.limits().line_bytes);
    let protection_bytes = if options.raw { 0 } else { ceiling.div_ceil(8) };
    let chunk_bytes = if options.raw && options.count.exact() && !utf8 {
        count.min(4096).min(ceiling.saturating_add(1))
    } else {
        1
    };
    let storage_bytes = ceiling
        .saturating_add(protection_bytes)
        .saturating_add(chunk_bytes);
    work.admit_storage(storage_bytes).map_err(error_status)?;
    let _storage = context.admit_builtin_buffer(storage_bytes)?;
    let mut reader = Reader {
        remaining: count,
        delimiter: (!options.count.exact()).then_some(options.delimiter.unwrap_or(b'\n')),
        raw: options.raw,
        escaped: false,
        utf8,
        pending: [0; 4],
        pending_len: 0,
        ifs,
        trim,
        protected: Vec::new(),
        trailing: 0,
        bytes: Vec::new(),
        ceiling,
    };
    reader
        .bytes
        .try_reserve_exact(ceiling.min(256))
        .map_err(|_| 2)?;
    let mut chunk = Vec::new();
    chunk.try_reserve_exact(chunk_bytes).map_err(|_| 2)?;
    chunk.resize(chunk_bytes, 0);
    let mut timer = read_timer(options, input, context)?;
    let elapsed = match timer.as_mut() {
        Some(sleep) => timeout::arm(sleep).await,
        None => false,
    };
    let code = if elapsed {
        if context.cancel.probe_now() {
            return Err(130);
        }
        142
    } else {
        reader
            .read(input, &mut chunk, timer.as_mut(), context, work)
            .await?
    };
    drop(timer);
    reader.finish()?;
    assign(reader, code, options, state, fds, context, work).await
}

fn read_timer(
    options: &Options<'_>,
    input: &Endpoint,
    context: &Context,
) -> Result<Option<crate::executor::Sleep>, i32> {
    let Some(Timeout::After(duration)) = options.timeout else {
        return Ok(None);
    };
    if options.count.maximum() == 0
        || input.descriptor_kind().map_err(|error| error.status())? == DescriptorKind::Regular
    {
        return Ok(None);
    }
    let deadline = Instant::now().checked_add(duration).ok_or(2)?;
    Ok(Some(context.sleep_until(deadline)))
}

async fn read_chunk(
    input: &Endpoint,
    chunk: &mut [u8],
    cancel: &crate::executor::Cancel,
    timer: Option<&mut crate::executor::Sleep>,
) -> Result<Option<usize>, IoError> {
    if timer.is_some() {
        return timeout::read(input, chunk, cancel, timer).await;
    }
    if cancel.is_cancelled() {
        return Err(IoError::Cancelled);
    }
    // Subscribe to cancellation only if the endpoint needs to wait.
    let mut read = std::pin::pin!(input.read(chunk));
    let ready = poll_fn(|cx| Poll::Ready(read.as_mut().poll(cx))).await;
    let result = match ready {
        Poll::Ready(result) => result,
        Poll::Pending => cancel.run(read).await.map_err(|_| IoError::Cancelled)?,
    };
    result.map(Some)
}

fn reserve(buffer: &mut Vec<u8>, needed: usize, ceiling: usize) -> Result<(), i32> {
    if needed <= buffer.capacity() {
        return Ok(());
    }
    let capacity = needed.max(buffer.capacity().saturating_mul(2)).min(ceiling);
    buffer
        .try_reserve_exact(capacity - buffer.len())
        .map_err(|_| 2)
}

impl Reader {
    async fn read(
        &mut self,
        input: &Endpoint,
        chunk: &mut [u8],
        mut timer: Option<&mut crate::executor::Sleep>,
        context: &Context,
        work: &mut Work,
    ) -> Result<i32, i32> {
        while self.remaining != 0 {
            work.checkpoint(&context.cancel)
                .await
                .map_err(error_status)?;
            // Only raw C exact reads use a multi-byte buffer. Stop at the
            // requested count or the first byte that can exceed a limit.
            let length = chunk
                .len()
                .min(self.remaining)
                .min(work.remaining.saturating_add(1))
                .min((self.ceiling - self.bytes.len()).saturating_add(1));
            let Some(read) = read_chunk(
                input,
                &mut chunk[..length],
                &context.cancel,
                timer.as_deref_mut(),
            )
            .await
            .map_err(|error| error.status())?
            else {
                return Ok(142);
            };
            if read == 0 {
                return Ok(1);
            }
            if self.consume(&chunk[..read], context, work).await? {
                return Ok(0);
            }
        }
        Ok(0)
    }

    async fn consume(
        &mut self,
        bytes: &[u8],
        context: &Context,
        work: &mut Work,
    ) -> Result<bool, i32> {
        if bytes.len() > 1 {
            work.checkpoint_steps(bytes.len() - 1, &context.cancel)
                .await
                .map_err(error_status)?;
        }
        for &byte in bytes {
            if self.byte(byte)? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn byte(&mut self, byte: u8) -> Result<bool, i32> {
        if byte == 0 {
            let delimiter = self.delimiter == Some(0) && !self.escaped;
            self.escaped = false;
            return Ok(delimiter);
        }
        if self.pending_len != 0 {
            return self.character_byte(byte);
        }
        if !self.raw && !self.escaped && byte == b'\\' {
            self.escaped = true;
            return Ok(false);
        }
        if byte == b'\n' && !self.raw && self.escaped {
            self.escaped = false;
            return Ok(false);
        }
        if self.delimiter == Some(byte) && !self.escaped {
            return Ok(true);
        }
        self.character_byte(byte)
    }

    fn character_byte(&mut self, byte: u8) -> Result<bool, i32> {
        self.pending[self.pending_len] = byte;
        self.pending_len += 1;
        if self.utf8 && !complete_character(&self.pending[..self.pending_len])? {
            return Ok(false);
        }
        let whitespace = match byte {
            b' ' => self.trim[0],
            b'\t' => self.trim[1],
            b'\n' => self.trim[2],
            _ => false,
        } && !self.escaped;
        self.append(whitespace)?;
        self.remaining -= 1;
        self.escaped = false;
        self.pending_len = 0;
        Ok(false)
    }

    fn append(&mut self, whitespace: bool) -> Result<(), i32> {
        if whitespace && self.bytes.is_empty() {
            return Ok(());
        }
        let end = self.bytes.len() + self.pending_len;
        if end > self.ceiling {
            return Err(2);
        }
        reserve(&mut self.bytes, end, self.ceiling)?;
        if self.escaped {
            let index = self.bytes.len();
            let bucket = index / 8;
            if bucket >= self.protected.len() {
                reserve(&mut self.protected, bucket + 1, self.ceiling.div_ceil(8))?;
                self.protected.resize(bucket + 1, 0);
            }
            self.protected[bucket] |= 1 << (index % 8);
        }
        self.bytes
            .extend_from_slice(&self.pending[..self.pending_len]);
        self.trailing = if whitespace {
            self.trailing + self.pending_len
        } else {
            0
        };
        Ok(())
    }

    fn finish(&mut self) -> Result<(), i32> {
        if self.pending_len != 0 {
            return Err(2);
        }
        self.bytes.truncate(self.bytes.len() - self.trailing);
        Ok(())
    }
}

fn complete_character(bytes: &[u8]) -> Result<bool, i32> {
    match std::str::from_utf8(bytes) {
        Ok(_) => Ok(true),
        Err(error) if error.error_len().is_none() && bytes.len() < 4 => Ok(false),
        Err(_) => Err(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_buffers_grow_and_keep_only_the_escaped_positions() {
        let mut reader = Reader {
            remaining: 1024,
            delimiter: Some(b'\n'),
            raw: false,
            escaped: false,
            utf8: false,
            pending: [0; 4],
            pending_len: 0,
            ifs: Ifs::default(),
            trim: [false; 3],
            protected: Vec::new(),
            trailing: 0,
            bytes: Vec::with_capacity(256),
            ceiling: 515,
        };
        for _ in 0..510 {
            assert!(!reader.byte(b'a').unwrap());
        }
        assert_eq!(reader.protected.capacity(), 0);
        for &byte in b"\\:bcd\\:" {
            assert!(!reader.byte(byte).unwrap());
        }
        assert!(reader.byte(b'\n').unwrap());
        assert_eq!(&reader.bytes[510..], b":bcd:");
        assert_eq!(reader.bytes.capacity(), 515);
        assert_eq!(reader.protected[63], 1 << 6);
        assert_eq!(reader.protected[64], 1 << 2);
        assert_eq!(reader.byte(b'z'), Err(2));
    }
}
