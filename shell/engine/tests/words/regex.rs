//! Original no-capture ERE and dynamic-clock controls shared by native/WASI.
use super::*;

#[test]
fn regex_literals_quotes_anchors_and_alternation() {
    check_output(
        r#"p='a.c'; [[ abc =~ $p ]]; echo $?; [[ abc =~ "$p" ]]; echo $?; [[ a.c =~ "$p" ]]; echo $?; [[ prefixabc =~ abc ]]; echo $?; [[ prefixabc =~ ^abc ]]; echo $?; [[ abc =~ abc$ ]]; echo $?; [[ abcx =~ abc$ ]]; echo $?; p='^ab|cd$'; [[ zzcd =~ $p ]]; echo $?; [[ '' =~ '' ]]; echo $?; [[ '[' =~ '[' ]]; echo $?; [[ value =~ '[' ]]; echo $?; [[ ! value =~ '[' ]]; echo $?"#,
        "0\n1\n0\n0\n1\n0\n1\n0\n0\n0\n1\n0\n",
    );
}

#[test]
fn regex_classes_ranges_and_repetition() {
    check_output(
        r#"p='^[[:digit:]]{2,3}[a-c]+[^x]?$'; [[ 12abc =~ $p ]]; echo $?; [[ 123abz =~ $p ]]; echo $?; [[ 1abc =~ $p ]]; echo $?; [[ 1234abc =~ $p ]]; echo $?; p='^ab*c+d?$'; [[ ac =~ $p ]]; echo $?; [[ abbbccd =~ $p ]]; echo $?; [[ abd =~ $p ]]; echo $?; p='^a{2,}$'; [[ aa =~ $p ]]; echo $?; [[ aaaa =~ $p ]]; echo $?; [[ a =~ $p ]]; echo $?; p='^[[:space:]][[:xdigit:]]$'; [[ ' F' =~ $p ]]; echo $?"#,
        "0\n0\n1\n1\n0\n0\n1\n0\n0\n1\n0\n",
    );
}

#[test]
fn regex_source_escapes_and_variable_escapes_keep_distinct_roles() {
    check_output(
        r#"[[ '1.23' =~ ^[0-9]+\.[0-9]{2}$ ]]; echo $?; [[ '1x23' =~ ^[0-9]+\.[0-9]{2}$ ]]; echo $?; p='^[0-9]+\.[0-9]{2}$'; [[ '1.23' =~ $p ]]; echo $?; [[ '1x23' =~ $p ]]; echo $?; [[ abc =~ ^'a.c'$ ]]; echo $?; [[ a.c =~ ^'a.c'$ ]]; echo $?; [[ '(a)' =~ '(a)' ]]; echo $?"#,
        "0\n1\n0\n1\n1\n0\n0\n",
    );
}

#[test]
fn regex_invalid_or_unsupported_forms_never_turn_into_false_predicates() {
    for pattern in [
        "[",
        "[z-a]",
        "[[:unknown:]]",
        "a{3,2}",
        "(){32768}",
        "(){32768,}",
        "(){0,32768}",
        "a{",
        "\\",
        "(a",
        "a)",
        "(a)\\1",
        "\\1",
        "[[.x.]]",
        "[[=a=]]",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("pattern", pattern);
        assert_eq!(
            rig.run("[[ value =~ $pattern ]] && args forbidden"),
            2,
            "{pattern:?}"
        );
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run("[[ ! value =~ $pattern ]]"), 2, "{pattern:?}");
        assert_eq!(rig.run("[[ yes || value =~ $pattern ]]"), 0);
        assert_eq!(rig.run("[[ '' && value =~ $pattern ]]"), 1);
    }
}

#[test]
fn epoch_realtime_reads_the_host_clock_and_disables_only_on_unset() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"set -u; before=$EPOCHREALTIME; EPOCHREALTIME=ignored; after=${EPOCHREALTIME}; [[ -v EPOCHREALTIME && $before =~ ^[0-9]+\.[0-9]{6}$ && $after =~ ^[0-9]+\.[0-9]{6}$ ]] && args valid; args "${EPOCHREALTIME:+present}"; unset EPOCHREALTIME; args "${EPOCHREALTIME-missing}"; EPOCHREALTIME=ordinary; args "$EPOCHREALTIME"; [[ -v EPOCHREALTIME ]] && args set"#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["valid"],
            vec!["present"],
            vec!["missing"],
            vec!["ordinary"],
            vec!["set"]
        ]
    );
    let state = rig.shell.state();
    assert_eq!(
        state
            .borrow()
            .bindings()
            .get("EPOCHREALTIME")
            .map(String::as_str),
        Some("ordinary")
    );
    let before = state
        .borrow()
        .bindings()
        .get("before")
        .unwrap()
        .parse::<f64>()
        .unwrap();
    let after = state
        .borrow()
        .bindings()
        .get("after")
        .unwrap()
        .parse::<f64>()
        .unwrap();
    assert!(
        after >= before,
        "successive host clock reads must not be a fixed fixture value"
    );
}

