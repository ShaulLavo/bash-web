use shell_parser::{
    ParseOptions, Parser,
    parser::{Command, Position, command_string},
};
use std::{cell::Cell, collections::HashMap, sync::Arc};

fn options(entries: &[(&str, &str)]) -> ParseOptions {
    ParseOptions {
        aliases: Some(Arc::new(HashMap::from_iter(
            entries
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string())),
        ))),
        extglob: true,
    }
}

fn rendered(source: &str, entries: &[(&str, &str)]) -> Vec<String> {
    Parser::new(source)
        .with_options(options(entries))
        .parse()
        .unwrap()
        .commands
        .iter()
        .map(|command| command_string(command, &Cell::new(100_000), 100_000, None).unwrap())
        .collect()
}

#[test]
fn alias_recursion_stops_on_the_last_word_without_a_trailing_blank() {
    assert_eq!(rendered("x\nx", &[("x", "x")]), ["x", "x"]);
    assert_eq!(rendered("x\ny", &[("x", "y"), ("y", "x")]), ["x", "y"]);
    assert_eq!(rendered("x", &[("x", "echo prefix")]), ["echo prefix"]);
}

#[test]
fn trailing_blank_chains_only_after_the_value_has_been_read() {
    let aliases = [
        ("p", "echo one "),
        ("one", "ONE "),
        ("two", "TWO "),
        ("last", "LAST"),
    ];
    assert_eq!(
        rendered("p two one last two", &aliases),
        ["echo one TWO ONE LAST two"]
    );
}

#[test]
fn suffix_reader_keeps_original_source_offsets_and_lines() {
    let source = "# prefix\n  x tail\n";
    let script = Parser::at_position(
        source,
        100,
        100_000,
        None,
        options(&[("x", "echo")]),
        Position {
            line: 2,
            column: 3,
            offset: 11,
        },
    )
    .parse()
    .unwrap();
    assert_eq!(script.command_starts, [(11, 2)]);
    assert_eq!(script.source.as_deref(), Some(source));
    let Command::Simple(simple) = &script.commands[0] else { panic!("simple alias command") };
    assert_eq!(simple.span.start.offset, 12);
    assert_eq!(simple.span.start.line, 2);
}
