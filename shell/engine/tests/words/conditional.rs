//! Original structured conditional controls, checked against GNU Bash 5.3.
use super::*;

#[test]
fn conditional_strings_and_status_are_not_external_commands() {
    check_output(
        r#"[[ text ]]; echo $?; [[ '' ]]; echo $?; [[ -n '' ]]; echo $?; [[ -z '' ]]; echo $?; [[ -n text ]]; echo $?; [[ -z text ]]; echo $?"#,
        "0\n1\n1\n0\n0\n1\n",
    );
}

#[test]
fn conditional_equality_keeps_rhs_quote_protection() {
    check_output(
        r#"p='a*'; [[ abc == $p ]]; echo $?; [[ abc == "$p" ]]; echo $?; [[ 'a*' == "$p" ]]; echo $?; [[ abc = a?c ]]; echo $?; [[ abc != a[c-d]c ]]; echo $?; [[ a == [!b] ]]; echo $?; [[ abc == 'a'* ]]; echo $?; [[ abc == a\* ]]; echo $?"#,
        "0\n1\n0\n0\n0\n0\n0\n1\n",
    );
}

#[test]
fn conditional_ansi_c_quoted_patterns_match_literal_text() {
    for (source, expected) in [
        (r#"v='a[bc'; [[ "$v" == $'a[bc' ]]; echo $?"#, "0\n"),
        (r#"[[ abc == $'a*' ]]; echo $?"#, "1\n"),
        (r#"[[ 'a*' == $'a\x2a' ]]; echo $?"#, "0\n"),
        (r#"[[ 'a?tail' == $'a?'* ]]; echo $?"#, "0\n"),
        (r#"[[ abc != $'a*' ]]; echo $?"#, "0\n"),
        (r#"[[ '$v' == $'$v' ]]; echo $?"#, "0\n"),
    ] {
        check_output(source, expected);
    }
}

#[test]
fn conditional_operands_do_not_split_glob_or_expand_braces() {
    check_output(
        r#"IFS=:; v='one:two'; [[ $v == 'one:two' ]]; echo $?; [[ '*' == '*' ]]; echo $?; [[ {a,b} == '{a,b}' ]]; echo $?; [[ 'a b' == a\ b ]]; echo $?"#,
        "0\n0\n0\n0\n",
    );
}

#[test]
fn conditional_positional_patterns_join_all_values_even_when_quoted() {
    check_output(
        r#"set -- 'a*' b; [[ 'ax b' == $@ ]]; echo $?; [[ 'a* b' == "$@" ]]; echo $?; [[ a == "$@" ]]; echo $?; IFS=:; [[ 'a*:b' == "$*" ]]; echo $?; [[ 'a* b' == "$@" ]]; echo $?; set --; [[ '' == "$@" ]]; echo $?"#,
        "0\n0\n1\n0\n0\n0\n",
    );
}

#[test]
fn conditional_short_circuit_skips_expansion_substitutions_and_errors() {
    check(
        r#"[[ yes || ${side:=wrong} ]]; [[ '' && ${other:=wrong} ]]; [[ yes || $(args forbidden) ]]; [[ '' && $((1/0)) ]]; [[ yes || $missing ]]; args "${side-unset}" "${other-unset}""#,
        &[&["unset", "unset"]],
    );
    check(
        r#"set -u; [[ yes || $missing ]]; [[ '' && $missing ]]; args survived"#,
        &[&["survived"]],
    );
}

#[test]
fn conditional_logical_precedence_groups_and_negation() {
    check_output(
        r#"[[ yes || '' && '' ]]; echo $?; [[ ( yes || '' ) && '' ]]; echo $?; [[ ! '' && yes ]]; echo $?; [[ ! ( yes && '' ) ]]; echo $?; [[ ! ! yes ]]; echo $?"#,
        "0\n1\n0\n0\n0\n",
    );
}

#[test]
fn conditional_quoted_or_expanded_operator_text_is_an_operand() {
    check_output(
        r#"op='!'; [[ $op ]]; echo $?; [[ '!' ]]; echo $?; [[ '(' ]]; echo $?; [[ '-z' ]]; echo $?; [[ x == '&&' ]]; echo $?; [[ '||' == '||' ]]; echo $?"#,
        "0\n0\n0\n0\n1\n0\n",
    );
}

#[test]
fn conditional_string_order_and_all_arithmetic_comparisons() {
    check_output(
        r#"[[ abc < abd ]]; echo $?; [[ abc > abd ]]; echo $?; [[ abc < abc ]]; echo $?; [[ 3 -eq 3 ]]; echo $?; [[ 3 -ne 4 ]]; echo $?; [[ 2 -lt 3 ]]; echo $?; [[ 3 -le 3 ]]; echo $?; [[ 4 -gt 3 ]]; echo $?; [[ 3 -ge 3 ]]; echo $?; [[ '' -eq 0 ]]; echo $?; [[ 010 -eq 8 ]]; echo $?"#,
        "0\n1\n1\n0\n0\n0\n0\n0\n0\n0\n0\n",
    );
}

#[test]
fn conditional_numeric_operands_use_shell_arithmetic_and_keep_writes() {
    check(
        r#"x=3; expression='x+2'; [[ $expression -eq 5 ]]; args $?; [[ 'x+=2' -eq 5 ]]; args $? "$x"; [[ '' && 'x=9' -eq 9 ]]; args "$x"; [[ $((x+=1)) -eq 6 ]]; args $? "$x""#,
        &[&["0"], &["0", "5"], &["5"], &["0", "6"]],
    );
}

#[test]
fn conditional_numeric_faults_are_false_and_keep_short_circuit_and_negation() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"x=3; [[ 1/0 -eq x++ ]]; args $? "$x"; [[ ! 1/0 -eq 0 ]]; args $?; [[ 1/0 -eq 0 || yes ]]; args $?; readonly fixed=1; [[ ! fixed=2 -eq 2 ]]; args $? "$fixed""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["1", "3"], vec!["0"], vec!["0"], vec!["0", "1"]]
    );
    assert!(!rig.errors.bytes().is_empty());
    // A literal dollar expression returned by expansion is not expanded again.
    assert_eq!(
        rig.run(r#"value='$((1+1))'; [[ $value -eq 2 ]]; args $?"#),
        0
    );
    assert_eq!(*rig.calls.borrow().last().unwrap(), ["1"]);
}

#[test]
fn conditional_selected_substitutions_expand_once() {
    check(
        r#"[[ $(echo hello) == h* ]] && args yes; [[ hello == $(echo 'h*') ]] && args pattern; [[ ${created:=hello} == hello ]] && args "$created""#,
        &[&["yes"], &["pattern"], &["hello"]],
    );
}

#[test]
fn conditional_shared_variable_and_option_predicates() {
    check_output(
        r#"present=; [[ -v present ]]; echo $?; [[ -v absent ]]; echo $?; [[ -o nounset ]]; echo $?; set -u; [[ -o nounset ]]; echo $?; [[ -o pipefail ]]; echo $?; set -o pipefail; [[ -o pipefail ]]; echo $?"#,
        "0\n1\n1\n0\n1\n0\n",
    );
}

#[test]
fn conditional_errexit_respects_outer_conditional_context() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -e; [[ '' ]]; args forbidden"), 1);
    assert!(rig.calls.borrow().is_empty());
    check(
        "set -e; [[ '' ]] || args fallback; if [[ '' ]]; then args forbidden; else args else; fi",
        &[&["fallback"], &["else"]],
    );
}

#[test]
fn conditional_invalid_regex_is_an_error_not_a_false_match() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("p='['; [[ value =~ $p ]]"), 2);
    assert_eq!(rig.run("[[ ! value =~ $p ]]"), 2);
    assert_eq!(rig.run("[[ yes || value =~ $p ]]"), 0);
}

#[test]
fn conditional_file_predicates_use_real_metadata_and_missing_file_rules() {
    check_output(
        r#"mkdir dir; : > empty; echo content > filled; [[ -d dir && -f filled && -s filled ]]; echo $?; [[ -e empty && ! -s empty && ! -f dir && ! -e missing ]]; echo $?; [[ filled -ef filled ]]; echo $?; [[ filled -ef empty ]]; echo $?; [[ filled -nt missing ]]; echo $?; [[ missing -ot filled ]]; echo $?; [[ missing -nt filled ]]; echo $?; [[ filled -ot missing ]]; echo $?"#,
        "0\n0\n0\n1\n0\n0\n1\n1\n",
    );
}

#[test]
fn conditional_terminal_integer_error_is_a_logical_status_not_expansion_failure() {
    for (source, expected, diagnostic) in [
        ("[[ -t nope ]]", 2, true),
        ("[[ ! -t nope ]]", 0, true),
        ("[[ -t nope || yes ]]", 0, true),
        ("[[ -t nope && yes ]]", 2, true),
        ("[[ yes || -t nope ]]", 0, false),
        ("[[ ! ( ! -t nope ) ]]", 1, true),
        ("[[ ( -t nope ) ]]", 2, true),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), expected, "{source}");
        let errors = if diagnostic {
            "/usr/bin/bash: [[: nope: integer expected\n"
        } else {
            ""
        };
        assert_eq!(rig.errors.bytes(), errors.as_bytes(), "{source}");
    }
}

