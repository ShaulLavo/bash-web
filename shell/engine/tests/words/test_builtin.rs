//! Original focused controls checked against GNU Bash 5.3.15. These test argv
//! semantics, independently of the shell's separate [[ ]] expression grammar.
use super::*;

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn expression(arguments: &[&str]) -> String {
    std::iter::once("test".to_owned())
        .chain(arguments.iter().map(|arg| quote(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}
fn status(arguments: &[&str], expected: i32) {
    let rig = Rig::new(Limits::default());
    let source = expression(arguments);
    assert_eq!(rig.run(&source), expected, "{arguments:?}");
    assert!(rig.output.bytes().is_empty(), "test must not write stdout");
    if expected != 2 {
        assert!(rig.errors.bytes().is_empty(), "{arguments:?}");
    }
}

#[test]
fn scalar_test_argv_matches_recorded_bash_5_3_15() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-test-argv.json"
    ))
    .unwrap();
    assert_eq!(
        fixture["bash"],
        "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)"
    );
    for case in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        let script = case["script"].as_str().unwrap();
        assert_eq!(
            rig.run(script),
            case["status"].as_i64().unwrap() as i32,
            "{script}"
        );
        assert_eq!(
            rig.output.bytes(),
            case["stdout"].as_str().unwrap().as_bytes(),
            "{script}"
        );
        assert_eq!(
            rig.errors.bytes().is_empty(),
            case["stderr"].as_str().unwrap().is_empty(),
            "{script}"
        );
    }
}

#[test]
fn empty_single_and_small_argument_counts_match_bash() {
    for (arguments, expected) in [
        (&[][..], 1),
        (&[""][..], 1),
        (&["!"][..], 0),
        (&["-n"][..], 0),
        (&["--"][..], 0),
        (&["("][..], 0),
        (&["!", "!"][..], 1),
        (&["!", ""][..], 0),
        (&["-n", ""][..], 1),
        (&["-z", ""][..], 0),
        (&["x", "y"][..], 2),
        (&["a", "-a"][..], 2),
        (&["!", "=", "!"][..], 0),
        (&["!", "!=", "!"][..], 1),
        (&["!", "-a", ""][..], 1),
        (&["!", "-o", ""][..], 0),
        (&["(", "!", ")"][..], 0),
        (&["(", "", ")"][..], 1),
        (&["(", "-n", "", ")"][..], 1),
        (&["!", "!", "!", "!"][..], 1),
    ] {
        status(arguments, expected);
    }
}

#[test]
fn bracket_requires_a_final_closing_operand_and_does_not_parse_options() {
    for (source, expected) in [
        ("[ ]", 1),
        ("[ x ]", 0),
        ("[ -- ]", 0),
        ("[ ']' ]", 0),
        ("[", 2),
        ("[ x", 2),
        ("[ x ] trailing", 2),
        ("[ x = x ]", 0),
        ("[ x = y ]", 1),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), expected, "{source}");
        assert!(rig.output.bytes().is_empty());
        if expected == 2 {
            assert!(
                String::from_utf8(rig.errors.bytes())
                    .unwrap()
                    .contains("missing `]'")
            );
        }
    }
}

#[test]
fn string_operators_are_literal_and_byte_ordered() {
    for (arguments, expected) in [
        (&["abc", "=", "abc"][..], 0),
        (&["abc", "==", "a*"][..], 1),
        (&["a*", "=", "a*"][..], 0),
        (&["abc", "!=", "a*"][..], 0),
        (&["a", "<", "b"][..], 0),
        (&["b", ">", "a"][..], 0),
        (&["a", "<", "aa"][..], 0),
        (&["aa", ">", "a"][..], 0),
        (&["", "=", ""][..], 0),
        (&["-n", "=", "-n"][..], 0),
    ] {
        status(arguments, expected);
    }
}

#[test]
fn decimal_integer_comparisons_do_not_use_shell_arithmetic() {
    for (arguments, expected) in [
        (&["08", "-eq", "8"][..], 0),
        (&["  +001 \n", "-eq", "1"][..], 0),
        (&["-0", "-eq", "0"][..], 0),
        (&["-2", "-lt", "-1"][..], 0),
        (&["2", "-le", "2"][..], 0),
        (&["2", "-ge", "2"][..], 0),
        (&["3", "-gt", "2"][..], 0),
        (&["3", "-ne", "2"][..], 0),
        (
            &["-9223372036854775808", "-lt", "9223372036854775807"][..],
            0,
        ),
        (&["9223372036854775808", "-eq", "0"][..], 2),
        (&["-9223372036854775809", "-eq", "0"][..], 2),
        (&["0x10", "-eq", "16"][..], 2),
        (&["1+1", "-eq", "2"][..], 2),
        (&["x", "-eq", "0"][..], 2),
        (&["", "-eq", "0"][..], 2),
        (&["1 2", "-eq", "12"][..], 2),
    ] {
        status(arguments, expected);
    }
}

