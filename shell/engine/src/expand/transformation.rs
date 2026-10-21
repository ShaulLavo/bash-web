//! Original scalar parameter transformations, `${name@op}` for Q, E, u, U,
//! L, K, k, A and a. GNU Bash 5.3 is the behavior oracle; no upstream code is
//! copied. Arrays, prompt expansion (@P) and indirect names stay unsupported.
use super::{
    Error, Expansion, Printability, Protection, TransformContext, admit_string_growth,
    admit_vec_slot, bounded, case::Locale, operand, utf8_locale,
};
use crate::state::{ScalarResolution, SharedState, State};

/// A snapshot of the transformed parameter, taken before any suspension.
struct Subject {
    value: Option<String>,
    /// The resolved variable name; empty for special and positional parameters.
    target: String,
    readonly: bool,
    exported: bool,
    /// Declared in the current function scope, which Bash's `@A` spells with `declare`.
    local: bool,
}
impl Subject {
    fn attributes(&self) -> &'static str {
        match (self.readonly, self.exported) {
            (true, true) => "rx",
            (true, false) => "r",
            (false, true) => "x",
            (false, false) => "",
        }
    }
}

impl Expansion<'_> {
    pub(super) async fn transformation(
        &mut self,
        name: &str,
        operator: char,
        context: TransformContext<'_>,
    ) -> Result<(), Error> {
        let TransformContext {
            state, protected, ..
        } = context;
        if !transformable(name) {
            return Err(2.into());
        }
        // Bash reports an unbound name before it judges the operator.
        self.require_bound(name, state).await?;
        let subject = self.subject(name, state)?;
        let result = self.transform(&subject, operator, state).await?;
        self.admit_pattern_snapshot(&result).await?;
        self.segment(&result, Protection::expansion(protected, state), protected)
            .await
    }
    fn subject(&mut self, name: &str, state: &SharedState) -> Result<Subject, Error> {
        let max = self.snapshot_max();
        let s = state.borrow();
        let mut subject = Subject {
            value: None,
            target: String::new(),
            readonly: false,
            exported: false,
            local: false,
        };
        if operand::scalar_name(name) {
            let ScalarResolution::Target(target) = s.resolve_scalar_target(name) else {
                return Ok(subject);
            };
            self.work.admit_storage(target.len())?;
            subject.target = target.to_owned();
            subject.readonly = s.is_readonly(target);
            subject.exported = s.exported_bindings().contains(target);
            subject.local = s.is_current_local(target);
        }
        if !parameter_set(&s, name) {
            return Ok(subject);
        }
        if s.dynamic_parameter(name) {
            self.work.admit_storage(State::DYNAMIC_PARAMETER_BYTES)?;
        } else if matches!(name, "?" | "#") {
            self.work.admit_storage(20)?;
        } else {
            self.work.admit_storage(s.parameter(name).len())?;
        }
        subject.value = Some(bounded(s.parameter(name), max)?);
        Ok(subject)
    }
    async fn transform(
        &mut self,
        subject: &Subject,
        operator: char,
        state: &SharedState,
    ) -> Result<String, Error> {
        let mut out = String::new();
        if operator == 'a' {
            self.push_text(&mut out, subject.attributes()).await?;
            return Ok(out);
        }
        if operator == 'A' {
            self.assignment(subject, state, &mut out).await?;
            return Ok(out);
        }
        // Every other operator, valid or not, expands an unset name to nothing.
        let Some(value) = subject.value.as_deref() else {
            return Ok(out);
        };
        match operator {
            'Q' | 'K' | 'k' => {
                let utf8 = self.utf8(state).await?;
                self.quote(value, utf8, &mut out).await?;
            }
            'E' => return self.escapes(value, state).await,
            'u' | 'U' | 'L' => self.change(value, operator, state, &mut out).await?,
            _ => return Err(2.into()),
        }
        Ok(out)
    }
    async fn assignment(
        &mut self,
        subject: &Subject,
        state: &SharedState,
        out: &mut String,
    ) -> Result<(), Error> {
        let attributes = subject.attributes();
        let declared = subject.local || !attributes.is_empty();
        if subject.target.is_empty() || (subject.value.is_none() && !declared) {
            return Ok(());
        }
        if declared {
            self.push_text(out, "declare ").await?;
        }
        if !attributes.is_empty() {
            self.push_text(out, "-").await?;
            self.push_text(out, attributes).await?;
            self.push_text(out, " ").await?;
        }
        self.push_text(out, &subject.target).await?;
        let Some(value) = subject.value.as_deref() else {
            return Ok(());
        };
        self.push_text(out, "=").await?;
        let utf8 = self.utf8(state).await?;
        self.quote(value, utf8, out).await
    }
    /// Bash's reusable quoting: `''` when empty, ANSI-C `$'...'` when any
    /// character is unprintable in the locale, otherwise single quotes.
    async fn quote(&mut self, value: &str, utf8: bool, out: &mut String) -> Result<(), Error> {
        if value.is_empty() {
            return self.push_text(out, "''").await;
        }
        if value == "'" {
            return self.push_text(out, "\\'").await;
        }
        let printability = Printability::new(utf8)?;
        let mut ansi = false;
        for ch in value.chars() {
            self.work.checkpoint(self.cancel).await?;
            ansi |= !printable(ch, utf8, &printability);
        }
        if !ansi {
            self.push_text(out, "'").await?;
            let mut buffer = [0; 4];
            for ch in value.chars() {
                let text = if ch == '\'' {
                    "'\\''"
                } else {
                    char_text(ch, &mut buffer)
                };
                self.push_text(out, text).await?;
            }
            return self.push_text(out, "'").await;
        }
        self.push_text(out, "$'").await?;
        for ch in value.chars() {
            self.ansi_character(ch, printable(ch, utf8, &printability), out)
                .await?;
        }
        self.push_text(out, "'").await
    }
    async fn ansi_character(
        &mut self,
        ch: char,
        printable: bool,
        out: &mut String,
    ) -> Result<(), Error> {
        if let Some(escape) = ansi_escape(ch) {
            return self.push_text(out, escape).await;
        }
        if printable {
            return self.push_text(out, char_text(ch, &mut [0; 4])).await;
        }
        for byte in char_text(ch, &mut [0; 4]).bytes() {
            let octal = [
                b'\\',
                b'0' + (byte >> 6),
                b'0' + ((byte >> 3) & 7),
                b'0' + (byte & 7),
            ];
            self.push_text(out, std::str::from_utf8(&octal).map_err(|_| 2)?)
                .await?;
        }
        Ok(())
    }
    /// Bash's `$'...'` decoding of the value. A decoded NUL ends the result;
    /// bytes that do not form UTF-8 are unsupported.
    async fn escapes(&mut self, value: &str, state: &SharedState) -> Result<String, Error> {
        let bytes = value.as_bytes();
        let mut out = Vec::new();
        let mut index = 0;
        let mut utf8 = None;
        while index < bytes.len() {
            self.work.checkpoint(self.cancel).await?;
            if needs_locale(&bytes[index..]) && utf8.is_none() {
                utf8 = Some(self.utf8(state).await?);
            }
            let unit = decode(&bytes[index..], utf8.unwrap_or(false))?;
            index += unit.consumed();
            let mut buffer = [0; 4];
            let decoded = unit.bytes(&mut buffer);
            let end = decoded.iter().position(|&byte| byte == 0);
            for &byte in &decoded[..end.unwrap_or(decoded.len())] {
                if out.len() >= self.raw_remaining {
                    return Err(2.into());
                }
                admit_vec_slot(&mut out, self.work)?;
                out.push(byte);
            }
            if end.is_some() {
                break;
            }
        }
        String::from_utf8(out).map_err(|_| 2.into())
    }
    async fn change(
        &mut self,
        value: &str,
        operator: char,
        state: &SharedState,
        out: &mut String,
    ) -> Result<(), Error> {
        let locale = Locale::from_state(state)?;
        for (index, ch) in value.chars().enumerate() {
            let mapped = match operator {
                'u' if index > 0 => ch,
                'L' => locale.map(ch, false)?,
                _ => locale.map(ch, true)?,
            };
            self.push_text(out, char_text(mapped, &mut [0; 4])).await?;
        }
        Ok(())
    }
    async fn utf8(&mut self, state: &SharedState) -> Result<bool, Error> {
        for name in ["LC_ALL", "LC_CTYPE", "LANG"] {
            State::admit_scalar_access(state, name, self.cancel, self.work).await?;
            let s = state.borrow();
            if let Some(locale) = s.scalar_parameter(name).filter(|value| !value.is_empty()) {
                return Ok(utf8_locale(locale));
            }
        }
        Ok(false)
    }
    async fn push_text(&mut self, out: &mut String, text: &str) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        if text.len() > self.raw_remaining.saturating_sub(out.len()) {
            return Err(2.into());
        }
        admit_string_growth(out, text.len(), self.work)?;
        out.push_str(text);
        Ok(())
    }
}

