//! Where the prompt and command sit on the terminal, and the bytes that repaint them.
//!
//! The region is the prompt plus the rendered command, laid out from column 0 with
//! libghostty-vt's widths. Rows that scroll above the screen are out of reach of
//! cursor movement, so the model tracks which region rows are still on screen.
#[path = "terminal_width.rs"]
mod width;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub columns: usize,
    pub rows: usize,
}
impl Geometry {
    pub fn new(columns: usize, rows: usize) -> Self {
        Self {
            columns: columns.max(2),
            rows: rows.max(2),
        }
    }
}
impl Default for Geometry {
    fn default() -> Self {
        Self::new(80, 24)
    }
}

/// A region cell position. `column == columns` is the terminal's pending wrap.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Position {
    row: usize,
    column: usize,
}
impl Position {
    /// Where the next glyph starts: a pending wrap belongs to the next row.
    fn caret(self, columns: usize) -> Self {
        if self.column < columns {
            return self;
        }
        Self {
            row: self.row + 1,
            column: 0,
        }
    }
}

fn cells(character: char) -> usize {
    let code = u32::from(character);
    if code <= 0xff {
        return 1;
    }
    let within = |table: &[(u32, u32)]| {
        table
            .binary_search_by(|&(start, end)| {
                if end < code {
                    std::cmp::Ordering::Less
                } else if start > code {
                    std::cmp::Ordering::Greater
                } else {
                    std::cmp::Ordering::Equal
                }
            })
            .is_ok()
    };
    if within(width::ZERO) {
        return 0;
    }
    if within(width::WIDE) { 2 } else { 1 }
}

#[derive(Clone, Copy, Default)]
enum Escape {
    #[default]
    None,
    Start,
    Csi,
    Osc,
    OscEscape,
}

/// One pass over region bytes, placing glyphs as the terminal does.
struct Walk {
    columns: usize,
    at: Position,
    escape: Escape,
}
enum Step {
    /// Moves the cursor without printing (controls and escape sequences).
    Control,
    /// A printing scalar placed at `row`.
    Glyph { row: usize },
}
impl Walk {
    fn new(columns: usize) -> Self {
        Self {
            columns,
            at: Position::default(),
            escape: Escape::None,
        }
    }
    fn step(&mut self, character: char) -> Step {
        match (self.escape, character) {
            (Escape::None, '\x1b') => self.escape = Escape::Start,
            (Escape::Start, '[') => self.escape = Escape::Csi,
            (Escape::Start, ']') => self.escape = Escape::Osc,
            (Escape::Csi, '\x40'..='\x7e') | (Escape::Osc, '\x07') | (Escape::OscEscape, '\\') => {
                self.escape = Escape::None
            }
            (Escape::Osc | Escape::OscEscape, '\x1b') => self.escape = Escape::OscEscape,
            (Escape::Start, _) | (Escape::OscEscape, _) => self.escape = Escape::None,
            (Escape::None, character) => return self.print(character),
            _ => {}
        }
        Step::Control
    }
    fn print(&mut self, character: char) -> Step {
        match character {
            '\r' => self.at.column = 0,
            '\n' => {
                self.at = Position {
                    row: self.at.row + 1,
                    column: 0,
                }
            }
            // VT tab stops move within the row; they do not autowrap.
            '\t' => self.at.column = ((self.at.column / 8 + 1) * 8).min(self.columns - 1),
            character if character.is_control() => {}
            character => return self.glyph(cells(character)),
        }
        Step::Control
    }
    fn glyph(&mut self, width: usize) -> Step {
        // Zero-width scalars join the previous cell, even across a pending wrap.
        if width == 0 {
            return Step::Glyph { row: self.at.row };
        }
        if self.at.column + width > self.columns {
            self.at = Position {
                row: self.at.row + 1,
                column: 0,
            };
        }
        self.at.column += width;
        Step::Glyph { row: self.at.row }
    }
}

/// Visits each scalar with its byte range. Invalid UTF-8 shows as one U+FFFD,
/// as the terminal's decoder does.
fn scalars(bytes: &[u8], mut visit: impl FnMut(usize, usize, char)) {
    let mut offset = 0;
    for chunk in bytes.utf8_chunks() {
        for (index, character) in chunk.valid().char_indices() {
            visit(
                offset + index,
                offset + index + character.len_utf8(),
                character,
            );
        }
        offset += chunk.valid().len();
        if !chunk.invalid().is_empty() {
            visit(offset, offset + chunk.invalid().len(), '\u{fffd}');
            offset += chunk.invalid().len();
        }
    }
}

