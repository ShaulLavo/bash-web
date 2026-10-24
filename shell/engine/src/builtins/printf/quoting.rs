use super::{PrintFailure, Printer};
use crate::expand::Printability;

#[derive(Clone, Copy)]
enum Style {
    Empty,
    Backslash,
    Single,
    Ansi,
}
impl Style {
    fn prefix(self) -> &'static [u8] {
        match self {
            Self::Empty => b"''",
            Self::Backslash => b"",
            Self::Single => b"'",
            Self::Ansi => b"$'",
        }
    }
    fn suffix(self) -> &'static [u8] {
        match self {
            Self::Single | Self::Ansi => b"'",
            _ => b"",
        }
    }
}

pub(super) struct Quoted<'a> {
    value: &'a [u8],
    style: Style,
    utf8: bool,
    classification: Printability,
}
impl<'a> Quoted<'a> {
    pub async fn new(
        value: &'a [u8],
        alternate: bool,
        printer: &mut Printer<'_>,
    ) -> Result<Self, PrintFailure> {
        let mut quoted = Self {
            value,
            style: if alternate {
                Style::Single
            } else {
                Style::Backslash
            },
            utf8: printer.utf8,
            classification: Printability::new(printer.utf8)?,
        };
        if value.is_empty() {
            quoted.style = Style::Empty;
            return Ok(quoted);
        }
        let mut offset = 0;
        while offset < value.len() {
            let (length, printable) = quoted.character(offset);
            printer.scan(length).await?;
            if !printable {
                quoted.style = Style::Ansi;
            }
            offset += length;
        }
        Ok(quoted)
    }
    fn character(&self, offset: usize) -> (usize, bool) {
        let byte = self.value[offset];
        if byte < 0x80 || !self.utf8 {
            return (1, (b' '..=b'~').contains(&byte));
        }
        let length = match byte {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return (1, false),
        };
        let Some(bytes) = self.value.get(offset..offset + length) else {
            return (1, false);
        };
        let Some(character) = std::str::from_utf8(bytes)
            .ok()
            .and_then(|s| s.chars().next())
        else {
            return (1, false);
        };
        (length, self.classification.printable(character))
    }
    fn piece(&self, offset: usize) -> Piece {
        let byte = self.value[offset];
        if matches!(self.style, Style::Single) && byte == b'\'' {
            return Piece::new(b"'\\''", 1);
        }
        if matches!(self.style, Style::Backslash) && backslash(self.value, offset) {
            return Piece::new(&[b'\\', byte], 1);
        }
        let (length, printable) = self.character(offset);
        if matches!(self.style, Style::Ansi) {
            return ansi_piece(byte, &self.value[offset..offset + length], printable);
        }
        Piece::new(&self.value[offset..offset + length], length)
    }
    pub async fn walk(
        &self,
        precision: Option<usize>,
        emit: bool,
        printer: &mut Printer<'_>,
    ) -> Result<usize, PrintFailure> {
        let mut sink = Sink {
            remaining: precision.unwrap_or(usize::MAX),
            length: 0,
            emit,
        };
        sink.piece(self.style.prefix(), printer).await?;
        let mut offset = 0;
        while offset < self.value.len() && sink.remaining != 0 {
            let piece = self.piece(offset);
            sink.piece(&piece.bytes[..piece.length], printer).await?;
            offset += piece.consumed;
        }
        sink.piece(self.style.suffix(), printer).await?;
        Ok(sink.length)
    }
}

struct Sink {
    remaining: usize,
    length: usize,
    emit: bool,
}
impl Sink {
    async fn piece(&mut self, bytes: &[u8], printer: &mut Printer<'_>) -> Result<(), PrintFailure> {
        let bytes = &bytes[..bytes.len().min(self.remaining)];
        printer.scan(bytes.len()).await?;
        self.length = self.length.checked_add(bytes.len()).ok_or(2)?;
        self.remaining -= bytes.len();
        if self.emit {
            printer.emit(1, bytes).await?;
        }
        Ok(())
    }
}
struct Piece {
    bytes: [u8; 4],
    length: usize,
    consumed: usize,
}
impl Piece {
    fn new(bytes: &[u8], consumed: usize) -> Self {
        let mut piece = Self {
            bytes: [0; 4],
            length: bytes.len(),
            consumed,
        };
        piece.bytes[..bytes.len()].copy_from_slice(bytes);
        piece
    }
}
fn backslash(value: &[u8], offset: usize) -> bool {
    match value[offset] {
        b' ' | b'!' | b'"' | b'$' | b'&' | b'\'' | b'(' | b')' | b'*' | b',' | b';' | b'<'
        | b'>' | b'?' | b'[' | b'\\' | b']' | b'^' | b'`' | b'{' | b'|' | b'}' => true,
        b'#' => offset == 0,
        b'~' => offset == 0 || matches!(value[offset - 1], b':' | b'='),
        _ => false,
    }
}
fn ansi_piece(byte: u8, character: &[u8], printable: bool) -> Piece {
    let escape = match byte {
        7 => Some(b'a'),
        8 => Some(b'b'),
        9 => Some(b't'),
        10 => Some(b'n'),
        11 => Some(b'v'),
        12 => Some(b'f'),
        13 => Some(b'r'),
        27 => Some(b'E'),
        b'\\' | b'\'' => Some(byte),
        _ => None,
    };
    if let Some(code) = escape {
        return Piece::new(&[b'\\', code], 1);
    }
    if printable {
        return Piece::new(character, character.len());
    }
    Piece::new(
        &[
            b'\\',
            b'0' + (byte >> 6),
            b'0' + ((byte >> 3) & 7),
            b'0' + (byte & 7),
        ],
        1,
    )
}