#[test]
fn file_predicates_use_real_metadata_without_creating_or_reading_files() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("mkdir directory; printf payload > full; printf '' > empty"),
        0
    );
    for (arguments, expected) in [
        (&["-e", "full"][..], 0),
        (&["-a", "directory"][..], 0),
        (&["-f", "full"][..], 0),
        (&["-d", "directory"][..], 0),
        (&["-f", "directory"][..], 1),
        (&["-d", "full"][..], 1),
        (&["-s", "full"][..], 0),
        (&["-s", "empty"][..], 1),
        (&["-e", "missing"][..], 1),
        (&["-f", "missing"][..], 1),
        (&["-e", ""][..], 1),
        (&["-d", ""][..], 1),
        (&["-r", "full"][..], 0),
        (&["-w", "full"][..], 0),
        (&["-x", "full"][..], 1),
        (&["-x", "directory"][..], 0),
        (&["-u", "full"][..], 1),
        (&["-g", "full"][..], 1),
        (&["-k", "full"][..], 1),
        (&["-p", "full"][..], 1),
        (&["-b", "full"][..], 1),
        (&["-c", "full"][..], 1),
        (&["-S", "full"][..], 1),
        (&["-h", "full"][..], 1),
        (&["-L", "full"][..], 1),
        (&["-O", "full"][..], 0),
        (&["-G", "full"][..], 0),
        (&["-f", "./full"][..], 0),
        (&["-d", "directory/"][..], 0),
        (&["-f", "full/"][..], 1),
        (&["-e", "full/.."][..], 1),
        (&["-e", "missing/.."][..], 1),
        (&["full", "-ef", "./full"][..], 0),
        (&["full", "-ef", "empty"][..], 1),
        (&["missing", "-ef", "missing"][..], 1),
        (&["full", "-nt", "missing"][..], 0),
        (&["missing", "-ot", "full"][..], 0),
        (&["missing", "-nt", "full"][..], 1),
        (&["full", "-ot", "missing"][..], 1),
        (&["missing", "-nt", "missing"][..], 1),
        (&["missing", "-ot", "missing"][..], 1),
        (&["full", "-nt", "full"][..], 1),
        (&["full", "-ot", "full"][..], 1),
    ] {
        assert_eq!(rig.run(&expression(arguments)), expected, "{arguments:?}");
    }
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
    assert_eq!(rig.fs.read_file("/home/guest/full").unwrap(), b"payload");
    assert!(rig.fs.read_file("/home/guest/missing").is_err());
}

#[test]
fn virtual_descriptor_existence_uses_current_redirections() {
    check_output(
        "test -e /dev/fd/0; echo $?; test -e /dev/stdout; echo $?; test -e /dev/fd/99; echo $?; test -e /dev/fd/3 3> full; echo $?; test -e /dev/fd/3; echo $?",
        "0\n0\n1\n0\n1\n",
    );
}

#[test]
fn descriptor_pipe_queries_preserve_local_payload_and_release_writers() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"{ test -p /dev/stdout; echo $? >&2; [ -p /dev/fd/1 ]; echo $? >&2; [[ -p /dev/fd/3 ]] 3>&1; echo $? >&2; printf 'payload\n'; } | { test -p /dev/stdin; echo $?; [ -p /dev/fd/0 ]; echo $?; [[ -p /dev/fd/3 ]] 3<&0; echo $?; IFS= read -r line; echo "$line"; IFS= read -r line; echo $?; }"#), 0);
    assert_eq!(rig.output.bytes(), b"0\n0\n0\npayload\n1\n");
    assert_eq!(rig.errors.bytes(), b"0\n0\n0\n");
}

#[test]
fn descriptor_predicates_reject_files_missing_and_closed_fds_without_errors() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("test -p /dev/stdin; echo $?; [ -p /dev/fd/3 ] 3> full; echo $?; [[ -p /dev/fd/3 ]] 3>&-; echo $?; test -t 0; echo $?; [ -t 3 ] 3> full; echo $?; [[ -t 3 ]] 3>&-; echo $?"), 0);
    assert_eq!(rig.output.bytes(), b"1\n1\n1\n1\n1\n1\n");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn unrelated_descriptor_predicate_capability_errors_stay_unchanged() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("test -f /dev/stdin"), 2);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: test: -f: unsupported predicate\n"
    );
    assert_eq!(rig.run("[[ ! -f /dev/stdin ]]"), 2);
}

