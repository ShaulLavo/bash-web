//! Original bounded single-line terminal editor. The guest owns echo; the browser
//! forwards raw bytes, including ANSI arrows, without maintaining shell state.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Redraw,
    /// Appending at the painted end needs only byte echo, not a whole-line redraw.
    Echo(u8),
    Submit(Vec<u8>),
    Eof,
    Interrupt,
    None,
}
#[derive(Default)]
pub struct Editor {
    line: Vec<u8>,
    cursor: usize,
    escape: Vec<u8>,
    history: Vec<Vec<u8>>,
    history_at: Option<usize>,
    draft: Vec<u8>,
    painted: Position,
    columns: usize,
    pending_utf8: Vec<u8>,
}
#[derive(Clone, Copy, Default)]
struct Position {
    row: usize,
    column: usize,
}
impl Position {
    fn advance(&mut self, character: char, columns: usize) {
        match character {
            '\r' => self.column = 0,
            '\n' => {
                self.row += 1;
                self.column = 0;
            }
            '\t' => {
                // VT tab stops move within the row; they do not autowrap.
                self.column = ((self.column / 8 + 1) * 8).min(columns - 1);
            }
            _ => {
                let width = scalar_width(character);
                if width == 0 {
                    return;
                }
                if self.column + width > columns {
                    self.row += 1;
                    self.column = 0;
                }
                self.column += width;
            }
        }
    }
    fn caret(mut self, columns: usize) -> Self {
        if self.column == columns {
            self.row += 1;
            self.column = 0;
        }
        self
    }
}
// This remains a scalar editor, not a grapheme editor. Keep the usual combining
// marks zero-width and East Asian/emoji scalars wide when counting wrapped rows.
fn scalar_width(character: char) -> usize {
    let code = u32::from(character);
    if character.is_control()
        || matches!(code, 0x0300..=0x036f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff
            | 0x200b..=0x200f | 0x20d0..=0x20ff | 0xfe00..=0xfe0f | 0xfe20..=0xfe2f)
    {
        0
    } else if matches!(code, 0x1100..=0x115f | 0x2329..=0x232a | 0x2e80..=0xa4cf
        | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xfe10..=0xfe19 | 0xfe30..=0xfe6f
        | 0xff01..=0xff60 | 0xffe0..=0xffe6 | 0x1f300..=0x1faff | 0x20000..=0x3fffd)
    {
        2
    } else {
        1
    }
}
fn position(prompt: &str, line: &[u8], columns: usize) -> Position {
    let mut point = Position::default();
    // Prompt SGR/OSC controls occupy no cells. Their interpretation stays with
    // the terminal; only printing scalars contribute to the editor's row count.
    let mut escape = 0;
    for character in prompt.chars().chain(String::from_utf8_lossy(line).chars()) {
        match (escape, character) {
            (0, '\x1b') => escape = 1,
            (1, '[') => escape = 2,
            (1, ']') => escape = 3,
            (1, _) => escape = 0,
            (2, '\x40'..='\x7e') | (3, '\x07') | (4, '\\') => escape = 0,
            (3, '\x1b') => escape = 4,
            (0, character) => point.advance(character, columns),
            _ => {}
        }
    }
    point
}
impl Editor {
    pub fn clear(&mut self) {
        self.line.clear();
        self.cursor = 0;
        self.escape.clear();
        self.history_at = None;
        self.draft.clear();
        self.pending_utf8.clear();
    }
    pub fn begin(&mut self, prompt: &str, columns: usize) {
        self.columns = columns.max(2);
        self.painted = position(prompt, &self.line[..self.cursor], self.columns);
        self.pending_utf8.clear();
    }
    /// Auto-fit terminal resizing reflows the already painted line. Recount its
    /// cursor BEFORE editing, while the old command/caret are still available.
    pub fn resize(&mut self, prompt: &str, columns: usize) {
        if self.columns != columns.max(2) {
            self.begin(prompt, columns);
        }
    }
    pub fn echoed(&mut self, byte: u8) {
        self.pending_utf8.push(byte);
        match std::str::from_utf8(&self.pending_utf8) {
            Ok(text) => {
                for character in text.chars() {
                    self.painted.advance(character, self.columns.max(2));
                }
                self.pending_utf8.clear();
            }
            Err(error) if error.error_len().is_none() => {}
            Err(_) => {
                for character in String::from_utf8_lossy(&self.pending_utf8).chars() {
                    self.painted.advance(character, self.columns.max(2));
                }
                self.pending_utf8.clear();
            }
        }
    }
    pub fn redraw(&mut self, prompt: &str) -> Vec<u8> {
        let columns = self.columns.max(2);
        let mut bytes = Vec::new();
        if self.painted.row > 0 {
            bytes.extend_from_slice(format!("\x1b[{}A", self.painted.row).as_bytes());
        }
        // EL2 only clears one physical row. ED0 removes every old wrapped row
        // after returning to the prompt origin, including a now-shorter tail.
        bytes.extend_from_slice(b"\r\x1b[J");
        bytes.extend_from_slice(prompt.as_bytes());
        bytes.extend_from_slice(&self.line);
        bytes.push(b' ');
        let mut end = position(prompt, &self.line, columns);
        end.advance(' ', columns);
        let cursor = position(prompt, &self.line[..self.cursor], columns).caret(columns);
        if end.row > cursor.row {
            bytes.extend_from_slice(format!("\x1b[{}A", end.row - cursor.row).as_bytes());
        }
        bytes.push(b'\r');
        if cursor.column > 0 {
            bytes.extend_from_slice(format!("\x1b[{}C", cursor.column).as_bytes());
        }
        self.painted = cursor;
        self.pending_utf8.clear();
        bytes
    }
    fn previous(&self) -> usize {
        let mut at = self.cursor.saturating_sub(1);
        while at > 0 && self.line[at] & 0xc0 == 0x80 {
            at -= 1;
        }
        at
    }
    fn next(&self) -> usize {
        let mut at = (self.cursor + 1).min(self.line.len());
        while at < self.line.len() && self.line[at] & 0xc0 == 0x80 {
            at += 1;
        }
        at
    }
    fn history(&mut self, up: bool) {
        if self.history.is_empty() {
            return;
        }
        let next = match (self.history_at, up) {
            (None, true) => {
                self.draft = self.line.clone();
                Some(self.history.len() - 1)
            }
            (Some(at), true) => Some(at.saturating_sub(1)),
            (Some(at), false) if at + 1 < self.history.len() => Some(at + 1),
            _ => None,
        };
        self.history_at = next;
        self.line = next
            .map(|at| self.history[at].clone())
            .unwrap_or_else(|| self.draft.clone());
        self.cursor = self.line.len();
    }
    pub fn feed(&mut self, byte: u8) -> Action {
        if !self.escape.is_empty() {
            self.escape.push(byte);
            if self.escape.len() == 2 && (byte == b'[' || byte == b'O') {
                return Action::None;
            }
            if self.escape.len() > 8 {
                self.escape.clear();
                return Action::None;
            }
            if byte.is_ascii_digit() || byte == b';' {
                return Action::None;
            }
            match self.escape.as_slice() {
                b"\x1b[A" => self.history(true),
                b"\x1b[B" => self.history(false),
                b"\x1b[D" if self.cursor > 0 => self.cursor = self.previous(),
                b"\x1b[C" if self.cursor < self.line.len() => self.cursor = self.next(),
                b"\x1b[H" | b"\x1bOH" | b"\x1b[1~" => self.cursor = 0,
                b"\x1b[F" | b"\x1bOF" | b"\x1b[4~" => self.cursor = self.line.len(),
                b"\x1b[3~" if self.cursor < self.line.len() => {
                    self.line.drain(self.cursor..self.next());
                }
                _ => {}
            }
            self.escape.clear();
            return Action::Redraw;
        }
        match byte {
            0x1b => {
                self.escape.push(byte);
                Action::None
            }
            b'\r' | b'\n' => {
                let line = self.line.clone();
                if !line.is_empty() && self.history.last() != Some(&line) {
                    if self.history.len() == 100 {
                        self.history.remove(0);
                    }
                    self.history.push(line.clone());
                }
                self.clear();
                Action::Submit(line)
            }
            3 => {
                self.clear();
                Action::Interrupt
            }
            4 if self.line.is_empty() => Action::Eof,
            4 if self.cursor < self.line.len() => {
                self.line.drain(self.cursor..self.next());
                Action::Redraw
            }
            8 | 127 if self.cursor > 0 => {
                let at = self.previous();
                self.line.drain(at..self.cursor);
                self.cursor = at;
                Action::Redraw
            }
            1 => {
                self.cursor = 0;
                Action::Redraw
            }
            5 => {
                self.cursor = self.line.len();
                Action::Redraw
            }
            11 => {
                self.line.truncate(self.cursor);
                Action::Redraw
            }
            21 => {
                self.line.drain(..self.cursor);
                self.cursor = 0;
                Action::Redraw
            }
            23 => {
                let end = self.cursor;
                while self.cursor > 0 && self.line[self.cursor - 1].is_ascii_whitespace() {
                    self.cursor -= 1;
                }
                while self.cursor > 0 && !self.line[self.cursor - 1].is_ascii_whitespace() {
                    self.cursor -= 1;
                }
                while self.cursor > 0 && self.line[self.cursor] & 0xc0 == 0x80 {
                    self.cursor -= 1;
                }
                self.line.drain(self.cursor..end);
                Action::Redraw
            }
            12 => Action::Redraw,
            b'\t' | 32..=126 | 128..=255 if self.line.len() < 64 * 1024 => {
                let append = self.cursor == self.line.len();
                self.line.insert(self.cursor, byte);
                self.cursor += 1;
                if append {
                    Action::Echo(byte)
                } else {
                    Action::Redraw
                }
            }
            _ => Action::None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn feed(editor: &mut Editor, bytes: &[u8]) {
        for &byte in bytes {
            editor.feed(byte);
        }
    }

    #[test]
    fn long_csi_is_consumed_through_its_final_byte() {
        let mut editor = Editor::default();
        feed(&mut editor, b"before\x1b[27;2;13~after");
        assert_eq!(editor.feed(b'\r'), Action::Submit(b"beforeafter".to_vec()));
    }

    #[test]
    fn unknown_escape_sequences_do_not_insert_text_or_run_commands() {
        let sequences: &[&[u8]] = &[
            b"\x1b[123456789012~",
            b"\x1b[?123;456;789z",
            b"\x1b[1;3 D",
            b"\x1b[ !~",
            b"\x1bOZ",
            b"\x1bq",
        ];
        for sequence in sequences {
            let mut editor = Editor::default();
            feed(&mut editor, b"before");
            feed(&mut editor, sequence);
            assert_eq!(editor.line, b"before", "{sequence:?}");
            assert_eq!(editor.cursor, 6, "{sequence:?}");
            feed(&mut editor, b"after");
            assert_eq!(editor.feed(b'\r'), Action::Submit(b"beforeafter".to_vec()));
        }
    }

    #[test]
    fn meta_word_movement_skips_punctuation_and_preserves_utf8() {
        let mut editor = Editor::default();
        feed(&mut editor, "one,two  café中!".as_bytes());
        feed(&mut editor, b"\x1bb");
        assert_eq!(editor.cursor, b"one,two  ".len());
        feed(&mut editor, b"\x1bb");
        assert_eq!(editor.cursor, b"one,".len());
        feed(&mut editor, b"\x1bf");
        assert_eq!(editor.cursor, b"one,two".len());
        feed(&mut editor, b"\x1bf");
        assert_eq!(editor.cursor, "one,two  café中".len());
        feed(&mut editor, b"\x1bf\x1bf");
        assert_eq!(editor.cursor, editor.line.len());
        feed(&mut editor, b"\x01\x1bb");
        assert_eq!(editor.cursor, 0);
    }

    #[test]
    fn meta_d_deletes_the_next_word_and_keeps_the_cursor() {
        let mut editor = Editor::default();
        feed(&mut editor, "one, café中! tail".as_bytes());
        feed(&mut editor, b"\x01\x1bf\x1bd");
        assert_eq!(editor.line, b"one! tail");
        assert_eq!(editor.cursor, 3);
        feed(&mut editor, b"\x1bd\x1bd");
        assert_eq!(editor.line, b"one");
        assert_eq!(editor.cursor, 3);
    }

    #[test]
    fn meta_backspace_deletes_the_previous_word_and_keeps_utf8_whole() {
        for sequence in [b"\x1b\x7f", b"\x1b\x08"] {
            let mut editor = Editor::default();
            feed(&mut editor, "zero, café中!! tail".as_bytes());
            feed(&mut editor, b"\x1bb");
            feed(&mut editor, sequence);
            assert_eq!(editor.line, b"zero, tail");
            assert_eq!(editor.cursor, 6);
            feed(&mut editor, sequence);
            assert_eq!(editor.line, b"tail");
            assert_eq!(editor.cursor, 0);
            feed(&mut editor, sequence);
            assert_eq!(editor.line, b"tail");
        }
    }

    #[test]
    fn alt_and_ctrl_arrows_move_by_word() {
        for modifier in [3, 5] {
            let mut editor = Editor::default();
            feed(&mut editor, b"one,two  three!");
            feed(&mut editor, format!("\x1b[1;{modifier}D").as_bytes());
            assert_eq!(editor.cursor, 9);
            feed(&mut editor, format!("\x1b[1;{modifier}D").as_bytes());
            assert_eq!(editor.cursor, 4);
            feed(&mut editor, format!("\x1b[1;{modifier}C").as_bytes());
            assert_eq!(editor.cursor, 7);
            feed(&mut editor, format!("\x1b[1;{modifier}C").as_bytes());
            assert_eq!(editor.cursor, 14);
        }
    }

    #[test]
    fn ss3_keys_share_csi_navigation() {
        let mut editor = Editor::default();
        feed(&mut editor, b"saved\rnext\x1bOA");
        assert_eq!(editor.line, b"saved");
        feed(&mut editor, b"\x1bOB\x1bOD");
        assert_eq!(editor.line, b"next");
        assert_eq!(editor.cursor, 3);
        feed(&mut editor, b"\x1bOH\x1bOC");
        assert_eq!(editor.cursor, 1);
        feed(&mut editor, b"\x1bOF");
        assert_eq!(editor.cursor, 4);
    }

    #[test]
    fn editing_and_history_keep_byte_exact_commands() {
        let mut editor = Editor::default();
        for byte in b"echo ac\x1b[Db\x1b[F" {
            editor.feed(*byte);
        }
        assert_eq!(editor.feed(b'\r'), Action::Submit(b"echo abc".to_vec()));
        for byte in b"draft\x1b[A" {
            editor.feed(*byte);
        }
        assert_eq!(editor.line, b"echo abc");
        for byte in b"\x1b[B" {
            editor.feed(*byte);
        }
        assert_eq!(editor.feed(b'\n'), Action::Submit(b"draft".to_vec()));
    }
    #[test]
    fn utf8_backspace_ctrl_d_and_interrupt() {
        let mut editor = Editor::default();
        for byte in "é中".bytes() {
            editor.feed(byte);
        }
        editor.feed(127);
        assert_eq!(editor.feed(b'\n'), Action::Submit("é".as_bytes().to_vec()));
        assert_eq!(editor.feed(4), Action::Eof);
        editor.feed(b'x');
        assert_eq!(editor.feed(3), Action::Interrupt);
        assert_eq!(editor.feed(4), Action::Eof);
    }
}
