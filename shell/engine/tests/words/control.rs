//! Control-flow cases checked against GNU Bash 5.3.15.
use super::*;

#[test]
fn if_elif_else_and_empty_selection_statuses_match_bash() {
    check_output(
        "if false; then echo no; elif true; then echo yes; else echo no; fi; echo status:$?; if false; then echo no; fi; echo status:$?",
        "yes\nstatus:0\nstatus:0\n",
    );
}

#[test]
fn while_and_until_run_bodies_until_the_condition_flips() {
    check_output(
        "i=0; while ((i<2)); do echo w$i; ((i++)); done; i=0; until ((i==2)); do echo u$i; ((i++)); done",
        "w0\nw1\nu0\nu1\n",
    );
}

#[test]
fn for_words_and_positional_parameters_expand_as_fields() {
    check_output(
        "for x in a \"b c\"; do printf '<%s>\\n' \"$x\"; done; f(){ for x; do printf '<%s>\\n' \"$x\"; done; }; f a \"b c\"",
        "<a>\n<b c>\n<a>\n<b c>\n",
    );
}

#[test]
fn c_style_for_handles_empty_clauses_and_arithmetic_updates() {
    check_output(
        "for ((i=0; i<3; i++)); do echo $i; done; j=0; for ((;j<2;)); do echo x$j; ((j++)); done",
        "0\n1\n2\nx0\nx1\n",
    );
}

#[test]
fn case_preserves_quoted_patterns_and_supports_case_fallthrough() {
    check_output(
        "x=foo; case \"$x\" in \"f\"*) echo first;;& *o) echo second;;& foo) echo third;; esac; x=bar; case \"$x\" in \"b*\") echo quoted;;& b*) echo unquoted;; esac",
        "first\nsecond\nthird\nquoted\nunquoted\n",
    );
}

#[test]
fn nested_break_and_continue_counts_target_the_requested_loop() {
    check_output(
        "for i in 1 2; do echo before$i; for j in a b; do echo \"$i$j\"; continue 2; echo no; done; echo outer; done",
        "before1\n1a\nbefore2\n2a\n",
    );
    check_output(
        "for i in 1 2; do for j in a b; do echo \"$i$j\"; break 2; done; echo no; done; echo after",
        "1a\nafter\n",
    );
}

#[test]
fn readonly_for_assignment_stops_before_the_body() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("readonly x=keep; for x in a b; do echo body; done; echo status:$?"),
        0
    );
    assert_eq!(rig.output.bytes(), b"status:1\n");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 1: x: readonly variable\n"
    );
}

#[test]
fn bad_loop_counts_match_bash_statuses() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("for i in 1; do break 0; echo body; done; echo status:$?"),
        0
    );
    assert_eq!(rig.output.bytes(), b"status:1\n");

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("for i in 1 2; do echo before$i; continue 0; echo body; done; echo status:$?"),
        0
    );
    assert_eq!(rig.output.bytes(), b"before1\nstatus:1\n");

    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("for i in 1; do break x; echo body; done; echo after"),
        2
    );
    assert!(rig.output.bytes().is_empty());
}
