//! Original counted scalar read. Uncounted reads retain the existing line reader.
use super::{endpoint, error_status, printf};
use crate::{
    executor::Budget,
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
    name: Option<&'a str>,
}

async fn options<'a>(
    args: &'a [String],
    context: &Context,
    work: &mut Work,
) -> Result<Options<'a>, i32> {
    let mut result = Options::default();
    let mut iter = args.iter().map(String::as_str);
    while let Some(arg) = iter.next() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if arg == "--" {
            break;
        }
        if !arg.starts_with('-') || arg == "-" {
            result.name = Some(arg);
            break;
        }
        option_word(arg, &mut iter, &mut result, context, work).await?;
    }
    if result.name.is_none() {
        result.name = iter.next();
    }
    if iter.next().is_some() {
        return Err(2);
    }
    Ok(result)
}

async fn option_word<'a>(
    arg: &'a str,
    iter: &mut impl Iterator<Item = &'a str>,
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
            iter.next().ok_or(2)?
        };
        if flag == b'n' {
            options.count = Some(count(value, context, work).await?);
            return Ok(());
        }
        options.fd = value.parse().map_err(|_| 2)?;
        return Ok(());
    }
    Ok(())
}

async fn count(value: &str, context: &Context, work: &mut Work) -> Result<usize, i32> {
    let value = value.trim_matches(|ch: char| ch.is_ascii_whitespace());
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
    let input = endpoint(fds, options.fd)?;
    if let Some(count) = options.count {
        return counted(&options, count, &input, state, context, work).await;
    }
    let (bytes, code) = line(&input, context).await?;
    assign(bytes, code, &options, state, context, work).await
}

async fn assign(
    bytes: Vec<u8>,
    code: i32,
    options: &Options<'_>,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let name = options.name.unwrap_or("REPLY");
    State::admit_assignment(state, name, bytes.len(), &context.cancel, work)
        .await
        .map_err(error_status)?;
    state
        .borrow_mut()
        .assign_parameter(name.to_owned(), String::from_utf8(bytes).map_err(|_| 2)?)?;
    Ok(Outcome::status(code))
}

async fn line(input: &Endpoint, context: &Context) -> Result<(Vec<u8>, i32), i32> {
    let mut bytes = Vec::new();
    let mut byte = [0];
    let mut budget = Budget::default();
    loop {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if input
            .read_cancelled(&mut byte, &context.cancel)
            .await
            .map_err(|e| e.status())?
            == 0
        {
            return Ok((bytes, 1));
        }
        if byte[0] == b'\n' {
            return Ok((bytes, 0));
        }
        if bytes.len() >= context.limits().line_bytes {
            return Err(2);
        }
        bytes.push(byte[0]);
    }
}

struct Reader {
    remaining: usize,
    raw: bool,
    escaped: bool,
    utf8: bool,
    pending: [u8; 4],
    pending_len: usize,
    trim: [bool; 3],
    trailing: usize,
    bytes: Vec<u8>,
    ceiling: usize,
}

async fn counted(
    options: &Options<'_>,
    count: usize,
    input: &Endpoint,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let utf8 = printf::character_locale(state, context, work).await?;
    let trim = if options.name.is_some() {
        let members = State::admit_ifs_members(state, &context.cancel, work)
            .await
            .map_err(error_status)?;
        [
            members.contains(' '),
            members.contains('\t'),
            members.contains('\n'),
        ]
    } else {
        [false; 3]
    };
    let ceiling = count
        .saturating_mul(if utf8 { 4 } else { 1 })
        .min(context.limits().line_bytes);
    work.admit_storage(ceiling).map_err(error_status)?;
    let _storage = context.admit_builtin_buffer(ceiling)?;
    let mut reader = Reader {
        remaining: count,
        raw: options.raw,
        escaped: false,
        utf8,
        pending: [0; 4],
        pending_len: 0,
        trim,
        trailing: 0,
        bytes: Vec::new(),
        ceiling,
    };
    reader.bytes.try_reserve_exact(ceiling).map_err(|_| 2)?;
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
    let (bytes, code) = reader.finish(code)?;
    assign(bytes, code, options, state, context, work).await
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
        self.bytes
            .extend_from_slice(&self.pending[..self.pending_len]);
        self.trailing = if whitespace {
            self.trailing + self.pending_len
        } else {
            0
        };
        Ok(())
    }

    fn finish(mut self, code: i32) -> Result<(Vec<u8>, i32), i32> {
        if self.pending_len != 0 {
            return Err(2);
        }
        self.bytes.truncate(self.bytes.len() - self.trailing);
        Ok((self.bytes, code))
    }
}

fn complete_character(bytes: &[u8]) -> Result<bool, i32> {
    match std::str::from_utf8(bytes) {
        Ok(_) => Ok(true),
        Err(error) if error.error_len().is_none() && bytes.len() < 4 => Ok(false),
        Err(_) => Err(2),
    }
}
