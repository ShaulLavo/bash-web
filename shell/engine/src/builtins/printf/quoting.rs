use super::Printer;

#[cfg(not(target_os = "wasi"))]
use std::ffi::c_void;

unsafe extern "C" {
    #[cfg(target_os = "wasi")]
    fn iswprint(character: u32) -> i32;
    #[cfg(not(target_os = "wasi"))]
    fn iswprint_l(character: u32, locale: *mut c_void) -> i32;
    #[cfg(not(target_os = "wasi"))]
    fn newlocale(mask: i32, name: *const std::ffi::c_char, base: *mut c_void) -> *mut c_void;
    #[cfg(not(target_os = "wasi"))]
    fn freelocale(locale: *mut c_void);
}

struct Printability {
    #[cfg(not(target_os = "wasi"))]
    locale: *mut c_void,
}
impl Printability {
    fn new(utf8: bool) -> Result<Self, i32> {
        #[cfg(target_os = "wasi")]
        let classification = {
            let _ = utf8;
            Self {}
        };
        #[cfg(not(target_os = "wasi"))]
        let classification = Self {
            locale: character_locale(utf8)?,
        };
        Ok(classification)
    }
    fn printable(&self, character: char) -> bool {
        // WASI's musl classifier uses its Unicode table without global locale state.
        #[cfg(target_os = "wasi")]
        unsafe {
            iswprint(u32::from(character)) != 0
        }
        #[cfg(not(target_os = "wasi"))]
        unsafe {
            iswprint_l(u32::from(character), self.locale) != 0
        }
    }
}
#[cfg(not(target_os = "wasi"))]
fn character_locale(utf8: bool) -> Result<*mut c_void, i32> {
    if !utf8 {
        return Ok(std::ptr::null_mut());
    }
    #[cfg(target_vendor = "apple")]
    const CTYPE_MASK: i32 = 1 << 2;
    #[cfg(not(target_vendor = "apple"))]
    const CTYPE_MASK: i32 = 1;
    // Own a character-classification locale without changing process state.
    let locale = unsafe { newlocale(CTYPE_MASK, c"C.UTF-8".as_ptr(), std::ptr::null_mut()) };
    if locale.is_null() {
        return Err(2);
    }
    Ok(locale)
}
#[cfg(not(target_os = "wasi"))]
impl Drop for Printability {
    fn drop(&mut self) {
        if !self.locale.is_null() {
            unsafe { freelocale(self.locale) };
        }
    }
}

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
    ) -> Result<Self, i32> {
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
    ) -> Result<usize, i32> {
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
    async fn piece(&mut self, bytes: &[u8], printer: &mut Printer<'_>) -> Result<(), i32> {
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
