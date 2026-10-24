//! Original contracts that started from the independent production-view
//! inventory at bash-web 92ab384, plus subsequently added builtins.
//! Baseline lists belong in tests, not in production dispatch.
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
    ".", ":", "[", "break", "builtin", "cd", "command", "compgen", "complete", "compopt",
    "continue", "declare", "dirs", "echo", "enable", "eval", "exec", "exit", "export", "false",
    "getopts", "caller", "hash", "jobs", "kill", "let", "local", "popd", "printf", "pushd", "pwd",
    "read", "readonly", "return", "set", "shift", "shopt", "source", "alias", "unalias", "test",
    "trap", "true", "type", "typeset", "unset", "wait",
];

#[test]
fn catalogue_has_unique_exact_names() {
    let unique: BTreeSet<_> = COMMANDS.iter().map(|command| command.name).collect();
    assert_eq!(unique.len(), COMMANDS.len());
    for command in COMMANDS {
        assert!(std::ptr::eq(lookup(command.name).unwrap(), command));
    }
    for missing in ["", "Echo", "/bin/echo", " export", "export "] {
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
fn builtin_dispatch_covers_the_current_builtin_arms_not_the_old_is_builtin_set() {
    assert_eq!(
        names(|command| matches!(command.handler(), Some(Handler::Builtin(_)))),
        baseline(&[
            ":", "true", "false", "echo", "printf", "read", "getopts", "caller", "trap", "export",
            "local", "readonly", "declare", "typeset", "cd", "pwd", "pushd", "popd", "dirs", "set",
            "shift", "shopt", "alias", "unalias", "exit", "return", "jobs", "wait", "kill",
            "unset", "test", "[", "break", "continue", "compgen", "complete", "compopt", "enable"
        ])
    );
    // `command` was recognized by is_builtin but never had a builtins::run arm.
    // exec/eval/let always lived in interpreter-owned phases.
    for (name, expected) in [
        ("command", Handler::Command),
        ("builtin", Handler::BuiltinWrapper),
        ("type", Handler::Type),
        ("hash", Handler::Hash),
        ("exec", Handler::Exec),
        ("eval", Handler::Eval),
        (".", Handler::Source),
        ("source", Handler::Source),
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
            ".", ":", "break", "continue", "eval", "exec", "exit", "export", "readonly", "return",
            "set", "shift", "trap", "unset",
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

#[test]
fn enable_registry_masks_only_supported_builtin_slots() {
    let mut disabled = 0;
    for command in COMMANDS.iter().filter(|command| command.query_builtin()) {
        assert_eq!(enabled_handler(command.name, disabled), command.handler());
        assert!(set_enabled(command.name, &mut disabled, false));
        assert!(!enabled(command.name, disabled));
        assert_eq!(enabled_handler(command.name, disabled), None);
    }
    let before = disabled;
    for unsupported in ["times", "cat", "if", "time", "unknown"] {
        assert!(!set_enabled(unsupported, &mut disabled, true));
        assert!(!enabled(unsupported, disabled));
        assert_eq!(disabled, before);
    }
    for command in COMMANDS.iter().filter(|command| command.query_builtin()) {
        assert!(set_enabled(command.name, &mut disabled, true));
        assert_eq!(enabled_handler(command.name, disabled), command.handler());
    }
    assert_eq!(disabled, 0);
}
