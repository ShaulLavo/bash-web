use super::{Editor, utf8_length};

/// Selects editing only. Both modes execute Bash commands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Bash,
    Zsh,
}

fn start(line: &[u8], cursor: usize) -> usize {
    line[..cursor]
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map_or(0, |at| at + 1)
}
fn end(line: &[u8], cursor: usize) -> usize {
    line[cursor..]
        .iter()
        .position(|&byte| byte == b'\n')
        .map_or(line.len(), |at| cursor + at)
}
fn column(line: &[u8]) -> usize {
    String::from_utf8_lossy(line).chars().count()
}
fn scalar_length(line: &[u8]) -> usize {
    let length = utf8_length(line[0]).min(line.len());
    match std::str::from_utf8(&line[..length]) {
        Ok(_) => length,
        Err(_) => 1,
    }
}
fn at_column(line: &[u8], wanted: usize) -> usize {
    let mut column = 0;
    let mut at = 0;
    while at < line.len() && column < wanted {
        let length = scalar_length(&line[at..]);
        column += 1;
        at += length;
    }
    at
}
impl Editor {
    pub(super) fn line_start(&self) -> usize {
        match self.mode {
            Mode::Bash => 0,
            Mode::Zsh => start(&self.line, self.cursor),
        }
    }
    pub(super) fn line_end(&self) -> usize {
        match self.mode {
            Mode::Bash => self.line.len(),
            Mode::Zsh => end(&self.line, self.cursor),
        }
    }
    fn vertical_history(&mut self, up: bool) {
        let previous = self.history_at;
        self.history(up);
        if previous != self.history_at {
            self.vertical_column = None;
        }
    }
    pub(super) fn vertical(&mut self, up: bool) {
        if self.mode == Mode::Bash {
            self.history(up);
            return;
        }
        let first = start(&self.line, self.cursor);
        let last = end(&self.line, self.cursor);
        let desired = *self
            .vertical_column
            .get_or_insert_with(|| column(&self.line[first..self.cursor]));
        let target = match up {
            true if first > 0 => start(&self.line, first - 1)..first - 1,
            false if last < self.line.len() => last + 1..end(&self.line, last + 1),
            _ => {
                self.vertical_history(up);
                return;
            }
        };
        self.cursor = target.start + at_column(&self.line[target], desired);
    }
}
