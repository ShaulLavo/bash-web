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
fn multiline_home_and_end_stop_at_each_hard_line() {
    let text = "first\nmiddle\nlast";
    for home in ["\x01", "\x1b[H", "\x1bOH", "\x1b[1~"] {
        for (left, expected) in [
            (0, "first\nmiddle\n!last"),
            (5, "first\n!middle\nlast"),
            (12, "!first\nmiddle\nlast"),
        ] {
            let mut editor = pasted_editor(text);
            feed(&mut editor, "\x1b[D".repeat(left).as_bytes());
            feed(&mut editor, home.as_bytes());
            feed(&mut editor, b"!");
            submit(&mut editor, expected);
        }
    }
    for end in ["\x05", "\x1b[F", "\x1bOF", "\x1b[4~"] {
        for (left, expected) in [
            (2, "first\nmiddle\nlast!"),
            (7, "first\nmiddle!\nlast"),
            (15, "first!\nmiddle\nlast"),
        ] {
            let mut editor = pasted_editor(text);
            feed(&mut editor, "\x1b[D".repeat(left).as_bytes());
            feed(&mut editor, end.as_bytes());
            feed(&mut editor, b"!");
            submit(&mut editor, expected);
        }
    }
}

#[test]
fn multiline_arrows_move_between_hard_lines_before_history() {
    for (up, down) in [("\x1b[A", "\x1b[B"), ("\x1bOA", "\x1bOB"), ("\x10", "\x0e")] {
        let mut editor = pasted_editor("");
        feed(&mut editor, b"saved\r");
        paste(&mut editor, "first\nmiddle\nlast");
        feed(&mut editor, b"\x01");
        feed(&mut editor, up.as_bytes());
        feed(&mut editor, b"M\x01");
        feed(&mut editor, up.as_bytes());
        feed(&mut editor, b"F\x01");
        feed(&mut editor, down.as_bytes());
        feed(&mut editor, b"D");
        submit(&mut editor, "Ffirst\nDMmiddle\nlast");
    }
}

#[test]
fn multiline_vertical_column_survives_short_lines_and_utf8() {
    let mut editor = pasted_editor("a中b\nx\néx😀");
    feed(&mut editor, b"\x1b[A\x1b[A!");
    submit(&mut editor, "a中b!\nx\néx😀");

    let mut editor = pasted_editor("a中b\nx\néx😀");
    feed(&mut editor, b"\x1b[A\x1b[A\x1b[B\x1b[B!");
    submit(&mut editor, "a中b\nx\néx😀!");
}

#[test]
fn multiline_empty_lines_and_crlf_remain_editable() {
    let mut editor = pasted_editor("first\r\n\r\nlast\r\n");
    feed(&mut editor, b"\x01!\x1b[A\x01?\x1b[A.");
    submit(&mut editor, "first\n.\n?last\n!");
}

#[test]
fn multiline_history_fallback_keeps_the_whole_draft() {
    let mut editor = pasted_editor("");
    feed(&mut editor, b"saved\r");
    paste(&mut editor, "one\ntwo");
    feed(&mut editor, b"\x01\x1b[A\x1b[A");
    feed(&mut editor, b"\x1b[B!");
    submit(&mut editor, "one\ntwo!");
}

#[test]
fn soft_wrapping_does_not_create_new_buffer_lines() {
    let text = "one long line that wraps over several rows";
    let mut editor = pasted_editor("");
    feed(&mut editor, b"saved\r");
    paste(&mut editor, text);
    feed(&mut editor, b"\x01!\x05?\x1b[A\x1b[B");
    submit(&mut editor, &format!("!{text}?"));
}

#[test]
fn large_markdown_paste_navigates_hard_lines_before_recalling_history() {
    let prefix = "# Document\n\nA short paragraph.\n\n".repeat(80);
    let text =
        format!("{prefix}## Last heading\n\nA much longer final paragraph with a distinct end.");
    let mut editor = pasted_editor("");
    feed(&mut editor, b"saved history\r");
    paste(&mut editor, &text);
    feed(
        &mut editor,
        b"\x01!\x1b[A?\x01\x1b[A#\x01\x1b[B>\x1b[B\x05<",
    );
    submit(
        &mut editor,
        &format!(
            "{prefix}### Last heading\n>?\n!A much longer final paragraph with a distinct end.<"
        ),
    );
}

#[test]
fn multiline_vertical_targets_use_cells_and_keep_scalars_whole() {
    for (text, expected) in [
        ("中x\na", "!中x\na"),
        ("a\u{301}b\nx", "a\u{301}!b\nx"),
        ("\txy\n12345678", "\t!xy\n12345678"),
        ("a\x03b\n12", "a!\x03b\n12"),
    ] {
        let mut editor = pasted_editor(text);
        feed(&mut editor, b"\x1b[A!");
        submit(&mut editor, expected);
    }
}

#[test]
fn multiline_horizontal_movement_resets_the_preferred_column() {
    let mut editor = pasted_editor("abcde\nx\nABCDE");
    feed(&mut editor, b"\x1b[A\x1b[D\x1b[A!");
    submit(&mut editor, "!abcde\nx\nABCDE");
}