#[test]
fn epoch_realtime_local_shadow_restores_the_dynamic_hook() {
    check_output(
        r#"f(){ local EPOCHREALTIME=local; echo "$EPOCHREALTIME"; unset EPOCHREALTIME; echo "${EPOCHREALTIME-unset}"; }; f; [[ $EPOCHREALTIME =~ ^[0-9]+\.[0-9]{6}$ ]] && echo global"#,
        "local\nunset\nglobal\n",
    );
}

#[test]
fn epoch_realtime_modifiers_read_a_clock_value_not_a_placeholder() {
    check_output(
        r#"[[ ${EPOCHREALTIME:-absent} =~ ^[0-9]+\.[0-9]{6}$ ]]; echo $?; [[ ${EPOCHREALTIME%.*} =~ ^[0-9]+$ ]]; echo $?; [[ ${EPOCHREALTIME##*.} =~ ^[0-9]{6}$ ]]; echo $?; [[ ${EPOCHREALTIME: -6} =~ ^[0-9]{6}$ ]]; echo $?; [[ ${EPOCHREALTIME/./x} =~ ^[0-9]+x[0-9]{6}$ ]]; echo $?; [[ ${EPOCHREALTIME^^} =~ ^[0-9]+\.[0-9]{6}$ ]]; echo $?; [[ ${#EPOCHREALTIME} -gt 7 ]]; echo $?; ref=EPOCHREALTIME; [[ ${!ref} =~ ^[0-9]+\.[0-9]{6}$ ]]; echo $?"#,
        "0\n0\n0\n0\n0\n0\n0\n0\n",
    );
}

