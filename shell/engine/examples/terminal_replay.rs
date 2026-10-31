//! Drives the interactive line editor the way `runtime_main.rs` does and prints the
//! bytes it writes, so `scripts/test-terminal-display.ts` can replay them into
//! libghostty-vt. Input lines: `prompt HEX`, `keys HEX`, `resize COLUMNS ROWS`,
//! `output HEX` (command output), `cancel` (a host interrupt while reading) and
//! `eof` (input ends while reading).
//! Output lines: `W HEX` (terminal bytes), `S HEX` (a submitted command),
//! `R COLUMNS ROWS` (resize the terminal now) and `E` (end of input).
#[path = "../src"]
mod source {
    pub mod terminal;
}
use source::terminal;
use std::io::{self, BufRead};
use terminal::{Action, Editor, Geometry, Mode};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex input"))
        .collect()
}
fn key(editor: &mut Editor, geometry: Geometry, byte: u8) -> Vec<String> {
    match editor.feed(byte) {
        Action::Echo(byte) => {
            editor.echoed(byte);
            vec![format!("W {}", hex(&[byte]))]
        }
        Action::Redraw => vec![format!("W {}", hex(&editor.redraw()))],
        Action::Bell => vec!["W 07".into()],
        Action::Submit(line) => vec![
            format!("S {}", hex(&line)),
            format!("W {}", hex(&editor.finish(geometry, false))),
        ],
        Action::Interrupt => vec![format!("W {}", hex(&editor.finish(geometry, true)))],
        Action::Eof => vec![
            format!("W {}", hex(&editor.finish(geometry, false))),
            "E".into(),
        ],
        Action::None => Vec::new(),
    }
}
fn main() {
    let mut columns = std::env::args().nth(1);
    let mut rows = std::env::args().nth(2);
    let parse = |value: &mut Option<String>| value.take().expect("COLUMNS ROWS").parse().unwrap();
    let mut geometry = Geometry::new(parse(&mut columns), parse(&mut rows));
    let mode = match std::env::args().nth(3).as_deref() {
        None | Some("bash") => Mode::Bash,
        Some("zsh") => Mode::Zsh,
        _ => panic!("expected editor mode bash or zsh"),
    };
    let mut editor = Editor::new(mode);
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let (command, argument) = line.split_once(' ').unwrap_or((&line, ""));
        let records = match command {
            "prompt" => {
                let prompt = String::from_utf8(unhex(argument)).unwrap();
                editor.begin(&prompt, geometry);
                vec![format!("W {}", hex(prompt.as_bytes()))]
            }
            "keys" => unhex(argument)
                .into_iter()
                .flat_map(|byte| {
                    editor.resize(geometry);
                    key(&mut editor, geometry, byte)
                })
                .collect(),
            "resize" => {
                let (columns, rows) = argument.split_once(' ').unwrap();
                geometry = Geometry::new(columns.parse().unwrap(), rows.parse().unwrap());
                vec![format!("R {columns} {rows}")]
            }
            "output" => vec![format!("W {argument}")],
            "cancel" => {
                editor.clear();
                vec![format!("W {}", hex(&editor.finish(geometry, true)))]
            }
            "eof" => vec![
                format!("W {}", hex(&editor.finish(geometry, false))),
                "E".into(),
            ],
            other => panic!("unknown replay command {other}"),
        };
        for record in records {
            println!("{record}");
        }
    }
}
