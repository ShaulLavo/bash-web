use super::{
    Context, FdTable, Outcome, SharedState, State, Work, diagnose, error_status, scan_bytes, write,
};
use crate::{expand::Printability, state::DeclarationView};

pub(super) async fn append_scalar(
    name: &str,
    value: String,
    local: bool,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    if !local {
        State::admit_scalar_access(state, name, &context.cancel, work)
            .await
            .map_err(error_status)?;
    }
    let bytes = state
        .borrow()
        .declaration_append_base(name, local)
        .map_or(0, str::len);
    scan_bytes(bytes, context, work).await?;
    let state = state.borrow();
    let old = state.declaration_append_base(name, local).unwrap_or("");
    let bytes = old.len().checked_add(value.len()).ok_or(2)?;
    if bytes > context.limits().expansion_bytes {
        return Err(2);
    }
    work.admit_storage(bytes).map_err(error_status)?;
    let mut joined = String::with_capacity(bytes);
    joined.push_str(old);
    joined.push_str(&value);
    Ok(joined)
}

struct DeclarationSnapshot {
    value: Option<String>,
    attributes: [bool; 3],
}

pub(super) async fn print(
    builtin: &str,
    names: impl Iterator<Item = String>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    let utf8 = super::printf::character_locale(state, context, work).await?;
    let printability = Printability::new(utf8)?;
    let mut status = 0;
    let mut count = 0;
    for name in names {
        count += 1;
        scan_bytes(name.len(), context, work).await?;
        let Some(DeclarationSnapshot { value, attributes }) =
            snapshot(&name, state, context, work).await?
        else {
            missing(builtin, &name, fds, context, work).await?;
            status = 1;
            continue;
        };
        let line = render(
            &name,
            value.as_deref(),
            attributes,
            utf8,
            &printability,
            context,
            work,
        )
        .await?;
        write(fds, line.as_bytes(), context).await?;
        let bytes = line.len() + value.as_ref().map_or(0, String::len);
        drop((line, value));
        work.release_storage(bytes);
    }
    if count == 0 {
        return Err(2);
    }
    Ok(Outcome::status(status))
}

async fn snapshot(
    name: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<Option<DeclarationSnapshot>, i32> {
    let bytes = state
        .borrow()
        .declaration(name)
        .map_err(|()| 2)?
        .and_then(|view| view.value)
        .map_or(0, str::len);
    scan_bytes(bytes, context, work).await?;
    let state = state.borrow();
    let Some(DeclarationView {
        value,
        nameref,
        readonly,
        exported,
    }) = state.declaration(name).map_err(|()| 2)?
    else {
        return Ok(None);
    };
    work.admit_storage(value.map_or(0, str::len))
        .map_err(error_status)?;
    Ok(Some(DeclarationSnapshot {
        value: value.map(str::to_owned),
        attributes: [nameref, readonly, exported],
    }))
}

async fn missing(
    builtin: &str,
    name: &str,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let bytes = builtin.len().saturating_add(name.len()).saturating_add(14);
    work.admit_storage(bytes).map_err(error_status)?;
    scan_bytes(bytes, context, work).await?;
    let message = format!("{builtin}: {name}: not found\n");
    let result = diagnose(fds, &message, context).await;
    drop(message);
    work.release_storage(bytes);
    result
}

async fn render(
    name: &str,
    value: Option<&str>,
    attributes: [bool; 3],
    utf8: bool,
    printability: &Printability,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    let mut ansi = false;
    for ch in value.unwrap_or("").chars() {
        scan_bytes(ch.len_utf8(), context, work).await?;
        ansi |= !printable(ch, utf8, printability);
    }
    work.admit_storage(name.len().saturating_add(14))
        .map_err(error_status)?;
    let mut line = String::from("declare -");
    for (set, flag) in attributes.into_iter().zip(['n', 'r', 'x']) {
        if set {
            line.push(flag);
        }
    }
    if line.ends_with('-') {
        line.push('-');
    }
    line.push(' ');
    line.push_str(name);
    work.release_storage(name.len() + 14 - (line.len() + 1));
    if let Some(value) = value {
        quoted(&mut line, value, ansi, utf8, printability, context, work).await?;
    }
    line.push('\n');
    Ok(line)
}

fn printable(ch: char, utf8: bool, printability: &Printability) -> bool {
    if ch.is_ascii() {
        return (' '..='~').contains(&ch);
    }
    utf8 && !ch.is_control() && !matches!(ch, '\u{2028}' | '\u{2029}') && printability.printable(ch)
}

async fn quoted(
    line: &mut String,
    value: &str,
    ansi: bool,
    utf8: bool,
    printability: &Printability,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let delimiters = if ansi { "=$'" } else { "=\"" };
    work.admit_storage(delimiters.len() + 1)
        .map_err(error_status)?;
    line.push_str(delimiters);
    for ch in value.chars() {
        scan_bytes(ch.len_utf8(), context, work).await?;
        let mut buffer = [0; 16];
        let encoded = encode(ch, ansi, utf8, printability, &mut buffer);
        work.admit_storage(encoded.len()).map_err(error_status)?;
        line.push_str(encoded);
    }
    line.push(if ansi { '\'' } else { '"' });
    Ok(())
}

fn encode<'a>(
    ch: char,
    ansi: bool,
    utf8: bool,
    printability: &Printability,
    buffer: &'a mut [u8; 16],
) -> &'a str {
    let escape = match (ansi, ch) {
        (_, '\\') => Some("\\\\"),
        (false, '"') => Some("\\\""),
        (false, '$') => Some("\\$"),
        (false, '`') => Some("\\`"),
        (true, '\'') => Some("\\'"),
        (true, '\x07') => Some("\\a"),
        (true, '\x08') => Some("\\b"),
        (true, '\t') => Some("\\t"),
        (true, '\n') => Some("\\n"),
        (true, '\x0b') => Some("\\v"),
        (true, '\x0c') => Some("\\f"),
        (true, '\r') => Some("\\r"),
        (true, '\x1b') => Some("\\E"),
        _ => None,
    };
    if let Some(escape) = escape {
        return escape;
    }
    if printable(ch, utf8, printability) {
        return ch.encode_utf8(buffer);
    }
    let mut raw = [0; 4];
    let bytes = ch.encode_utf8(&mut raw).as_bytes();
    for (index, byte) in bytes.iter().copied().enumerate() {
        let offset = index * 4;
        buffer[offset..offset + 4].copy_from_slice(&[
            b'\\',
            b'0' + (byte >> 6),
            b'0' + ((byte >> 3) & 7),
            b'0' + (byte & 7),
        ]);
    }
    std::str::from_utf8(&buffer[..bytes.len() * 4]).expect("octal escapes are ASCII")
}