/// Scalar, special and positional names. `${!name@op}` and array forms are
/// outside this adapter.
fn transformable(name: &str) -> bool {
    operand::scalar_name(name)
        || matches!(name, "?" | "#")
        || (!name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()))
}

fn parameter_set(state: &State, name: &str) -> bool {
    if matches!(name, "?" | "#" | "0") {
        return true;
    }
    if operand::scalar_name(name) {
        return state.scalar_is_set(name);
    }
    name.parse::<usize>()
        .is_ok_and(|index| index <= state.positional().len())
}

fn printable(ch: char, utf8: bool, printability: &Printability) -> bool {
    if ch.is_ascii() {
        return (' '..='~').contains(&ch);
    }
    utf8 && printability.printable(ch)
}

fn char_text(ch: char, buffer: &mut [u8; 4]) -> &str {
    ch.encode_utf8(buffer)
}

fn ansi_escape(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\x07' => "\\a",
        '\x08' => "\\b",
        '\t' => "\\t",
        '\n' => "\\n",
        '\x0b' => "\\v",
        '\x0c' => "\\f",
        '\r' => "\\r",
        '\x1b' => "\\E",
        '\\' => "\\\\",
        '\'' => "\\'",
        _ => return None,
    })
}

/// One decoded `$'...'` unit and the input bytes it consumed.
enum Decoded<'a> {
    Byte(u8, usize),
    /// Input kept unchanged.
    Raw(&'a [u8]),
    Char(char, usize),
}
impl Decoded<'_> {
    fn consumed(&self) -> usize {
        match self {
            Self::Byte(_, consumed) | Self::Char(_, consumed) => *consumed,
            Self::Raw(bytes) => bytes.len(),
        }
    }
    fn bytes<'b>(&'b self, buffer: &'b mut [u8; 4]) -> &'b [u8] {
        match self {
            Self::Byte(byte, _) => std::slice::from_ref(byte),
            Self::Raw(bytes) => bytes,
            Self::Char(ch, _) => ch.encode_utf8(buffer).as_bytes(),
        }
    }
}