#[test]
fn terminal_descriptor_integer_syntax_and_errors_match_bash() {
    for value in [
        "-0",
        "+0",
        "00",
        " \t0\n",
        "-1",
        "2147483648",
        "4294967296",
        "9223372036854775807",
        "-9223372036854775808",
    ] {
        status(&["-t", value], 1);
    }
    for value in [
        "",
        "nope",
        "/dev/fd/0",
        "0x0",
        "1+0",
        "9223372036854775808",
        "-9223372036854775809",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&expression(&["-t", value])), 2);
        assert_eq!(
            rig.errors.bytes(),
            format!("/usr/bin/bash: test: {value}: integer expected\n").as_bytes()
        );
    }
    status(&["-t"], 0);
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("[ ! -t nope ]"), 2);
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: [: nope: integer expected\n"
    );
}

fn silent_statuses(cases: &[(&str, i32)]) {
    for &(source, expected) in cases {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), expected, "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert!(rig.errors.bytes().is_empty(), "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
}

#[test]
fn test_terminal_integer_errors_survive_closed_stderr() {
    silent_statuses(&[
        ("test -t nope 2>&-", 2),
        ("test ! -t nope 2>&-", 2),
        ("test -t nope 2>&- && args forbidden", 2),
        ("test -t nope 2>&- || :", 0),
        ("test x -o -t nope 2>&-", 2),
        ("test '' -a -t nope 2>&-", 2),
    ]);
}

#[test]
fn bracket_terminal_integer_errors_survive_closed_stderr() {
    silent_statuses(&[
        ("[ -t nope ] 2>&-", 2),
        ("[ ! -t nope ] 2>&-", 2),
        ("[ -t nope ] 2>&- && args forbidden", 2),
        ("[ -t nope ] 2>&- || :", 0),
        ("[ x -o -t nope ] 2>&-", 2),
        ("[ '' -a -t nope ] 2>&-", 2),
    ]);
}

#[test]
fn conditional_terminal_integer_errors_survive_closed_stderr() {
    silent_statuses(&[
        ("[[ -t nope ]] 2>&-", 2),
        ("[[ ! -t nope ]] 2>&-", 0),
        ("[[ -t nope || yes ]] 2>&-", 0),
        ("[[ -t nope && yes ]] 2>&-", 2),
        ("[[ yes || -t skipped ]] 2>&-", 0),
        ("[[ ! ( ! -t nope ) ]] 2>&-", 1),
        ("[[ ( -t nope ) ]] 2>&-", 2),
        ("[[ -t nope ]] 2>&- && args forbidden", 2),
    ]);
}

#[test]
fn closed_stderr_keeps_unrelated_predicate_errors_unchanged() {
    silent_statuses(&[
        ("test x -eq 0 2>&-", 1),
        ("[ x -eq 0 ] 2>&-", 1),
        ("[ x 2>&-", 1),
        ("test -f /dev/stdin 2>&-", 1),
        ("[ -f /dev/stdin ] 2>&-", 1),
        ("[[ ! -f /dev/stdin ]] 2>&-", 2),
    ]);
}

#[test]
fn logical_operators_and_grouping_preserve_precedence_and_eager_errors() {
    for (arguments, expected) in [
        (&["x", "-o", "", "-a", ""][..], 0),
        (&["", "-a", "x", "-o", "x"][..], 0),
        (&["!", "x", "-a", ""][..], 0),
        (&["x", "-a", "!", ""][..], 0),
        (&["(", "x", "-o", "", ")", "-a", ""][..], 1),
        (&["!", "(", "x", "-a", "", ")"][..], 0),
        (&["-n", "x", "-a", "-z", ""][..], 0),
        (&["x", "-a", "y", "-a", "-n"][..], 0),
        (&["x", "-a", "(", "!", ")"][..], 0),
        (&["x", "-a", "(", "-n", ")"][..], 0),
        (&["x", "-a", "y", "-a", "!"][..], 2),
        (&["x", "-o", "1", "-eq", "x"][..], 2),
        (&["", "-a", "1", "-eq", "x"][..], 2),
        (&["x", "-o", "-invalid", "z"][..], 2),
        (&["(", "x", "-a", "y"][..], 2),
        (&["x", "-a", "y", ")"][..], 2),
    ] {
        status(arguments, expected);
    }
}

