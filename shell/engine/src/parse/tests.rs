//! Original facade contracts against the exact pre-facade parser calls.
use super::*;
use shell_parser::limits::LimitExceeded;
use std::{rc::Rc, sync::Arc, sync::atomic::AtomicBool, time::Duration};

fn budget(work: u64) -> ExecutionBudget {
    ExecutionBudget::new(
        &ExecutionLimits {
            max_work_units: work,
            timeout: Duration::MAX,
            ..ExecutionLimits::default()
        },
        Arc::new(AtomicBool::new(false)),
    )
}

fn value<T: serde::Serialize>(
    result: shell_parser::Result<T>,
) -> Result<serde_json::Value, String> {
    result
        .map(|value| serde_json::to_value(value).unwrap())
        .map_err(|error| format!("{error:?}"))
}

#[test]
fn script_and_eval_delegate_recovery_ast_lines_and_error_kinds() {
    for source in [
        "printf ok\n",
        "[[ x == !(y) ]]\n",
        "printf before\nif;\n",
        "printf before\nprintf $(if;)\n",
        "printf '${x:-$(if;)}'\n",
        "f() { printf hi; }; f\n",
        "alias later='if'; later\n",
    ] {
        let limits = ExecutionLimits::default();
        let (expected, failure) = Parser::with_limits_and_timeout(
            source,
            limits.max_ast_depth,
            limits.max_parser_operations,
            Some(limits.parser_timeout),
        )
        .with_execution_budget(budget(u64::MAX))
        .with_strict_substitution_bodies()
        .parse_recovering();
        for entry in [script, eval] {
            let (actual, actual_failure) = entry(
                source,
                source.len(),
                &budget(u64::MAX),
                ParseOptions {
                    extglob: true,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(actual.commands).unwrap(),
                serde_json::to_value(&expected.commands).unwrap(),
                "{source}"
            );
            assert_eq!(
                actual.command_end_lines, expected.command_end_lines,
                "{source}"
            );
            match (&failure, actual_failure) {
                (None, None) => {}
                (
                    Some(shell_parser::Error::ShellWord { line }),
                    Some(ParseFailure::Word(actual)),
                ) => {
                    assert_eq!(*line, actual);
                }
                (
                    Some(shell_parser::Error::Parse { message, line, .. }),
                    Some(ParseFailure::Syntax {
                        message: actual,
                        line: actual_line,
                    }),
                ) => assert_eq!((message, *line), (&actual, actual_line)),
                _ => panic!("reader changed recovery/error kind for {source}"),
            }
        }
    }
}

#[test]
fn reader_source_limit_counts_bytes_and_precedes_budget_probe() {
    for entry in [script, eval] {
        assert!(entry("é", 2, &budget(u64::MAX), ParseOptions::default()).is_ok());
        let cancelled = budget(u64::MAX).with_cancellation_probe(Rc::new(|| true));
        assert_eq!(
            entry("é", 1, &cancelled, ParseOptions::default())
                .err()
                .unwrap(),
            "shell source limit exceeded"
        );
        assert_eq!(cancelled.check(), Err(LimitExceeded::Cancelled));
    }
}

#[test]
fn reader_preserves_shared_sticky_work_failure_and_cancellation() {
    for entry in [script, eval] {
        let exhausted = budget(0);
        let error = entry(
            "printf $(printf nested)",
            100,
            &exhausted,
            ParseOptions::default(),
        )
        .err()
        .unwrap();
        let failure = exhausted.check().unwrap_err();
        assert!(matches!(failure, LimitExceeded::WorkUnits { .. }));
        assert_eq!(error, failure.to_string());
        assert_eq!(
            eval("", 100, &exhausted, ParseOptions::default())
                .err()
                .unwrap(),
            error
        );
        let cancelled = budget(u64::MAX).with_cancellation_probe(Rc::new(|| true));
        assert_eq!(
            entry("printf ok", 100, &cancelled, ParseOptions::default())
                .err()
                .unwrap(),
            "request cancelled"
        );
        assert_eq!(cancelled.clone().check(), Err(LimitExceeded::Cancelled));
    }
}

#[test]
fn generated_words_preserve_word_context_and_general_depth_policy() {
    let nested = format!("{}x{}", "${x:-".repeat(20), "}".repeat(20));
    for source in [
        "if",
        "{",
        "[",
        "",
        "x=y",
        "'a b'",
        "$(if;)",
        nested.as_str(),
    ] {
        assert_eq!(
            value(generated_word(source)),
            value(Parser::parse_expanded_word_with_limits(
                source,
                ExecutionLimits::default().max_ast_depth,
                source.len().saturating_add(3).saturating_mul(16),
            )),
            "{source}"
        );
    }
    assert!(
        generated_word(&nested).is_ok(),
        "must not use operand depth 16"
    );
}

#[test]
fn lazy_parameter_preserves_outer_quotes_pattern_and_raw_inactive_text() {
    for token in ["${x:-\"$y\"}", "${x:-$(if;)}", "${x/a/b}", "${x:-}", "bad"] {
        for quoted in [false, true] {
            for pattern in [false, true] {
                assert_eq!(
                    value(lazy_parameter(token, quoted, pattern)),
                    value(Parser::parse_parameter_token_with_limits(
                        token, 16, 65536, quoted, pattern
                    )),
                    "{token}, quoted={quoted}, pattern={pattern}"
                );
            }
        }
    }
    // Parsing a selected outer header must not recursively parse its operand.
    assert!(lazy_parameter("${x:-$(if;)}", false, false).is_ok());
}

#[test]
fn lazy_variable_preserves_infallible_word_and_scalar_limits() {
    for token in ["$x", "$?", "$9", "$missing", "$(if;)"] {
        assert_eq!(
            serde_json::to_value(lazy_variable(token)).unwrap(),
            serde_json::to_value(Parser::parse_word_string_with_limits(token, 16, 65536)).unwrap(),
        );
    }
}

#[test]
fn substitution_token_preserves_strict_bodies_and_resource_results() {
    let deep = format!("$({}:{} )", "( ".repeat(105), " )".repeat(105));
    for token in [
        "$(printf ok)",
        "$(if;)",
        "$((1 + 2))",
        "$(",
        "bad",
        deep.as_str(),
    ] {
        assert_eq!(
            value(substitution_token(token)),
            value(Parser::parse_substitution_token_with_limits(
                token,
                100,
                token.len().saturating_add(3).saturating_mul(16),
            )),
            "{token}"
        );
    }
    assert!(substitution_token(&deep).is_err());
}

#[test]
fn backtick_body_keeps_deferred_syntax_and_separate_resource_errors() {
    for body in ["printf ok", "if;", "printf $(printf nested)", ""] {
        assert_eq!(
            value(backtick_body(body)),
            value(Parser::parse_backtick_body_with_limits(
                body,
                100,
                body.len().saturating_add(3).saturating_mul(16),
            )),
        );
    }
    assert!(matches!(
        backtick_body("if;"),
        Ok(WordPart::UnparsedCommandSubstitution { .. })
    ));
    let deep = format!("{}:{}", "( ".repeat(105), " )".repeat(105));
    assert!(matches!(
        backtick_body(&deep),
        Err(shell_parser::Error::ResourceLimit(_))
    ));
}

#[test]
fn substitution_grammar_keeps_default_options_and_lower_depth_limit() {
    let deep = format!("{}:{}", "( ".repeat(20), " )".repeat(20));
    for source in ["printf ok", "if;", "a() { :; }; a", deep.as_str()] {
        let expected = Parser::with_limits_and_options(source, 16, 65536, ParseOptions::default())
            .with_substitution_body()
            .parse()
            .map(|_| ());
        assert_eq!(
            value(substitution_grammar(source)),
            value(expected),
            "{source}"
        );
    }
    assert!(matches!(
        substitution_grammar(&deep),
        Err(shell_parser::Error::ResourceLimit(_))
    ));
}

#[test]
fn declaration_tokens_preserve_raw_capture_spans_and_incremental_order() {
    for source in [
        "A=1 declare x='a b' >out y=\"quoted\"",
        "d\\eclare x=y",
        "declare x=$(printf ok) 2>&1 y=z",
    ] {
        let mut old = Lexer::new(source);
        old.set_capture_raw(true);
        let mut actual = declaration_tokens(source);
        while let Some(expected) = old.next_spanned_token() {
            assert_eq!(actual.next(), Some(expected));
        }
        assert_eq!(actual.next(), None);
    }
}

#[test]
fn reader_budget_admission_matches_old_call_at_every_work_boundary() {
    let source = "printf $(printf nested)\n";
    for fuel in 0..128 {
        let expected_budget = budget(fuel);
        let limits = ExecutionLimits::default();
        let (_, error) = Parser::with_limits_and_timeout(
            source,
            limits.max_ast_depth,
            limits.max_parser_operations,
            Some(limits.parser_timeout),
        )
        .with_execution_budget(expected_budget.clone())
        .with_strict_substitution_bodies()
        .parse_recovering();
        let expected = expected_budget
            .check()
            .map_err(|error| error.to_string())
            .and_then(|()| match error {
                Some(shell_parser::Error::ResourceLimit(error)) => Err(error.to_string()),
                _ => Ok(()),
            });
        for entry in [script, eval] {
            let actual_budget = budget(fuel);
            assert_eq!(
                entry(source, source.len(), &actual_budget).map(|_| ()),
                expected,
                "fuel={fuel}",
            );
            assert_eq!(actual_budget.check(), expected_budget.check());
        }
    }
}
