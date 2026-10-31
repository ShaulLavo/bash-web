#[path = "../src"]
mod source {
    pub mod terminal;
}
use source::terminal;
use terminal::{Action, Editor, Geometry};

fn new_editor() -> Editor {
    let mut editor = Editor::default();
    editor.begin("$ ", Geometry::default());
    editor
}

fn finish_prompt(editor: &mut Editor) {
    drop(editor.finish(Geometry::default(), false));
    editor.begin("$ ", Geometry::default());
}

fn feed(editor: &mut Editor, bytes: &[u8]) {
    for &byte in bytes {
        editor.resize(Geometry::default());
        match editor.feed(byte) {
            Action::Echo(byte) => editor.echoed(byte),
            Action::Redraw => drop(editor.redraw()),
            Action::Submit(_) => finish_prompt(editor),
            _ => (),
        }
    }
}

fn submit(editor: &mut Editor, expected: &[u8]) {
    assert_eq!(editor.feed(b'\r'), Action::Submit(expected.to_vec()));
    finish_prompt(editor);
}

#[test]
fn down_without_recall_preserves_the_draft_and_cursor() {
    let mut editor = new_editor();
    feed(&mut editor, b"saved\r");
    feed(&mut editor, b"draft\x1b[B");
    submit(&mut editor, b"draft");
    feed(&mut editor, b"draft\x1b[D\x1b[B\x1b[B!");
    submit(&mut editor, b"draf!t");
}

#[test]
fn up_then_down_restores_the_draft_after_editing_history() {
    let mut editor = new_editor();
    feed(&mut editor, b"saved\rdraft\x1b[A!");
    feed(&mut editor, b"\x1b[B\x1b[B");
    submit(&mut editor, b"draft");
    feed(&mut editor, b"\x1b[A\x1b[A");
    submit(&mut editor, b"saved");
}

#[test]
fn oldest_history_boundary_preserves_edits_and_cursor() {
    let mut editor = new_editor();
    feed(&mut editor, b"old\rnew\rdraft\x1b[A\x1b[A!\x1b[D\x1b[A?");
    submit(&mut editor, b"old?!");
}

#[test]
fn edited_history_can_be_submitted_without_changing_the_original() {
    let mut editor = new_editor();
    feed(&mut editor, b"saved\r\x1b[A!\x1b[D?");
    submit(&mut editor, b"saved?!");
    feed(&mut editor, b"\x1b[A\x1b[A");
    submit(&mut editor, b"saved");
}

#[test]
fn history_navigation_without_saved_commands_preserves_input() {
    let mut editor = new_editor();
    feed(&mut editor, b"draft\x1b[D\x1b[A\x1b[B!");
    submit(&mut editor, b"draf!t");
}

#[test]
fn ctrl_b_moves_back_one_character() {
    let mut editor = new_editor();
    feed(&mut editor, b"abc\x02X");
    submit(&mut editor, b"abXc");
}

#[test]
fn ctrl_f_moves_forward_one_character() {
    let mut editor = new_editor();
    feed(&mut editor, b"abc\x01\x06X");
    submit(&mut editor, b"aXbc");
}

#[test]
fn ctrl_cursor_aliases_preserve_utf8_and_stop_at_boundaries() {
    let mut editor = new_editor();
    feed(&mut editor, "é中".as_bytes());
    feed(&mut editor, b"\x02X\x06\x06Y\x01\x02\x06Z");
    submit(&mut editor, "éZX中Y".as_bytes());
}

#[test]
fn ctrl_p_recalls_history() {
    let mut editor = new_editor();
    feed(&mut editor, b"saved\rdraft\x10");
    submit(&mut editor, b"saved");
}

#[test]
fn ctrl_n_restores_the_draft_from_history() {
    let mut editor = new_editor();
    feed(&mut editor, b"saved\rdraft\x1b[A\x0e");
    submit(&mut editor, b"draft");
}

#[test]
fn history_aliases_share_arrow_navigation_and_boundaries() {
    let mut editor = new_editor();
    feed(&mut editor, b"\x10\x0eold\rnew\rdraft\x0e\x10\x1b[A\x10");
    feed(&mut editor, b"\x0e\x1b[B\x0e!");
    submit(&mut editor, b"draft!");
}

#[test]
fn a_prompt_update_keeps_the_history_position_and_the_draft() {
    let mut editor = new_editor();
    feed(&mut editor, b"saved\rdraft\x1b[A");
    assert!(editor.replace_prompt(b"~/app $ ").is_some());
    feed(&mut editor, b"\x1b[B");
    editor.foreign_output();
    assert_eq!(editor.replace_prompt(b"$ "), None);
    feed(&mut editor, b"!");
    submit(&mut editor, b"draft!");
}