#[test]
fn variable_predicates_resolve_scalar_references_without_requiring_nonempty_values() {
    check_output(
        "unset x; test -v x; echo $?; x=; test -v x; echo $?; declare -n ref=x; test -R ref; echo $?; test -v ref; echo $?; unset x; test -v ref; echo $?; test -R ref; echo $?; test -R x; echo $?; test -v PWD; echo $?; test -v 'invalid-name'; echo $?",
        "1\n0\n0\n0\n1\n0\n1\n0\n1\n",
    );
}

#[test]
fn shell_option_predicates_track_only_live_options() {
    check_output(
        "test -o nounset; echo $?; set -u; test -o nounset; echo $?; set +u; set -o pipefail; test -o pipefail; echo $?; set +o pipefail; test -o pipefail; echo $?; test -o unknown; echo $?; set -e; test -o errexit; echo $?; set +e; test -o errexit; echo $?",
        "1\n0\n0\n1\n1\n0\n1\n",
    );
}

#[test]
fn long_negation_chains_use_bounded_heap_frames_not_rust_recursion() {
    let rig = Rig::new(Limits::default());
    let source = format!("test {} x", "! ".repeat(5000));
    assert_eq!(rig.run(&source), 0);
    assert!(rig.output.bytes().is_empty());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn cancellation_during_a_large_string_comparison_keeps_the_session_usable() {
    let rig = Rig::new(Limits::default());
    rig.variable("value", &"x".repeat(100_000));
    let job = rig.shell.start("test \"$value\" = \"$value\"").unwrap();
    rig.ex.drive(2);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}

#[test]
fn break_continue_counts_validate_signed_decimal_and_stop_the_correct_loop() {
    for count in ["0", "-1", "+0"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "for i in a b; do continue {count}; echo forbidden; done; echo status:$?"
            )),
            0
        );
        assert_eq!(rig.output.bytes(), b"status:1\n");
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("loop count out of range")
        );
    }
    for count in ["x", "9223372036854775808", "-9223372036854775809"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "for i in a; do break {count}; done; echo forbidden"
            )),
            2
        );
        assert!(rig.output.bytes().is_empty());
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("numeric argument required")
        );
    }
    check_output(
        "for i in a b; do for j in c d; do echo $i$j; break 4294967296; done; echo forbidden; done; echo after",
        "ac\nafter\n",
    );
}

#[test]
fn nonpositive_break_and_continue_counts_unwind_all_enclosing_loops() {
    for command in ["break", "continue"] {
        for count in ["0", "-1", "+0"] {
            for depth in [2, 3] {
                let rig = Rig::new(Limits::default());
                let mut source = format!("echo visit; {command} {count}; echo inner-tail");
                for level in 0..depth {
                    source =
                        format!("for level{level} in a b; do {source}; echo tail{level}; done");
                }
                source.push_str("; saved=$?; echo status=$saved; exit $saved");
                assert_eq!(rig.run(&source), 1, "{command} {count}, depth {depth}");
                assert_eq!(rig.output.bytes(), b"visit\nstatus=1\n", "{source}");
                assert!(
                    String::from_utf8(rig.errors.bytes())
                        .unwrap()
                        .contains("loop count out of range"),
                    "{source}"
                );
            }
        }
    }
}

#[test]
fn loop_control_outside_loops_is_success_even_with_invalid_operands() {
    for operands in ["", "0", "-1", "bad", "1 2"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("break {operands}; echo status:$?")), 0);
        assert_eq!(rig.output.bytes(), b"status:0\n");
        assert!(
            String::from_utf8(rig.errors.bytes())
                .unwrap()
                .contains("only meaningful")
        );
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("for i in a; do break 1 2; done; echo forbidden"), 1);
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn shopt_tracks_option_state_queries_and_reusable_output() {
    check_output(
        "shopt -q inherit_errexit; echo status:$?; shopt -p inherit_errexit; echo status:$?; shopt -s inherit_errexit extglob nullglob; shopt -q inherit_errexit extglob nullglob; echo status:$?; shopt -p extglob inherit_errexit nullglob; shopt -u extglob inherit_errexit nullglob; shopt -q inherit_errexit extglob nullglob; echo status:$?",
        "status:1\nshopt -u inherit_errexit\nstatus:1\nstatus:0\nshopt -s extglob\nshopt -s inherit_errexit\nshopt -s nullglob\nstatus:1\n",
    );
}

#[test]
fn shopt_grouped_flags_and_normal_listing_follow_bash() {
    check_output(
        "shopt inherit_errexit; echo status:$?; shopt -qs extglob; echo status:$?; shopt -q extglob; echo status:$?; shopt -up extglob; echo status:$?; shopt -q extglob; echo status:$?; shopt -q; echo status:$?",
        "inherit_errexit     \toff\nstatus:1\nstatus:0\nstatus:0\nstatus:0\nstatus:1\nstatus:0\n",
    );
}