#[test]
fn conditional_terminal_negation_keeps_direct_parity_and_group_boundaries() {
    for (expression, expected, diagnostic) in [
        ("! ! -t nope", 2, true),
        ("! ! ! -t nope", 0, true),
        ("! ! ! ! -t nope", 2, true),
        ("! ( ! -t nope )", 1, true),
        ("! ! ( -t nope )", 2, true),
        ("! ( ! ! -t nope )", 0, true),
        ("! ! ( ! -t nope )", 0, true),
        ("! ( ! ( ! -t nope ) )", 0, true),
        ("! ! -t nope && yes", 2, true),
        ("! ! -t nope || yes", 0, true),
        ("! ! -t nope || ''", 1, true),
        ("yes && ! ! -t nope", 2, true),
        ("'' || ! ! -t nope", 2, true),
        ("yes || ! ! -t skipped", 0, false),
        ("'' && ! ! -t skipped", 1, false),
        ("! ( ! -t nope ) && yes", 1, true),
        ("! ( ! -t nope ) || yes", 0, true),
        ("! ! yes", 0, false),
        ("! ! ''", 1, false),
        ("! ! ! yes", 1, false),
        ("! ! ! ''", 0, false),
        ("! ! ! ! yes", 0, false),
        ("! ! ! ! ''", 1, false),
    ] {
        terminal_negation(expression, expected, diagnostic);
    }
}

