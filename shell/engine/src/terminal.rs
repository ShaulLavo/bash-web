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
#[derive(Clone, Copy, Default)]
enum Escape {
    #[default]
    None,
    Start,
    Csi(Parameters),
    Discard,
    Ss3,
}
#[derive(Clone, Copy, Default)]
enum Parameters {
    #[default]
    Empty,
    First(u32),
    Modified(u32, u32),
    Unsupported,
}
impl Parameters {
    fn feed(self, byte: u8) -> Self {
        match (self, byte) {
            (Self::Empty, b'0'..=b'9') => Self::First(u32::from(byte - b'0')),
            (Self::First(first), b';') => Self::Modified(first, 0),
            (Self::First(value), b'0'..=b'9') => append_digit(value, byte)
                .map(Self::First)
                .unwrap_or(Self::Unsupported),
            (Self::Modified(first, value), b'0'..=b'9') => append_digit(value, byte)
                .map(|value| Self::Modified(first, value))
                .unwrap_or(Self::Unsupported),
            _ => Self::Unsupported,
        }
    }
}
fn append_digit(value: u32, byte: u8) -> Option<u32> {
    value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))
}
#[derive(Default)]
pub struct Editor {
    line: Vec<u8>,
    cursor: usize,
    escape: Escape,
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
        self.escape = Escape::None;
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
    fn previous_word(&self) -> usize {
        let mut at = self.cursor;
        while at > 0 && !word_byte(self.line[at - 1]) {
            at -= 1;
        }
        while at > 0 && word_byte(self.line[at - 1]) {
            at -= 1;
        }
        at
    }
    fn next_word(&self) -> usize {
        let mut at = self.cursor;
        while at < self.line.len() && !word_byte(self.line[at]) {
            at += 1;
        }
        while at < self.line.len() && word_byte(self.line[at]) {
            at += 1;
        }
        at
    }
    fn meta(&mut self, byte: u8) -> Action {
        match byte {
            b'b' => self.cursor = self.previous_word(),
            b'f' => self.cursor = self.next_word(),
            b'd' => {
                self.line.drain(self.cursor..self.next_word());
            }
            8 | 127 => {
                let at = self.previous_word();
                self.line.drain(at..self.cursor);
                self.cursor = at;
            }
            _ => return Action::None,
        }
        Action::Redraw
    }
    fn csi(&mut self, parameters: Parameters, byte: u8) -> Action {
        use Parameters::{Empty, First, Modified};
        match (parameters, byte) {
            (Empty, b'A') => self.history(true),
            (Empty, b'B') => self.history(false),
            (Empty, b'D') if self.cursor > 0 => self.cursor = self.previous(),
            (Empty, b'C') if self.cursor < self.line.len() => self.cursor = self.next(),
            (Empty, b'H') | (First(1), b'~') => self.cursor = 0,
            (Empty, b'F') | (First(4), b'~') => self.cursor = self.line.len(),
            (First(3), b'~') if self.cursor < self.line.len() => {
                self.line.drain(self.cursor..self.next());
            }
            (Modified(1, 3 | 5), b'D') => self.cursor = self.previous_word(),
            (Modified(1, 3 | 5), b'C') => self.cursor = self.next_word(),
            _ => return Action::None,
        }
        Action::Redraw
    }
    fn feed_escape(&mut self, byte: u8) -> Action {
        match (std::mem::take(&mut self.escape), byte) {
            (state @ (Escape::Csi(_) | Escape::Discard | Escape::Ss3), 0 | 127) => {
                self.escape = state;
            }
            (Escape::Start, b'[') => self.escape = Escape::Csi(Parameters::Empty),
            (Escape::Start, b'O') => self.escape = Escape::Ss3,
            (Escape::Start, byte) => return self.meta(byte),
            (Escape::Ss3, 0x20..=0x3f) => self.escape = Escape::Discard,
            (Escape::Ss3, byte) => return self.csi(Parameters::Empty, byte),
            (Escape::Csi(parameters), 0x30..=0x3f) => {
                self.escape = Escape::Csi(parameters.feed(byte));
            }
            (Escape::Csi(_), 0x20..=0x2f) | (Escape::Discard, 0x20..=0x3f) => {
                self.escape = Escape::Discard;
            }
            (Escape::Csi(parameters), 0x40..=0x7e) => return self.csi(parameters, byte),
            _ => {}
        }
        Action::None
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
        if byte == 0x1b {
            self.escape = Escape::Start;
            return Action::None;
        }
        if !matches!(self.escape, Escape::None) {
            return self.feed_escape(byte);
        }
        match byte {
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
fn word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte >= 0x80
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
    fn csi_length_and_numeric_overflow_do_not_end_the_sequence() {
        let mut editor = Editor::default();
        feed(&mut editor, b"one two\x1b[");
        feed(&mut editor, &vec![b'0'; 4096]);
        feed(&mut editor, b"1;3D");
        assert_eq!(editor.cursor, 4);
        feed(&mut editor, b"\x1b[");
        feed(&mut editor, &vec![b'9'; 4096]);
        assert_eq!(editor.feed(b'~'), Action::None);
        assert_eq!(editor.line, b"one two");
        assert_eq!(editor.cursor, 4);
    }

    #[test]
    fn clear_and_a_new_escape_reset_partial_sequences() {
        let mut editor = Editor::default();
        feed(&mut editor, b"old\x1b[12;");
        editor.clear();
        assert_eq!(editor.feed(b'x'), Action::Echo(b'x'));
        feed(&mut editor, b"\x1b[12;\x1b[H");
        assert_eq!(editor.cursor, 0);
        assert_eq!(editor.feed(b'y'), Action::Redraw);
        assert_eq!(editor.line, b"yx");
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
    fn parameterized_ss3_sequences_are_consumed_without_inserting_their_tail() {
        let mut editor = Editor::default();
        feed(&mut editor, b"before\x1bO1;5Dafter");
        assert_eq!(editor.feed(b'\r'), Action::Submit(b"beforeafter".to_vec()));
    }

    #[test]
    fn nul_and_del_inside_csi_do_not_release_its_tail_as_text() {
        for control in [0, 127] {
            let mut editor = Editor::default();
            feed(&mut editor, b"before\x1b[27;2;");
            assert_eq!(editor.feed(control), Action::None);
            feed(&mut editor, b"13~after");
            assert_eq!(editor.feed(b'\r'), Action::Submit(b"beforeafter".to_vec()));
            feed(&mut editor, b"before\x1b[ !");
            assert_eq!(editor.feed(control), Action::None);
            feed(&mut editor, b"~after");
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
