use super::reference::{Case, Reference};
use super::{Editor, Geometry, Mode};

fn feed(editor: &mut Editor, bytes: &[u8]) {
    for &byte in bytes {
        editor.feed(byte);
    }
}
#[test]
fn zsh59_zle_byte_replay() {
    let reference: Reference = serde_json::from_str(include_str!(
        "../../../../tests/terminal/zsh-navigation.json"
    ))
    .unwrap();
    for case in reference.cases {
        replay(&case);
    }
}
fn replay(case: &Case) {
    let mut editor = Editor::new(Mode::Zsh);
    editor.begin("$ ", Geometry::new(case.columns, 24));
    for entry in &case.history {
        feed(&mut editor, b"\x1b[200~");
        feed(&mut editor, entry.as_bytes());
        feed(&mut editor, b"\x1b[201~\r");
    }
    for step in &case.steps {
        let bytes: Vec<_> = (0..step.input_hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&step.input_hex[at..at + 2], 16).unwrap())
            .collect();
        feed(&mut editor, &bytes);
        assert_eq!(
            editor.line,
            step.line.as_bytes(),
            "{} {} buffer",
            case.name,
            step.key
        );
        assert_eq!(
            editor.cursor, step.point,
            "{} {} cursor",
            case.name, step.key
        );
    }
}

#[test]
fn zsh_failed_history_move_preserves_the_desired_column() {
    let mut editor = Editor::new(Mode::Zsh);
    feed(&mut editor, b"\x1b[200~x\n12345\x1b[201~\x1b[A\x1b[A\x1b[B");
    assert_eq!(editor.cursor, editor.line.len());
}

#[test]
fn zsh_mode_survives_submit_and_interrupt_but_column_does_not() {
    let mut editor = Editor::new(Mode::Zsh);
    feed(
        &mut editor,
        b"saved\r\x1b[200~abcdef\nx\n12345\x1b[201~\x1b[A\x03",
    );
    feed(&mut editor, b"\x1b[200~abc\ndef\x1b[201~\x01!");
    assert_eq!(editor.line, b"abc\n!def");
    feed(&mut editor, b"\r\x1b[200~abc\ndef\x1b[201~\x01?");
    assert_eq!(editor.line, b"abc\n?def");
}

#[test]
fn zsh_malformed_utf8_navigation_keeps_cursor_in_bounds() {
    let mut editor = Editor::new(Mode::Zsh);
    feed(&mut editor, b"\x1b[200~\xff\n12345\x1b[201~\x1b[A!");
    assert_eq!(editor.line, b"\xff!\n12345");
}
