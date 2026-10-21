mod fields;

use super::{diagnose, endpoint, error_status, printf};
use crate::{
    expand::Work,
    interpreter::{Context, Outcome},
    io::{Endpoint, FdTable},
    state::{SharedState, State},
};

#[derive(Default)]
struct Options<'a> {
    fd: u32,
    raw: bool,
    count: Option<usize>,
    names: &'a [String],
}

async fn options<'a>(
    args: &'a [String],
    context: &Context,
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
        option_word(arg, &mut iter, &mut result, context, work).await?;
    }
    result.names = iter.as_slice();
    Ok(result)
}

async fn option_word<'a>(
    arg: &'a str,
    iter: &mut std::slice::Iter<'a, String>,
    options: &mut Options<'a>,
    context: &Context,
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
        if !matches!(flag, b'n' | b'u') {
            return Err(2);
        }
        let value = if index + 1 < arg.len() {
            &arg[index + 1..]
        } else {
            iter.next().map(String::as_str).ok_or(2)?
        };
        if flag == b'n' {
            options.count = Some(count(value, context, work).await?);
            return Ok(());
        }
        options.fd = value
            .parse::<i64>()
            .ok()
            .and_then(|fd| u32::try_from(fd).ok())
            .ok_or(2)?;
        return Ok(());
    }
    Ok(())
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
    let options = options(args, context, work).await?;
    if let Some(name) = options.names.first() {
        validate_name(name, fds, context, work).await?;
    }
    let input = endpoint(fds, options.fd)?;
    read_record(&options, &input, state, fds, context, work).await
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
        assign_value("REPLY", text, state, context, work).await?;
        return Ok(Outcome::status(code));
    }
    let mut fields = fields::Fields::new(text, &reader.protected, reader.members);
    for (index, name) in options.names.iter().enumerate() {
        validate_name(name, fds, context, work).await?;
        let last = index + 1 == options.names.len();
        let value = fields.value(last, context, work).await?;
        assign_value(name, value, state, context, work).await?;
    }
    Ok(Outcome::status(code))
}

struct Reader {
    remaining: usize,
    raw: bool,
    escaped: bool,
    utf8: bool,
    pending: [u8; 4],
    pending_len: usize,
    members: crate::state::IfsMembers,
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
    let count = options.count.unwrap_or(usize::MAX);
    let utf8 = options.count.is_some() && printf::character_locale(state, context, work).await?;
    let members = State::admit_ifs_members(state, &context.cancel, work)
        .await
        .map_err(error_status)?;
    let trim = if options.names.is_empty() {
        [false; 3]
    } else {
        [
            members.contains(' '),
            members.contains('\t'),
            members.contains('\n'),
        ]
    };
    let ceiling = count
        .saturating_mul(if utf8 { 4 } else { 1 })
        .min(context.limits().line_bytes);
    let protection_bytes = if options.raw { 0 } else { ceiling.div_ceil(8) };
    let storage_bytes = ceiling.saturating_add(protection_bytes);
    work.admit_storage(storage_bytes).map_err(error_status)?;
    let _storage = context.admit_builtin_buffer(storage_bytes)?;
    let mut reader = Reader {
        remaining: count,
        raw: options.raw,
        escaped: false,
        utf8,
        pending: [0; 4],
        pending_len: 0,
        members,
        trim,
        protected: Vec::new(),
        trailing: 0,
        bytes: Vec::new(),
        ceiling,
    };
    reader.bytes.try_reserve_exact(ceiling).map_err(|_| 2)?;
    reader
        .protected
        .try_reserve_exact(protection_bytes)
        .map_err(|_| 2)?;
    reader.protected.resize(protection_bytes, 0);
    let mut byte = [0];
    let code = loop {
        if reader.remaining == 0 {
            break 0;
        }
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if input
            .read_cancelled(&mut byte, &context.cancel)
            .await
            .map_err(|e| e.status())?
            == 0
        {
            break 1;
        }
        if reader.byte(byte[0])? {
            break 0;
        }
    };
    reader.finish()?;
    assign(reader, code, options, state, fds, context, work).await
}

impl Reader {
    fn byte(&mut self, byte: u8) -> Result<bool, i32> {
        if byte == 0 {
            return Ok(false);
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
        if byte == b'\n' {
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
        if self.bytes.len().saturating_add(self.pending_len) > self.ceiling {
            return Err(2);
        }
        if self.escaped {
            let index = self.bytes.len();
            self.protected[index / 8] |= 1 << (index % 8);
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