fn needs_locale(input: &[u8]) -> bool {
    matches!(input, [b'\\', b'u' | b'U', digit, ..] if digit.is_ascii_hexdigit())
}

/// `$'...'` escapes that stand for one byte.
const SIMPLE_ESCAPES: [(u8, u8); 13] = [
    (b'a', 7),
    (b'b', 8),
    (b'e', 27),
    (b'E', 27),
    (b'f', 12),
    (b'n', 10),
    (b'r', 13),
    (b't', 9),
    (b'v', 11),
    (b'\\', b'\\'),
    (b'\'', b'\''),
    (b'"', b'"'),
    (b'?', b'?'),
];

fn decode(input: &[u8], utf8: bool) -> Result<Decoded<'_>, Error> {
    let [b'\\', code, rest @ ..] = input else {
        return Ok(Decoded::Raw(&input[..1]));
    };
    let simple = SIMPLE_ESCAPES
        .iter()
        .find(|(escape, _)| escape == code)
        .map(|&(_, byte)| byte);
    if let Some(byte) = simple {
        return Ok(Decoded::Byte(byte, 2));
    }
    match (code, rest.first()) {
        (b'c', Some(&next)) => Ok(Decoded::Byte(control(next), 3)),
        (b'0'..=b'7', _) => Ok(octal(input)),
        (b'x' | b'u' | b'U', Some(next)) if next.is_ascii_hexdigit() => hexadecimal(input, utf8),
        _ => Ok(Decoded::Raw(&input[..2])),
    }
}

fn control(byte: u8) -> u8 {
    if byte == b'?' {
        return 0x7f;
    }
    byte.to_ascii_uppercase() & 0x1f
}

fn octal(input: &[u8]) -> Decoded<'_> {
    let digits = input[1..]
        .iter()
        .take(3)
        .take_while(|byte| matches!(byte, b'0'..=b'7'))
        .count();
    let value = input[1..=digits]
        .iter()
        .fold(0u32, |value, digit| value * 8 + u32::from(digit - b'0'));
    Decoded::Byte(value as u8, digits + 1)
}

fn hexadecimal(input: &[u8], utf8: bool) -> Result<Decoded<'_>, Error> {
    let limit = match input[1] {
        b'x' => 2,
        b'u' => 4,
        _ => 8,
    };
    let digits = input[2..]
        .iter()
        .take(limit)
        .take_while(|byte| byte.is_ascii_hexdigit())
        .count();
    let text = std::str::from_utf8(&input[2..2 + digits]).map_err(|_| 2)?;
    let value = u32::from_str_radix(text, 16).map_err(|_| 2)?;
    if input[1] == b'x' || value < 0x80 {
        return Ok(Decoded::Byte(value as u8, digits + 2));
    }
    // Other locales would need Bash's iconv fallback; they stay unsupported.
    let ch = char::from_u32(value).filter(|_| utf8).ok_or(2)?;
    Ok(Decoded::Char(ch, digits + 2))
}
