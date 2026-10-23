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
    let Command::Simple(simple) = &script.commands[0] else {
        panic!("simple alias command")
    };
    assert_eq!(simple.span.start.offset, 12);
    assert_eq!(simple.span.start.line, 2);
}

#[test]
fn read_units_stop_after_compounds_quotes_and_heredocs_without_copying_source() {
    for unit in [
        "x one; x two\n",
        "if true; then\nx one\nfi\n",
        "f() {\nx one\n}\n",
        "x 'one\ntwo'\n",
        "read -r line <<EOF\none\nEOF\n",
    ] {
        let source = format!("{unit}x later\n");
        let (script, error, next) = Parser::new(&source)
            .with_options(options(&[("x", "echo")]))
            .parse_read_unit_recovering();
        assert!(error.is_none(), "{source}: {error:?}");
        assert_eq!(script.commands.len(), 1, "{source}");
        assert!(
            script.source.is_none(),
            "read units borrow their caller's source"
        );
        let position = next.expect("next read unit");
        assert!(position.offset < unit.len(), "{position:?}: {source}");
        let (rest, error, _) = Parser::at_position(
            &source,
            100,
            100_000,
            None,
            options(&[("x", "printf")]),
            position,
        )
        .parse_read_unit_recovering();
        assert!(error.is_none(), "{source}: {error:?}");
        assert_eq!(
            rest.command_starts,
            [(unit.len(), unit.lines().count() + 1)]
        );
        assert_eq!(
            command_string(&rest.commands[0], &Cell::new(100_000), 100_000, None).unwrap(),
            "printf later",
            "{source}"
        );
    }
}

#[test]
fn read_unit_does_not_parse_or_charge_the_unread_suffix() {
    let source = format!("x first\n{}", "x later\n".repeat(4_000));
    let aliases = options(&[("x", "echo -------------------------------------")]);
    assert!(
        Parser::with_fuel(&source, 200)
            .with_options(aliases.clone())
            .parse()
            .is_err()
    );
    let (script, error, next) = Parser::with_fuel(&source, 200)
        .with_options(aliases)
        .parse_read_unit_recovering();
    assert!(error.is_none(), "{error:?}");
    assert_eq!(script.commands.len(), 1);
    assert_eq!(next.unwrap().line, 1);
    assert!(script.source.is_none());
}

#[test]
fn read_unit_keeps_syntax_recovery_and_multiline_failure_lines() {
    let source = "x before\nif;\nx after\n";
    let (_, error, next) = Parser::new(source).parse_read_unit_recovering();
    assert!(error.is_none());
    let (script, error, next) = Parser::at_position(
        source,
        100,
        100_000,
        None,
        ParseOptions::default(),
        next.unwrap(),
    )
    .parse_read_unit_recovering();
    assert!(script.commands.is_empty());
    assert!(matches!(
        error,
        Some(shell_parser::Error::Parse { line: 2, .. })
    ));
    assert!(next.is_none());
}
