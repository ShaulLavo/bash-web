//! Original contracts against the independent production-view inventory at
//! bash-web 92ab384. Baseline lists belong in tests, not in production dispatch.
use super::*;
use std::collections::BTreeSet;

fn names(predicate: impl Fn(&Command) -> bool) -> Vec<&'static str> {
    let mut names: Vec<_> = COMMANDS
        .iter()
        .filter(|command| predicate(command))
        .map(|command| command.name)
        .collect();
    names.sort_unstable();
    names
}
fn baseline(names: &[&'static str]) -> Vec<&'static str> {
    let mut names = names.to_vec();
    names.sort_unstable();
    names
}

const BUILTINS: &[&str] = &[
    ":", "[", "break", "builtin", "cd", "command", "continue", "declare", "echo", "eval", "exec",
    "exit", "export", "false", "getopts", "jobs", "kill", "let", "local", "printf", "pwd", "read",
    "readonly", "return", "set", "shift", "shopt", "test", "true", "typeset", "unset", "wait",
];

#[test]
fn catalogue_has_unique_exact_names_and_no_type_builtin() {
    let unique: BTreeSet<_> = COMMANDS.iter().map(|command| command.name).collect();
    assert_eq!(unique.len(), COMMANDS.len());
    for command in COMMANDS {
        assert!(std::ptr::eq(lookup(command.name).unwrap(), command));
    }
    for missing in ["", "type", "Echo", "/bin/echo", " export", "export "] {
        assert!(lookup(missing).is_none(), "{missing:?}");
    }
}

#[test]
fn declaration_metadata_matches_only_the_five_literal_syntax_candidates() {
    assert_eq!(
        names(|command| command.declaration == Declaration::AssignmentOperands),
        baseline(&["export", "local", "readonly", "declare", "typeset"])
    );
    for command in COMMANDS {
        assert_eq!(
            command.declaration == Declaration::AssignmentOperands,
            command.handler() == Some(Handler::Builtin(Builtin::Declaration)),
            "{}",
            command.name
        );
    }
}

#[test]
fn adapter_dispatch_preserves_the_old_dispatch_set_not_the_old_is_builtin_set() {
    assert_eq!(
        names(|command| matches!(command.handler(), Some(Handler::Builtin(_)))),
        baseline(&[
            ":", "true", "false", "echo", "printf", "read", "getopts", "export", "local",
            "readonly", "declare", "typeset", "cd", "pwd", "set", "shift", "shopt", "exit",
            "return", "jobs", "wait", "kill", "unset", "test", "[", "break", "continue"
        ])
    );
    // `command` was recognized by is_builtin but never had a builtins::run arm.
    // exec/eval/let always lived in interpreter-owned phases.
    for (name, expected) in [
        ("command", Handler::Command),
        ("builtin", Handler::BuiltinWrapper),
        ("exec", Handler::Exec),
        ("eval", Handler::Eval),
        ("let", Handler::Let),
    ] {
        assert_eq!(handler(name), Some(expected));
    }
}

#[test]
fn query_views_match_the_independent_baseline_sets() {
    assert_eq!(
        names(Command::query_keyword),
        baseline(&[
            "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until",
            "do", "done", "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc",
        ])
    );
    assert_eq!(names(Command::query_builtin), baseline(BUILTINS));
}

#[test]
fn heredoc_view_matches_builtin_query_membership_without_external_commands() {
    assert_eq!(names(Command::shell_heredoc_errors), baseline(BUILTINS));
    assert_eq!(
        names(|command| command.shell_heredoc_errors() && !command.query_builtin()),
        baseline(&[])
    );
}

#[test]
fn classes_and_capabilities_do_not_mislabel_standins_or_unimplemented_syntax() {
    assert_eq!(
        names(|command| command.class == Class::SpecialBuiltin),
        baseline(&[
            ":", "break", "continue", "eval", "exec", "exit", "export", "readonly", "return",
            "set", "shift", "unset",
        ])
    );
    assert_eq!(
        names(|command| command.availability == Availability::UnsupportedSyntax),
        baseline(&["time", "coproc"])
    );
    for command in COMMANDS {
        if command.class == Class::Keyword {
            assert!(command.handler().is_none());
            assert!(!command.query_builtin());
            assert!(!command.shell_heredoc_errors());
        } else {
            assert!(command.handler().is_some());
        }
    }
}

#[test]
fn external_utilities_are_not_shell_commands() {
    for name in ["cat", "grep", "mkdir", "seq"] {
        assert!(lookup(name).is_none());
    }
}
