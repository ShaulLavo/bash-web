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
        "first\nsecond\nthird\nunquoted\n",
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
fn invalid_for_targets_fail_before_expansion_without_aborting_the_reader() {
    for name in ["i.j", "1", "x-y"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -e; for {name} in \"$(echo expanded >&2)\"; do echo body; done; echo status:$?"
            )),
            0,
        );
        assert_eq!(rig.output.bytes(), b"status:1\n");
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: line 1: `{name}': not a valid identifier\n").as_bytes(),
        );
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("\nfor i.j in; do echo body; done"), 1);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 2: `i.j': not a valid identifier\n",
    );
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
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

#[test]
fn errexit_ignores_conditions_and_nonfinal_and_or_commands() {
    check_output(
        "set -e; if false; then echo no; elif true; then echo yes; fi; false && echo no; true || echo no; ! true; i=0; while ((i<2)); do echo $i; ((i+=1)); done; echo after",
        "yes\n0\n1\nafter\n",
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("set -e; for x in a b; do echo $x; false; echo no; done; echo no"),
        1
    );
    assert_eq!(rig.output.bytes(), b"a\n");
}

#[test]
fn errexit_suppression_propagates_through_functions_and_pipeline_stages() {
    check_output(
        "set -e; f(){ false; echo body; }; if f; then echo selected; fi; f && echo last; echo after",
        "body\nselected\nbody\nlast\nafter\n",
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -e; true | { false; echo no; }; echo no"), 1);
    assert!(rig.output.bytes().is_empty());
    check_output("set -e; x=$(false; echo captured); echo $x", "captured\n");
    check_output("set -e; { false && true; }; echo after", "after\n");
}

// Original regressions, checked with GNU Bash 5.3.15; shared by native and WASI.
#[test]
fn compound_process_substitution_descriptors_close_before_wait() {
    for source in [
        "for path in >(cat); do :; done; wait; echo done",
        "for ((i=0;i<80;i++)); do for path in >(cat); do :; done; wait; done; echo done",
        "for path in >(cat); do exec 3>&63; done; echo held >&3; exec 3>&-; wait; echo done",
        "for path in >(cat); do exec 62>saved; done; wait; echo preserved >&62; cat saved",
        "for path in >(cat); do exec 63>&-; wait; echo inside; done; echo done",
        "for ((i=0;i<80;i++)); do for path in <(:); do :; done; wait; done; echo done",
        "for path in >(cat); do exec 63>saved; done; wait; echo lost 2>/dev/null >&63; echo closed:$?",
    ] {
        let expected = if source.contains("closed") {
            "closed:1\n"
        } else if source.contains("held") {
            "held\ndone\n"
        } else if source.contains("preserved") {
            "preserved\n"
        } else if source.contains("inside") {
            "inside\ndone\n"
        } else {
            "done\n"
        };
        let rig = Rig::new(Limits::default());
        let job = rig.shell.start(source).unwrap();
        for _ in 0..2048 {
            if job.is_finished() {
                break;
            }
            rig.ex.drive(64);
        }
        assert!(
            job.is_finished(),
            "temporary descriptor kept wait pending: {source}"
        );
        assert_eq!(rig.finish(job), 0, "{source}");
        assert_eq!(rig.output.bytes(), expected.as_bytes(), "{source}");
        assert!(rig.errors.bytes().is_empty(), "{source}");
    }
}

#[test]
fn compound_redirect_failures_obey_errexit_without_changing_body_status_rules() {
    for compound in [
        "if true; then :; fi",
        "for x in once; do :; done",
        "for ((i=0;i<1;i++)); do :; done",
        "while false; do :; done",
        "until true; do :; done",
        "case x in x) :;; esac",
        "{ :; }",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("set -e; {compound} 1>&9; echo survived")),
            1,
            "{compound}"
        );
        assert!(rig.output.bytes().is_empty(), "{compound}");
        check_output(
            &format!("set -e; {compound} 1>&9 || echo caught; echo survived"),
            "caught\nsurvived\n",
        );
        check_output(
            &format!("set -e; if {compound} 1>&9; then echo wrong; fi; echo survived"),
            "survived\n",
        );
        check_output(&format!("{compound} 1>&9; echo status:$?"), "status:1\n");
    }
    for source in [
        "set -e; for ((i=1/0;;)); do :; done; echo survived",
        "set -e; for ((;1/0;)); do :; done; echo survived",
        "set -e; for ((i=0;i<1;1/0)); do ((i+=1)); done; echo survived",
        "set -e; for i.j in once; do :; done; echo survived",
        "set -e; { false && true; }; echo survived",
        "readonly i=0; for ((i=1;;)); do :; done; echo survived",
    ] {
        check_output(source, "survived\n");
    }
    for source in [
        "set -e; readonly i=0; for ((i=1;;)); do :; done; echo survived",
        "set -e; readonly i=0; for ((;i++;)); do :; done; echo survived",
        "set -e; readonly i=0; for ((j=0;j<1;i++)); do ((j+=1)); done; echo survived",
        "set -e; readonly i=0; for ((i=1;;)); do :; done || echo caught; echo survived",
        "set -e; readonly x; for x in a; do :; done || echo caught; echo survived",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1, "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
    }
}

