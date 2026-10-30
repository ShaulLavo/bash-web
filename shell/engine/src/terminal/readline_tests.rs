use super::{Action, Editor, Geometry};
use serde::Deserialize;

#[derive(Deserialize)]
struct Reference {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    columns: usize,
    history: Vec<String>,
    steps: Vec<Step>,
    parity: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    key: String,
    input_hex: String,
    line: String,
    point: usize,
    history_offset: usize,
}
fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}
fn feed(editor: &mut Editor, bytes: &[u8], geometry: Geometry) {
    for &byte in bytes {
        match editor.feed(byte) {
            Action::Echo(byte) => editor.echoed(byte),
            Action::Redraw => drop(editor.redraw()),
            Action::Submit(_) => {
                drop(editor.finish(geometry, false));
                editor.begin("$ ", geometry);
            }
            _ => (),
        }
    }
}
#[test]
fn bash5_readline_byte_replay() {
    let reference: Reference = serde_json::from_str(include_str!(
        "../../../../tests/terminal/readline-navigation.json"
    ))
    .unwrap();
    let mismatches: Vec<_> = reference.cases.iter().flat_map(replay).collect();
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
fn replay(case: &Case) -> Vec<String> {
    let mut mismatches = Vec::new();
    let mut editor = Editor::default();
    let geometry = Geometry::new(case.columns, 24);
    editor.begin("$ ", geometry);
    for entry in &case.history {
        feed(&mut editor, entry.as_bytes(), geometry);
        feed(&mut editor, b"\r", geometry);
    }
    for (index, step) in case.steps.iter().enumerate() {
        feed(&mut editor, &unhex(&step.input_hex), geometry);
        let actual = String::from_utf8(editor.line.clone()).unwrap();
        println!(
            "{}",
            serde_json::json!({
                "case": case.name, "step": index, "key": step.key, "inputHex": step.input_hex,
                "line": actual, "point": editor.cursor, "historyAt": editor.history_at,
                "expectedLine": step.line, "expectedPoint": step.point,
            "expectedHistoryOffset": step.history_offset, "selectedParity": case.parity
            })
        );
        if !case.parity {
            check_policy(case, index, &editor);
            continue;
        }
        let history_offset = editor.history_at.unwrap_or(editor.history.len());
        if actual != step.line
            || editor.cursor != step.point
            || history_offset != step.history_offset
        {
            mismatches.push(format!(
                "{} step {index} {}: point {} != {}; history {} != {}; line {:?} != {:?}",
                case.name,
                step.key,
                editor.cursor,
                step.point,
                history_offset,
                step.history_offset,
                actual,
                step.line
            ));
        }
    }
    mismatches
}

fn check_policy(case: &Case, index: usize, editor: &Editor) {
    let expected = match case.name.as_str() {
        "modified-arrows" => "one two\n\nthree",
        "shift-enter-policy" => ["# first", "# first\n", "# first\n# second"][index],
        name => panic!("unqualified input policy {name}"),
    };
    assert_eq!(editor.line, expected.as_bytes(), "{} {index}", case.name);
    assert_eq!(editor.cursor, expected.len(), "{} {index}", case.name);
}