#[test]
fn shopt_rejects_unknown_options_without_faking_success() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("shopt -s unsupported"), 1);
    assert!(!rig.shell.state().borrow().inherit_errexit);
    assert!(!rig.shell.state().borrow().extglob);
    assert!(!rig.shell.state().borrow().nullglob);
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("invalid shell option name")
    );
    assert_eq!(rig.run("shopt -s -u inherit_errexit"), 1);
    assert!(!rig.shell.state().borrow().inherit_errexit);
    assert_eq!(rig.run("shopt -s extglob unsupported nullglob"), 1);
    assert!(rig.shell.state().borrow().extglob);
    assert!(rig.shell.state().borrow().nullglob);
    assert_eq!(rig.run("shopt -z inherit_errexit"), 2);
    assert!(!rig.shell.state().borrow().inherit_errexit);
}

#[test]
fn shopt_flags_are_copied_to_isolated_shells_without_leaking_child_changes() {
    check_output(
        "shopt -s inherit_errexit extglob nullglob; (shopt -u inherit_errexit extglob nullglob); shopt -q inherit_errexit extglob nullglob; echo parent:$?; value=$(shopt -q inherit_errexit extglob nullglob; echo child:$?; shopt -u inherit_errexit extglob nullglob); echo \"$value\"; shopt -q inherit_errexit extglob nullglob; echo parent:$?",
        "parent:0\nchild:0\nparent:0\n",
    );
}

#[test]
fn command_substitutions_clear_errexit_unless_inherit_errexit_is_enabled() {
    for setting in ["", "shopt -u inherit_errexit;"] {
        check_output(
            &format!(
                "set -e; {setting} result=$(false; echo survived); echo result:$result; echo after"
            ),
            "result:survived\nafter\n",
        );
    }
    for substitution in ["$(false; echo forbidden)", "`false; echo forbidden`"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                "set -e; shopt -s inherit_errexit; result={substitution}; echo forbidden"
            )),
            1
        );
        assert!(rig.output.bytes().is_empty());
        assert!(rig.errors.bytes().is_empty());
    }
    // Enabling inheritance preserves the parent's -e value, not force-enables it.
    check_output(
        "shopt -s inherit_errexit; result=$(false; echo survived); echo result:$result; echo after",
        "result:survived\nafter\n",
    );
}

#[test]
fn inherited_errexit_nested_echo_and_local_declarations_mask_inner_failure() {
    check_output(
        "set -e; shopt -s inherit_errexit; result=$(echo \"outer: $(false; echo forbidden)\"); echo \"result: $result\"; echo after",
        "result: outer: \nafter\n",
    );
    check_output(
        "set -e; shopt -u inherit_errexit; result=$(echo \"outer: $(false; echo inner)\"); echo \"result: $result\"; echo after",
        "result: outer: inner\nafter\n",
    );
    check_output(
        "set -e; shopt -s inherit_errexit; f() { local result=$(false; echo forbidden); echo local:$result; }; f; echo after",
        "local:\nafter\n",
    );
}

#[test]
fn positive_extglob_case_match_and_miss_preserve_errexit_status() {
    check_output(
        "set -e\nshopt -s extglob\ncase xyz in a*(b)c) echo forbidden;; esac\nsaved=$?; echo status:$saved; case abbc in a*(b)c) echo matched;; esac; echo after",
        "status:0\nmatched\nafter\n",
    );
}

#[test]
fn negative_extglob_case_match_and_miss_preserve_errexit_status() {
    check_output(
        "set -e\nshopt -s extglob\ncase xyz in a!(b)c) echo forbidden;; esac\nsaved=$?; echo status:$saved; case abc in a!(b)c) echo forbidden;; esac; echo excluded:$?; case axc in a!(b)c) echo matched;; esac; echo matched:$?; echo after",
        "status:0\nexcluded:0\nmatched\nmatched:0\nafter\n",
    );
}

#[test]
fn errexit_short_and_long_options_validate_atomically() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -eu; set +e; set +u"), 0);
    assert!(!rig.shell.state().borrow().errexit);
    assert_eq!(rig.run("set -ez"), 2);
    assert!(!rig.shell.state().borrow().errexit);
    assert_eq!(rig.run("set -o errexit; set +o errexit"), 0);
    assert!(!rig.shell.state().borrow().errexit);
    assert_eq!(rig.run("set -e; false; echo forbidden"), 1);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("set +e; echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}