#[test]
fn closed_descriptor_redirects_diagnose_without_unconditionally_aborting() {
    let diagnostic = "/usr/bin/bash: line 1: 9: Bad file descriptor\n";
    for source in [
        ": 1>&9; echo status:$?",
        ": 0<&9; echo status:$?",
        ": 1>&0009; echo status:$?",
        ": 1>&9 2>errors; echo status:$?",
        "if true; then :; fi 1>&9; echo status:$?",
        "set -e; : 1>&9 || echo status:$?",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        assert_eq!(rig.output.bytes(), b"status:1\n", "{source}");
        assert_eq!(rig.errors.bytes(), diagnostic.as_bytes(), "{source}");
    }
    for source in [
        ": 2>&1 1>&9; echo status:$?",
        ": 2>errors 1>&9; echo status:$?; cat errors",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        let expected = if source.contains("cat errors") {
            format!("status:1\n{diagnostic}")
        } else {
            format!("{diagnostic}status:1\n")
        };
        assert_eq!(rig.output.bytes(), expected.as_bytes(), "{source}");
        assert!(rig.errors.bytes().is_empty(), "{source}");
    }
    check_output(": 2>&- 1>&9; echo status:$?", "status:1\n");
    for number in ["4294967296", "999999999999999999999999999"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!(": >&{number}; echo status:$?")), 0);
        assert_eq!(rig.output.bytes(), b"status:1\n");
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: line 1: {number}: Bad file descriptor\n").as_bytes()
        );
    }
    let number = "8".repeat(8192);
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(&format!(": >&{number}; echo status:$?")), 0);
    assert_eq!(rig.output.bytes(), b"status:1\n");
    assert_eq!(
        rig.errors.bytes(),
        format!("/usr/bin/bash: line 1: {number}: Bad file descriptor\n").as_bytes()
    );
    let rig = Rig::new(Limits::default());
    rig.variable("fd", &format!("{}9", "0".repeat(8192)));
    assert_eq!(rig.run(": 1>&\"$fd\"; echo status:$?"), 0);
    assert_eq!(rig.output.bytes(), b"status:1\n");
    assert_eq!(rig.errors.bytes(), diagnostic.as_bytes());
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("\n: 1>&9; echo status:$?"), 0);
    assert_eq!(rig.output.bytes(), b"status:1\n");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: line 2: 9: Bad file descriptor\n"
    );
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -e; : 1>&9; echo survived"), 1);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.errors.bytes(), diagnostic.as_bytes());
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}

#[test]
fn nested_control_flow_executes_on_the_deepest_admitted_parser_level() {
    for (prefix, suffix) in [
        ("if true; then ", "; fi"),
        ("for x in once; do ", "; done"),
        ("for ((;;)); do ", "; break; done"),
    ] {
        let mut accepted = 0;
        for depth in 1..=100 {
            let source = format!("{}echo leaf{}", prefix.repeat(depth), suffix.repeat(depth));
            let parsed = shell_parser::parser::Parser::new(&source).parse();
            if parsed.is_err() {
                break;
            }
            let rig = Rig::new(Limits::default());
            let status = rig.run(&source);
            // Execution is independently admitted; it may reject before its
            // parser depth boundary, but must never overflow the WASI stack.
            assert!(status == 0 || status == 2, "depth {depth}: {status}");
            if status == 0 {
                assert_eq!(rig.output.bytes(), b"leaf\n", "depth {depth}");
                accepted = depth;
            }
        }
        assert!(accepted >= 16, "only {accepted} levels executed");
    }
}

#[test]
fn indefinite_c_style_and_until_loops_yield_until_interrupted() {
    for source in ["for ((;;)); do :; done", "until false; do :; done"] {
        let rig = Rig::new(Limits::default());
        let job = rig.shell.start(source).unwrap();
        for _ in 0..512 {
            assert!(!job.is_finished(), "{source}");
            rig.ex.drive(64);
        }
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130, "{source}");
        assert_eq!(rig.run("echo after"), 0);
        assert_eq!(rig.output.bytes(), b"after\n");
    }
}

#[test]
fn for_list_expansion_shares_the_emitted_byte_allowance() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    rig.variable("a", &"x".repeat(80));
    rig.variable("b", &"y".repeat(80));
    assert_eq!(rig.run("for x in \"$a\" \"$b\"; do echo no; done"), 2);
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn exec_in_an_unredirected_loop_changes_the_surrounding_descriptor_bindings() {
    check_output(
        "exec 3>&1; for x in once; do exec >saved; done; echo body; printf 'saved:' >&3; cat saved >&3",
        "saved:body\n",
    );
    check_output(
        "exec 3>&1; if true; then exec >saved; fi; echo body; printf 'saved:' >&3; cat saved >&3",
        "saved:body\n",
    );
    check_output(
        "for x in once; do exec >saved; echo inner; done >outer; echo restored; cat saved",
        "restored\ninner\n",
    );
}
