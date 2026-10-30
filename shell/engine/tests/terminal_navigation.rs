#[path = "../src"]
mod source {
    pub mod terminal;
}
use source::terminal::{Action, Editor, Geometry};

fn feed(editor: &mut Editor, bytes: &[u8]) {
    for &byte in bytes {
        editor.resize(Geometry::new(12, 6));
        match editor.feed(byte) {
            Action::Echo(byte) => editor.echoed(byte),
            Action::Redraw => drop(editor.redraw()),
            Action::Submit(_) => {
                drop(editor.finish(Geometry::new(12, 6), false));
                editor.begin("$ ", Geometry::new(12, 6));
            }
            _ => (),
        }
    }
}

fn paste(editor: &mut Editor, text: &str) {
    feed(editor, b"\x1b[200~");
    feed(editor, text.as_bytes());
    feed(editor, b"\x1b[201~");
}

fn pasted_editor(text: &str) -> Editor {
    let mut editor = Editor::default();
    editor.begin("$ ", Geometry::new(12, 6));
    paste(&mut editor, text);
    editor
}

fn submit(editor: &mut Editor, expected: &str) {
    assert_eq!(
        editor.feed(b'\r'),
        Action::Submit(expected.as_bytes().to_vec())
    );
}

#[test]
fn multiline_home_and_end_cross_every_blank_line() {
    let text = "first\n\nmiddle\n\nlast\n";
    for home in ["\x01", "\x1b[H", "\x1bOH", "\x1b[1~"] {
        for left in [0, 1, 6, 10, 15, 20] {
            let mut editor = pasted_editor(text);
            feed(&mut editor, "\x1b[D".repeat(left).as_bytes());
            feed(&mut editor, home.as_bytes());
            feed(&mut editor, b"!");
            submit(&mut editor, &format!("!{text}"));
        }
    }
    for end in ["\x05", "\x1b[F", "\x1bOF", "\x1b[4~"] {
        for left in [0, 1, 6, 10, 15, 20] {
            let mut editor = pasted_editor(text);
            feed(&mut editor, "\x1b[D".repeat(left).as_bytes());
            feed(&mut editor, end.as_bytes());
            feed(&mut editor, b"!");
            submit(&mut editor, &format!("{text}!"));
        }
    }
}

#[test]
fn multiline_history_recall_and_restore_ignore_cursor_row() {
    for (up, down) in [("\x1b[A", "\x1b[B"), ("\x1bOA", "\x1bOB"), ("\x10", "\x0e")] {
        for left in [0, 1, 6, 10, 15, 20] {
            let mut editor = pasted_editor("");
            feed(&mut editor, b"saved\r");
            let text = "first\n\nmiddle\n\nlast\n";
            paste(&mut editor, text);
            feed(&mut editor, "\x1b[D".repeat(left).as_bytes());
            feed(&mut editor, up.as_bytes());
            feed(&mut editor, down.as_bytes());
            feed(&mut editor, b"!");
            submit(&mut editor, &format!("{text}!"));
        }
    }
}

#[test]
fn empty_history_does_not_move_within_multiline_drafts() {
    let mut editor = pasted_editor("first\n\nlast");
    feed(&mut editor, b"\x1b[A!\x01\x1b[B?");
    submit(&mut editor, "?first\n\nlast!");
}

#[test]
fn large_markdown_blank_lines_are_one_readline_buffer() {
    let text = format!(
        "{}## Last heading\n\nA final paragraph.\n",
        "# Document\n\nA short paragraph.\n\n".repeat(80)
    );
    let mut editor = pasted_editor("");
    feed(&mut editor, b"saved history\r");
    paste(&mut editor, &text);
    feed(&mut editor, b"\x01!\x05?\x1b[A\x1b[B");
    submit(&mut editor, &format!("!{text}?"));
}