#[test]
fn regex_tiny_storage_rejects_without_running_a_branch() {
    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        ..Limits::default()
    });
    rig.variable("pattern", "a{10000}");
    assert_eq!(rig.run("[[ a =~ $pattern ]] && args forbidden"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn regex_long_match_yields_interrupts_and_recovers_without_processes() {
    let rig = Rig::new(Limits {
        expansion_bytes: 32 * 1024 * 1024,
        ..Limits::default()
    });
    rig.variable("pattern", "^((a|aa)*)*b$");
    rig.variable("text", &"a".repeat(64 * 1024));
    let job = rig
        .shell
        .start("args started; [[ $text =~ $pattern ]]; args forbidden")
        .unwrap();
    for _ in 0..2000 {
        rig.ex.drive(1);
        if !rig.calls.borrow().is_empty() {
            break;
        }
    }
    for _ in 0..10 {
        rig.ex.drive(1);
    }
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(*rig.calls.borrow(), [vec!["started"]]);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn epoch_realtime_assignment_rhs_keeps_the_dynamic_hook() {
    check_output(
        r#"EPOCHREALTIME=ignored second=$EPOCHREALTIME; [[ $second =~ ^[0-9]+\.[0-9]{6}$ ]] && echo rhs; [[ $EPOCHREALTIME =~ ^[0-9]+\.[0-9]{6}$ ]] && echo global"#,
        "rhs\nglobal\n",
    );
}

#[test]
fn regex_non_ascii_input_and_patterns_are_explicitly_unsupported_in_all_locales() {
    // Bash 5.3 distinguishes these cases: C.UTF-8 classifies é as alpha,
    // whereas C matches its two UTF-8 bytes with ^..$. Until both character
    // models exist, neither combination may silently become a false match.
    for locale in ["C", "POSIX", "C.UTF-8", "C.utf8"] {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", locale);
        rig.variable("value", "é");
        rig.variable("pattern", "^[[:alpha:]]$");
        for source in [
            "[[ $value =~ $pattern ]]",
            "[[ ! $value =~ $pattern ]]",
            "[[ $value =~ ^..$ ]]",
            "[[ ! $value =~ ^..$ ]]",
            "[[ ascii =~ 'é' ]]",
        ] {
            assert_eq!(rig.run(source), 2, "locale={locale}, source={source}");
            assert!(rig.calls.borrow().is_empty());
        }
        assert_eq!(
            rig.run("[[ yes || $value =~ $pattern ]] && args skipped"),
            0
        );
        assert_eq!(rig.run("[[ '' && $value =~ $pattern ]]"), 1);
        assert_eq!(*rig.calls.borrow(), [vec!["skipped"]]);
        assert_eq!(rig.run("[[ abc =~ ^[[:alpha:]]+$ ]] && args ascii"), 0);
        assert_eq!(*rig.calls.borrow().last().unwrap(), ["ascii"]);
    }
}

#[test]
fn regex_locale_precedence_preserves_supported_ascii_and_rejects_other_locales() {
    check_output(
        r#"LANG=C.utf8; LC_CTYPE=POSIX; LC_COLLATE=C; [[ ab12 =~ ^[[:alpha:]]{2}[[:digit:]]{2}$ ]]; echo $?; LC_ALL=C.UTF-8; LC_CTYPE=unimplemented; LC_COLLATE=unimplemented; [[ ab12 =~ ^[a-z]+[0-9]+$ ]]; echo $?; LC_ALL=C; [[ ! ab =~ ^[0-9]+$ ]]; echo $?"#,
        "0\n0\n0\n",
    );
    for variable in ["LC_ALL", "LC_CTYPE", "LC_COLLATE", "LANG"] {
        let rig = Rig::new(Limits::default());
        rig.variable(variable, "en_US.utf8");
        assert_eq!(rig.run("[[ abc =~ ^[a-z]+$ ]]"), 2, "{variable}");
        assert_eq!(rig.run("[[ ! abc =~ ^[a-z]+$ ]]"), 2, "{variable}");
        assert_eq!(rig.run("[[ yes || abc =~ ^[a-z]+$ ]] && args skipped"), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["skipped"]]);
    }
}

#[test]
fn regex_grouped_alternatives_and_nested_repetition() {
    check_output(
        r#"p='^((ab|c){2,3})+$'; [[ abc =~ $p ]]; echo $?; [[ cabababc =~ $p ]]; echo $?; [[ ab =~ $p ]]; echo $?; p='^(a|)b?$'; [[ '' =~ $p ]]; echo $?; [[ ab =~ $p ]]; echo $?; [[ ac =~ $p ]]; echo $?"#,
        "0\n0\n1\n0\n0\n1\n",
    );
}

#[test]
fn regex_source_grouping_preserves_spaces_and_expansions() {
    check_output(
        r#"[[ 'a  b' =~ ^(a  b)$ ]]; echo $?; [[ 'a b' =~ ^(a  b)$ ]]; echo $?; f=fff; [[ fffx =~ $f(x) ]]; echo $?; [[ a=x =~ a=(x) ]]; echo $?; [[ '< >' =~ (< >) ]]; echo $?; [[ xy =~ x+((y)) ]]; echo $?; [[ '[' =~ ^([x[]) ]]; echo $?"#,
        "0\n1\n0\n0\n0\n0\n0\n",
    );
}

#[test]
fn regex_grouped_anchors_empty_cycles_and_quoted_punctuation() {
    check_output(
        r#"p='(^)*'; [[ a =~ $p ]]; echo $?; p='($)+'; [[ a =~ $p ]]; echo $?; p='^(()|a?)*$'; [[ aaa =~ $p ]]; echo $?; [[ b =~ $p ]]; echo $?; p='(a^|b$)'; [[ a =~ $p ]]; echo $?; [[ xb =~ $p ]]; echo $?; [[ bx =~ $p ]]; echo $?; [[ '(a|b)+' =~ ^'('a'|'b')+'$ ]]; echo $?; [[ a =~ ^('a'|"b")$ ]]; echo $?; [[ x =~ ^('a'|"b")$ ]]; echo $?"#,
        "0\n0\n0\n1\n1\n0\n1\n0\n0\n1\n",
    );
}

#[test]
fn regex_group_depth_and_repeated_group_storage_recover() {
    let rig = Rig::new(Limits::default());
    rig.variable("pattern", &format!("{}a{}", "(".repeat(64), ")".repeat(64)));
    assert_eq!(rig.run("[[ a =~ $pattern ]]"), 0);
    rig.variable("pattern", &format!("{}a{}", "(".repeat(65), ")".repeat(65)));
    assert_eq!(rig.run("[[ a =~ $pattern ]] && args forbidden"), 2);
    rig.variable("pattern", "((ab|cd){10000}){10000}");
    assert_eq!(rig.run("[[ a =~ $pattern ]] && args forbidden"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("[[ ab =~ ^(ab|cd)$ ]] && args recovered"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["recovered"]]);
}