fn terminal_negation(expression: &str, expected: i32, diagnostic: bool) {
    for closed in [false, true] {
        let rig = Rig::new(Limits::default());
        let redirect = if closed { " 2>&-" } else { "" };
        let source = format!("[[ {expression} ]]{redirect}");
        assert_eq!(rig.run(&source), expected, "{source}");
        let errors = if diagnostic && !closed {
            "/usr/bin/bash: [[: nope: integer expected\n"
        } else {
            ""
        };
        assert_eq!(rig.errors.bytes(), errors.as_bytes(), "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
}

#[test]
fn conditional_resource_rejection_does_not_dispatch_a_selected_command() {
    let rig = Rig::new(Limits {
        expansion_bytes: 64,
        ..Limits::default()
    });
    assert_eq!(rig.run("[[ yes == y* ]] && args forbidden"), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn conditional_wide_chains_do_not_become_deep_expression_trees() {
    let rig = Rig::new(Limits {
        expansion_bytes: 8 * 1024 * 1024,
        ..Limits::default()
    });
    let source = format!("[[ {}yes ]] && args reached", "yes && ".repeat(400));
    assert_eq!(rig.run(&source), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["reached"]]);
}

#[test]
fn conditional_long_work_yields_and_cancellation_does_not_leak() {
    let rig = Rig::new(Limits {
        expansion_bytes: 16 * 1024 * 1024,
        ..Limits::default()
    });
    let text = "x".repeat(64 * 1024);
    rig.variable("left", &text);
    rig.variable("right", &text);
    let job = rig
        .shell
        .start("args started; [[ $left < $right ]]; args forbidden")
        .unwrap();
    for _ in 0..2000 {
        rig.ex.drive(1);
        if !rig.calls.borrow().is_empty() {
            break;
        }
    }
    assert_eq!(*rig.calls.borrow(), [vec!["started"]]);
    for _ in 0..10 {
        rig.ex.drive(1);
    }
    assert!(!job.is_finished(), "long scalar comparison must yield");
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(*rig.calls.borrow(), [vec!["started"]]);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn conditional_invalid_multiline_terms_do_not_dispatch() {
    for source in [
        "[[ a\n]] && args forbidden",
        "[[ ( a\n) ]] && args forbidden",
        "[[ a\n&& b ]] && args forbidden",
        "[[ ( ! a\n) ]] && args forbidden",
        "[[ -n\na ]] && args forbidden",
        "[[ a ==\na ]] && args forbidden",
    ] {
        let rig = Rig::new(Limits::default());
        // A malformed first read unit is rejected synchronously by start().
        assert!(rig.shell.start(source).is_err(), "{source:?}");
        assert!(rig.calls.borrow().is_empty(), "{source:?}");
        // With a completed earlier unit, the shell runs that prefix and reports
        // the later parse failure through its job status, as a script reader.
        assert_eq!(rig.run(&format!(":\n{source}")), 2, "{source:?}");
        assert!(rig.calls.borrow().is_empty(), "{source:?}");
        assert!(rig.output.bytes().is_empty(), "{source:?}");
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
    }
}

#[test]
fn conditional_valid_multiline_grammar_still_executes() {
    check_output(
        "[[\na ]] && echo first; [[ a &&\nb ]] && echo second; [[ -n a\n]] && echo third; [[ a == a\n]] && echo fourth; [[ ( a )\n]] && echo fifth",
        "first\nsecond\nthird\nfourth\nfifth\n",
    );
}
