#[path = "../src/terminal.rs"]
mod terminal;
use terminal::{Action, Editor};

fn feed(editor: &mut Editor, bytes: &[u8]) {
    for &byte in bytes {
        editor.resize("$ ", 80);
        match editor.feed(byte) {
            Action::Echo(byte) => editor.echoed(byte),
            Action::Redraw => drop(editor.redraw("$ ")),
            _ => (),
        }
    }
}

fn submit(editor: &mut Editor, expected: &[u8]) {
    assert_eq!(editor.feed(b'\r'), Action::Submit(expected.to_vec()));
}

#[test]
fn down_without_recall_preserves_the_draft_and_cursor() {
    let mut editor = Editor::default();
    feed(&mut editor, b"saved\r");
    feed(&mut editor, b"draft\x1b[B");
    submit(&mut editor, b"draft");
    feed(&mut editor, b"draft\x1b[D\x1b[B\x1b[B!");
    submit(&mut editor, b"draf!t");
}

#[test]
fn up_then_down_restores_the_draft_after_editing_history() {
    let mut editor = Editor::default();
    feed(&mut editor, b"saved\rdraft\x1b[A!");
    feed(&mut editor, b"\x1b[B\x1b[B");
    submit(&mut editor, b"draft");
    feed(&mut editor, b"\x1b[A\x1b[A");
    submit(&mut editor, b"saved");
}

#[test]
fn oldest_history_boundary_preserves_edits_and_cursor() {
    let mut editor = Editor::default();
    feed(&mut editor, b"old\rnew\rdraft\x1b[A\x1b[A!\x1b[D\x1b[A?");
    submit(&mut editor, b"old?!");
}

#[test]
fn edited_history_can_be_submitted_without_changing_the_original() {
    let mut editor = Editor::default();
    feed(&mut editor, b"saved\r\x1b[A!\x1b[D?");
    submit(&mut editor, b"saved?!");
    feed(&mut editor, b"\x1b[A\x1b[A");
    submit(&mut editor, b"saved");
}

#[test]
fn history_navigation_without_saved_commands_preserves_input() {
    let mut editor = Editor::default();
    feed(&mut editor, b"draft\x1b[D\x1b[A\x1b[B!");
    submit(&mut editor, b"draf!t");
}

#[test]
fn ctrl_b_moves_back_one_character() {
    let mut editor = Editor::default();
    feed(&mut editor, b"abc\x02X");
    submit(&mut editor, b"abXc");
}

#[test]
fn ctrl_f_moves_forward_one_character() {
    let mut editor = Editor::default();
    feed(&mut editor, b"abc\x01\x06X");
    submit(&mut editor, b"aXbc");
}

#[test]
fn ctrl_cursor_aliases_preserve_utf8_and_stop_at_boundaries() {
    let mut editor = Editor::default();
    feed(&mut editor, "é中".as_bytes());
    feed(&mut editor, b"\x02X\x06\x06Y\x01\x02\x06Z");
    submit(&mut editor, "éZX中Y".as_bytes());
}

#[test]
fn ctrl_p_recalls_history() {
    let mut editor = Editor::default();
    feed(&mut editor, b"saved\rdraft\x10");
    submit(&mut editor, b"saved");
}

#[test]
fn ctrl_n_restores_the_draft_from_history() {
    let mut editor = Editor::default();
    feed(&mut editor, b"saved\rdraft\x1b[A\x0e");
    submit(&mut editor, b"draft");
}

#[test]
fn history_aliases_share_arrow_navigation_and_boundaries() {
    let mut editor = Editor::default();
    feed(&mut editor, b"\x10\x0eold\rnew\rdraft\x0e\x10\x1b[A\x10");
    feed(&mut editor, b"\x0e\x1b[B\x0e!");
    submit(&mut editor, b"draft!");
}