fn position(bytes: &[u8], columns: usize) -> Position {
    let mut walk = Walk::new(columns);
    scalars(bytes, |_, _, character| {
        walk.step(character);
    });
    walk.at
}

/// Byte ranges of each region row. `starts[r]` is where painting row `r` from its
/// first column begins; `ends[r]` follows its last glyph, before any line break.
struct Rows {
    starts: Vec<usize>,
    ends: Vec<usize>,
}
impl Rows {
    fn new(bytes: &[u8], columns: usize) -> Self {
        let mut rows = Self {
            starts: vec![0],
            ends: vec![0],
        };
        let mut walk = Walk::new(columns);
        scalars(bytes, |start, end, character| {
            rows.reach(walk.at.caret(columns).row, start);
            if let Step::Glyph { row } = walk.step(character) {
                rows.reach(row, start);
                rows.ends[row] = end;
            }
        });
        rows.reach(walk.at.caret(columns).row, bytes.len());
        rows
    }
    fn reach(&mut self, row: usize, offset: usize) {
        while self.starts.len() <= row {
            self.starts.push(offset);
            self.ends.push(offset);
        }
    }
    fn last(&self) -> usize {
        self.starts.len() - 1
    }
}

/// The painted region and the part of it still on screen.
#[derive(Default)]
pub struct Display {
    geometry: Geometry,
    /// Region bytes as painted, including the margin space described in `render`.
    shown: Vec<u8>,
    /// Region rows above `top` have scrolled into history.
    top: usize,
    /// The lowest painted region row. Rows below it are blank or never painted.
    bottom: usize,
    cursor: Position,
    /// Byte offset in `shown` the terminal cursor follows, for recounting on reflow.
    cursor_at: usize,
    /// `shown` ends with the margin space.
    margin: bool,
    pending_utf8: Vec<u8>,
    clear: bool,
}
impl Display {
    /// The prompt has just been written at column 0.
    pub fn begin(&mut self, prompt: &[u8], geometry: Geometry) {
        *self = Self {
            geometry,
            shown: prompt.to_vec(),
            cursor: position(prompt, geometry.columns),
            cursor_at: prompt.len(),
            ..Self::default()
        };
        self.bottom = self.cursor.row;
        self.scrolled();
    }
    /// The terminal reflowed the painted region. Recount it before the next edit.
    pub fn resize(&mut self, geometry: Geometry) {
        if self.geometry == geometry {
            return;
        }
        self.geometry = geometry;
        self.cursor = position(&self.shown[..self.cursor_at], geometry.columns);
        let end = position(&self.shown, geometry.columns).row;
        self.bottom = end.max(self.cursor.row);
        // Reflow keeps the cursor on screen with the region's end at the bottom.
        self.top = self
            .bottom
            .saturating_sub(geometry.rows - 1)
            .min(self.cursor.row);
    }
    /// One byte was written at the cursor, which was at the end of the region.
    pub fn echoed(&mut self, byte: u8) {
        if std::mem::take(&mut self.margin) {
            // The margin space sits under the cursor; the echoed byte replaces it.
            self.shown.pop();
        }
        self.shown.push(byte);
        self.cursor_at = self.shown.len();
        self.pending_utf8.push(byte);
        let text = match std::str::from_utf8(&self.pending_utf8) {
            Ok(_) => std::mem::take(&mut self.pending_utf8),
            Err(error) if error.error_len().is_none() => return,
            Err(_) => std::mem::take(&mut self.pending_utf8),
        };
        let mut walk = Walk {
            columns: self.geometry.columns,
            at: self.cursor,
            escape: Escape::None,
        };
        scalars(&text, |_, _, character| {
            walk.step(character);
        });
        self.cursor = walk.at;
        self.bottom = self.bottom.max(self.cursor.row);
        self.scrolled();
    }
    /// The next render starts from a cleared screen with the prompt at the top.
    pub fn clear_screen(&mut self) {
        self.clear = true;
    }
    /// Repaints whatever differs from the painted region and leaves the cursor at
    /// `caret`, a byte offset in `region`.
    pub fn render(&mut self, mut region: Vec<u8>, caret: usize) -> Vec<u8> {
        let columns = self.geometry.columns;
        let mut out = Vec::new();
        if std::mem::take(&mut self.clear) {
            out.extend_from_slice(b"\x1b[H\x1b[2J");
            self.shown.clear();
            self.top = 0;
            self.bottom = 0;
            self.cursor = Position::default();
        }
        // A caret after a full last row belongs on the next row. A space there makes
        // the terminal wrap into it, keeping the soft wrap that reflow relies on.
        let margin = position(&region, columns).column == columns;
        if margin {
            region.push(b' ');
        }
        let target = position(&region[..caret], columns).caret(columns);
        let rows = Rows::new(&region, columns);
        if let Some(from) = self.repaint_from(&region, target.row) {
            self.paint(&mut out, &region, &rows, from, target.row);
        }
        self.shown = region;
        self.margin = margin;
        self.cursor_at = caret;
        self.move_to(&mut out, target);
        self.pending_utf8.clear();
        out
    }
    /// Leaves the region: the cursor goes below its last row so output and the next
    /// prompt cannot overwrite it. An interrupt echoes `^C` after the text first.
    pub fn finish(&mut self, interrupted: bool) -> Vec<u8> {
        let columns = self.geometry.columns;
        let mut out = Vec::new();
        let rows = Rows::new(&self.shown, columns);
        if self.bottom < rows.last() {
            let shown = std::mem::take(&mut self.shown);
            self.paint(&mut out, &shown, &rows, self.bottom, usize::MAX);
            self.shown = shown;
        }
        let text = &self.shown[..self.shown.len() - usize::from(self.margin)];
        let end = position(text, columns);
        let pending = end.column == columns;
        let column = if interrupted && !pending {
            end.column
        } else {
            0
        };
        self.move_to(
            &mut out,
            Position {
                row: end.row,
                column,
            },
        );
        if interrupted {
            // After a full last row, `^C` starts the next row, as a wrap would put it.
            out.extend_from_slice(if pending { b"\r\n^C" } else { b"^C" });
        }
        out.extend_from_slice(b"\r\n");
        self.pending_utf8.clear();
        out
    }
    /// The first region row whose painted cells must change, if any is on screen.
    fn repaint_from(&self, region: &[u8], target: usize) -> Option<usize> {
        if target < self.top {
            return Some(target);
        }
        let changed = first_difference(&self.shown, region)
            .map(|offset| position(&region[..offset], self.geometry.columns).row)
            .filter(|&row| row <= self.bottom);
        if target > self.bottom {
            return Some(changed.unwrap_or(self.bottom).max(self.top));
        }
        changed.map(|row| row.max(self.top))
    }
    /// Clears from region row `from` and paints rows down to the end, stopping where
    /// any further row would scroll the caret's row off the top of the screen.
    fn paint(&mut self, out: &mut Vec<u8>, region: &[u8], rows: &Rows, from: usize, target: usize) {
        if from < self.top {
            // The rows between have scrolled away. Show the caret's row at the top.
            self.move_rows(out, self.top);
            self.top = from;
            self.cursor.row = from;
        } else {
            self.move_rows(out, from);
        }
        out.extend_from_slice(b"\x1b[J");
        let last = target.saturating_add(self.geometry.rows - 1);
        let end = if last >= rows.last() {
            region.len()
        } else {
            rows.ends[last.max(from)]
        };
        out.extend_from_slice(&region[rows.starts[from]..end]);
        self.cursor = position(&region[..end], self.geometry.columns);
        self.bottom = self.cursor.row;
        self.scrolled();
    }
    fn move_rows(&mut self, out: &mut Vec<u8>, row: usize) {
        let current = self.cursor.row;
        if row < current {
            out.extend_from_slice(format!("\x1b[{}A", current - row).as_bytes());
        }
        if row > current {
            out.extend_from_slice(format!("\x1b[{}B", row - current).as_bytes());
        }
        out.push(b'\r');
        self.cursor = Position { row, column: 0 };
    }
    fn move_to(&mut self, out: &mut Vec<u8>, target: Position) {
        if self.cursor == target {
            return;
        }
        self.move_rows(out, target.row);
        if target.column > 0 {
            out.extend_from_slice(format!("\x1b[{}C", target.column).as_bytes());
        }
        self.cursor = target;
    }
    /// Writing below the last screen row scrolls the region's top rows into history.
    fn scrolled(&mut self) {
        self.top = self
            .top
            .max(self.bottom.saturating_sub(self.geometry.rows - 1));
    }
}

fn first_difference(old: &[u8], new: &[u8]) -> Option<usize> {
    let same = old
        .iter()
        .zip(new)
        .take_while(|(old, new)| old == new)
        .count();
    if same == old.len() && same == new.len() {
        return None;
    }
    // Back up to the start of the scalar the difference falls in.
    let mut at = same;
    while at > 0 && new.get(at).is_some_and(|byte| byte & 0xc0 == 0x80) {
        at -= 1;
    }
    Some(at)
}
