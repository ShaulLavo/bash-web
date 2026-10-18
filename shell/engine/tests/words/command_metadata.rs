//! Original preservation controls for the command views at bash-web 92ab384.
//! These are engine baselines, not claims that the acceptance utilities are bash builtins.
use super::*;

#[test]
fn metadata_query_baseline_keeps_keywords_builtins_and_standins_distinct() {
    let rig = Rig::new(Limits::default());
    let keywords = [
        "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until",
        "do", "done", "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc",
    ];
    for name in keywords {
        let before = rig.output.bytes().len();
        assert_eq!(rig.run(&format!("command -V '{name}'")), 0, "{name}");
        assert_eq!(
            &rig.output.bytes()[before..],
            format!("{name} is a shell keyword\n").as_bytes()
        );
    }
    let builtins = [
        ":", "true", "false", "echo", "printf", "read", "export", "local", "readonly", "declare",
        "typeset", "cd", "pwd", "set", "shift", "command", "shopt", "exit", "return", "jobs",
        "wait", "kill", "unset", "test", "[", "break", "continue", "exec", "eval", "let",
    ];
    for name in builtins {
        let before = rig.output.bytes().len();
        assert_eq!(rig.run(&format!("command -V '{name}'")), 0, "{name}");
        assert_eq!(
            &rig.output.bytes()[before..],
            format!("{name} is a shell builtin\n").as_bytes()
        );
    }
    for name in ["cat", "grep", "mkdir", "seq", "type"] {
        let before = rig.output.bytes().len();
        assert_eq!(rig.run(&format!("command -v {name}")), 1, "{name}");
        assert_eq!(rig.output.bytes().len(), before);
    }
    assert_eq!(rig.run("type echo"), 127, "no type builtin is introduced");
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

#[test]
fn metadata_heredoc_baseline_does_not_normalize_the_query_exclusions() {
    for (name, command_local) in [
        ("cat", true),
        ("seq", true),
        ("grep", false),
        ("mkdir", false),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -u\n{name} <<EOF\n$missing\nEOF\nargs reached \"$?\"\n"
            )),
            if command_local { 0 } else { 127 },
            "{name}"
        );
        if command_local {
            assert_eq!(*rig.calls.borrow(), [vec!["reached", "127"]], "{name}");
        } else {
            assert!(rig.calls.borrow().is_empty(), "{name}");
        }
        assert_eq!(
            rig.errors.bytes(),
            b"/usr/bin/bash: line 2: missing: unbound variable\n"
        );
        assert!(rig.output.bytes().is_empty());
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("cat() { args forbidden; }; set -u\ncat <<EOF\n$missing\nEOF\nargs forbidden\n"),
        127
    );
    assert!(
        rig.calls.borrow().is_empty(),
        "function precedence still selects the shell-error view"
    );
}

#[test]
fn metadata_declaration_baseline_retains_literal_and_expanded_phases() {
    check(
        "v='a b'; export literal=$v; 'export' quoted=$v; n=export; $n expanded=$v; e\\xport escaped=$v; ex\\\nport continued=$v; command export wrapped=$v; args \"$literal\" \"$quoted\" \"$expanded\" \"$escaped\" \"$continued\" \"$wrapped\"",
        &[&["a b", "a", "a", "a", "a b", "a"]],
    );
}

#[test]
fn metadata_all_declarations_keep_syntax_even_when_functions_shadow_dispatch() {
    for name in ["export", "local", "readonly", "declare", "typeset"] {
        let rig = Rig::new(Limits::default());
        let escaped = format!("{}\\{}", &name[..1], &name[1..]);
        let continued = format!("{}\\\n{}", &name[..1], &name[1..]);
        assert_eq!(
            rig.run(&format!("v='a b'; f() {{ {name} literal=$v; '{name}' quoted=$v; n={name}; $n expanded=$v; {escaped} escaped=$v; {continued} continued=$v; command {name} wrapped=$v; args \"$literal\" \"$quoted\" \"$expanded\" \"$escaped\" \"$continued\" \"$wrapped\"; }}; f")),
            0,
            "{name}"
        );
        assert_eq!(
            *rig.calls.borrow(),
            [vec!["a b", "a", "a", "a", "a b", "a"]],
            "{name}"
        );
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "v='a b'; {name}() {{ args \"$@\"; }}; {name} value=$v; n={name}; $n value=$v"
            )),
            0,
            "{name}"
        );
        assert_eq!(
            *rig.calls.borrow(),
            [vec!["value=a b"], vec!["value=a", "b"]],
            "{name}"
        );
    }
}

#[test]
fn metadata_interpreter_handlers_keep_their_distinct_execution_phases() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("exec() { args forbidden; }; exec"), 0);
    assert!(
        rig.calls.borrow().is_empty(),
        "direct exec still precedes function lookup"
    );
    assert_eq!(
        rig.run("command exec"),
        127,
        "wrapped exec still follows the historical external route"
    );
    assert_eq!(
        rig.run("command -v exec"),
        0,
        "queries still see the function"
    );
    assert_eq!(
        rig.run("command eval 'v=eval'; command let 'n=7'; args \"$v\" \"$n\""),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["eval", "7"]]);
    assert_eq!(rig.run("v=prefix command eval ':'"), 2);
    assert_eq!(rig.run("v=prefix command let 'n=8'"), 2);
    assert_eq!(rig.shell.state().borrow().bindings()["v"], "eval");
    assert_eq!(rig.shell.state().borrow().bindings()["n"], "7");
}

#[test]
fn metadata_dispatch_baseline_preserves_function_bypass_and_prefix_restoration() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("v=outer; echo() { args function \"$v\"; }; v=inner echo; v=temporary command command echo builtin; args \"$v\"; command() { args shadowed; }; command echo ignored"),
        0
    );
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["function", "inner"], vec!["outer"], vec!["shadowed"]]
    );
    assert_eq!(rig.output.bytes(), b"builtin\n");
    assert!(rig.errors.bytes().is_empty());
}
