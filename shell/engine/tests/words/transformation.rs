use super::{Limits, Rig, check};

#[test]
fn transformation_quotes_scalars_for_reuse() {
    check(
        r#"x='hello world'; v="it's"; q="'"; qq="''"; e=; args "${x@Q}" "${v@Q}" "${q@Q}" "${qq@Q}" "${e@Q}" "${undef@Q}""#,
        &[&[
            "'hello world'",
            r"'it'\''s'",
            r"\'",
            r"''\'''\'''",
            "''",
            "",
        ]],
    );
    check(
        r#"x='a b'; e=; args "${x@K}" "${x@k}" "${e@K}" "${undef@k}""#,
        &[&["'a b'", "'a b'", "''", ""]],
    );
    check(
        r#"x="FOO'BAR spam\"eggs"; eval "new=${x@Q}"; test "$x" = "$new" && args OK"#,
        &[&["OK"]],
    );
}

#[test]
fn transformation_quoting_uses_ansi_c_only_for_unprintable_characters() {
    check(
        r#"LC_ALL=C.UTF-8; x=$'one\ntwo \u03bc'; t=$'a\tb'; z=$'\e[1m\x7f'; n=$'a\u0085b'; s=$'\\\'x\n'; args "${x@Q}" "${t@Q}" "${z@Q}" "${n@Q}" "${s@Q}""#,
        &[&[
            r"$'one\ntwo μ'",
            r"$'a\tb'",
            r"$'\E[1m\177'",
            r"$'a\302\205b'",
            r"$'\\\'x\n'",
        ]],
    );
    check(
        r#"LC_ALL=C; x=é; y=$'é\n'; args "${x@Q}" "${y@Q}""#,
        &[&[r"$'\303\251'", r"$'\303\251\n'"]],
    );
    check(
        r#"x=$(printf 'a\tb'); args "tab: ${x@Q}""#,
        &[&[r"tab: $'a\tb'"]],
    );
}

#[test]
fn transformation_assignments_and_attributes_follow_scalar_state() {
    check(
        r#"x=x; e=; readonly r=1; export p='a b'; declare -r u; export w; args "${x@A}" "${e@A}" "${r@A}" "${p@A}" "${u@A}" "${w@A}" "${undef@A}" "${x@a}" "${r@a}" "${p@a}" "${u@a}" "${undef@a}""#,
        &[&[
            "x='x'",
            "e=''",
            "declare -r r='1'",
            "declare -x p='a b'",
            "declare -r u",
            "declare -x w",
            "",
            "",
            "r",
            "x",
            "r",
            "",
        ]],
    );
    check(
        r#"t=$'\t'; v="it's"; args "${t@A}" "${v@A}""#,
        &[&[r"t=$'\t'", r"v='it'\''s'"]],
    );
    check(
        r#"target='hello world'; declare -n ref=target; args "${ref@Q}" "${ref@A}" "${ref@a}" "${ref@U}"; readonly target; args "${ref@A}" "${ref@a}""#,
        &[
            &["'hello world'", "target='hello world'", "", "HELLO WORLD"],
            &["declare -r target='hello world'", "r"],
        ],
    );
    check(
        r#"f() { local -r z=1; local y=2; local w; args "${z@A}" "${z@a}" "${y@A}" "${w@A}" "${y@a}"; g; }; g() { args "${y@A}"; }; f"#,
        &[
            &["declare -r z='1'", "r", "declare y='2'", "declare w", ""],
            &["y='2'"],
        ],
    );
}

#[test]
fn transformation_special_and_positional_parameters() {
    check(
        r#"set -- 'a b' "c'd"; args "${1@Q}" "${2@Q}" "${3@Q}" "${?@Q}" "${1@A}" "${?@a}" "${1@E}" "${2@U}""#,
        &[&["'a b'", r"'c'\''d'", "", "'0'", "", "", "a b", "C'D"]],
    );
}

#[test]
fn transformation_expands_backslash_escapes() {
    check(
        r#"x='a\n\"b\tc\\d\e\q\'; args "${x@E}""#,
        &[&["a\n\"b\tc\\d\x1b\\q\\"]],
    );
    check(
        r#"LC_ALL=C.UTF-8; x='\x41\101é\U0001F600\x\u\U\cA\c?\c'; args "${x@E}""#,
        &[&["AAé😀\\x\\u\\U\x01\x7f\\c"]],
    );
    check(
        r#"x='a\0b'; y='a\x00b'; v="a\n\"b"; args "${x@E}" "${y@E}" "${v@E}""#,
        &[&["a", "a", "a\n\"b"]],
    );
    check(
        r#"target='hello\tworld\n'; declare -n ref=target; args "E: ${ref@E}""#,
        &[&["E: hello\tworld\n"]],
    );
}

#[test]
fn transformation_changes_case() {
    check(
        r#"LC_ALL=C.UTF-8; x='hElLo wOrLd'; y=éa; e=; args "${x@u}" "${x@U}" "${x@L}" "${y@u}" "${y@U}" "${e@U}" "${undef@u}""#,
        &[&[
            "HElLo wOrLd",
            "HELLO WORLD",
            "hello world",
            "Éa",
            "ÉA",
            "",
            "",
        ]],
    );
}

#[test]
fn transformation_results_split_and_feed_other_expansions() {
    check(
        r#"x='a b*'; args ${x@Q}; args ${undef@Q}; args "${undef@Q}""#,
        &[&["'a", "b*'"], &[], &[""]],
    );
    check(
        r#"x='a b'; y=${x@Q}; z="${x@Q}"; args "$y" "$z""#,
        &[&["'a b'", "'a b'"]],
    );
}

#[test]
fn transformation_nounset_reports_before_the_operator() {
    for operator in ['Q', 'E', 'u', 'A', 'a', 'P', 'Z'] {
        let rig = Rig::new(Limits::default());
        let source = format!(r#"set -u; (args ${{undef@{operator}}}); args "$?""#);
        assert_eq!(rig.run(&source), 0, "{source}");
        assert_eq!(*rig.calls.borrow(), &[&["1"]], "{source}");
        assert!(
            String::from_utf8_lossy(&rig.errors.bytes()).contains("undef: unbound variable"),
            "{source}"
        );
    }
}

#[test]
fn transformation_invalid_operators_on_unset_names_expand_to_nothing() {
    check(r#"args "${undef@Z}x""#, &[&["x"]]);
}

#[test]
fn transformation_unsupported_forms_fail_closed() {
    for (setup, form) in [
        ("x=a", "${x@Z}"),
        ("x='\\777'", "${x@E}"),
        ("x='\\uD800'", "${x@E}"),
        ("LC_ALL=C; x='\\u00e9'", "${x@E}"),
        ("LC_ALL=C.UTF-8; x=μ", "${x@U}"),
        ("p=x; x=a", "${!p@Q}"),
    ] {
        let rig = Rig::new(Limits::default());
        let source = format!("{setup}; args {form}");
        assert_eq!(rig.run(&source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
}

#[test]
fn transformation_locale_namerefs_fail_closed() {
    // Bash fixes the locale when a locale variable is assigned, so reading a
    // nameref's target at expansion time can disagree in either direction.
    for source in [
        r#"loc=C; declare -n LC_ALL=loc; x=é; args "${x@U}""#,
        r#"declare -n LC_ALL=loc; loc=C; x=é; args "${x@U}""#,
        r#"declare -n LC_ALL=loc; LC_ALL=C; x=é; args "${x@U}""#,
        r#"declare -n LC_ALL=loc; loc=C; x=$'é\n'; args "${x@Q}""#,
        r#"declare -n LC_CTYPE=loc; loc=C; x=é; args "${x@A}""#,
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("LANG", "C.UTF-8");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
}

#[test]
fn transformation_array_backed_parameters_fail_closed() {
    let failures: Vec<&str> = [
        (r#"false | true; args "${PIPESTATUS@Q}""#, 2),
        (r#"false | true; args "${PIPESTATUS@A}""#, 2),
        (r#"false | true; args "${PIPESTATUS@a}""#, 2),
        (r#"a=(one two); args "${a@A}""#, 2),
        (r#"a=(one two); args "${a@a}""#, 2),
        (r#"a=(one two); args "${a@Q}""#, 2),
        (r#"a=(one two); declare -n r=a; args "${r@A}""#, 2),
        (r#"a=(one two); declare -n r=a; args "${r@a}""#, 2),
        (r#"a=(); args "${a@A}""#, 2),
        (r#"a=(); declare -n r=a; args "${r@a}""#, 2),
        (r#"a[4]=four; args "${a@A}""#, 2),
        (r#"a[4]=four; declare -n r=a; args "${r@a}""#, 2),
        (r#"f() { local a; a=(one two); args "${a@A}"; }; f"#, 2),
        (
            r#"f() { local a; a=(); declare -n r=a; args "${r@a}"; }; f"#,
            2,
        ),
        (r#"set -u; a=(one two); args "${a@A}""#, 2),
        (r#"set -u; a=(); args "${a@A}""#, 127),
        (r#"set -u; a[4]=four; declare -n r=a; args "${r@a}""#, 127),
    ]
    .into_iter()
    .filter_map(|(source, status)| {
        let rig = Rig::new(Limits::default());
        let actual = rig.run(source);
        if status == 127 {
            assert!(String::from_utf8_lossy(&rig.errors.bytes()).contains("unbound variable"));
        }
        (actual != status || !rig.calls.borrow().is_empty()).then_some(source)
    })
    .collect();
    assert!(failures.is_empty(), "{failures:?}");
    check(
        r#"a=(global); f() { local a=scalar; args "${a@A}" "${a@a}"; }; f"#,
        &[&["declare a='scalar'", ""]],
    );
}

#[test]
fn transformation_prompt_decodes_then_expands_without_shell_quote_removal() {
    check(
        r#"x=value; p='"$x" a'"'"'b \[n\] $((1+2))'; args "${p@P}"; shopt -u promptvars; args "${p@P}""#,
        &[&["\"value\" a'b n 3"], &["\"$x\" a'b n $((1+2))"]],
    );
    check(
        r#"p='done'; a='${p@P}'; b='${a@P}'; args "${b@P}"; p='\000A\1004\555\0455'; args "${p@P}""#,
        &[&["done"], &["A@4m%5"]],
    );
    check(r#"p='${v@Q}'; v="a'b"; args "${p@P}""#, &[&[r"'a'\''b'"]]);
    check(
        r#"x=a; args "${w:-${x@Q}}" "${x#${x@Q}}""#,
        &[&["'a'", "a"]],
    );
}

#[test]
fn transformation_prompt_recursive_values_are_bounded() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"p='${p@P}'; args "${p@P}""#), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn transformation_prompt_uses_available_identity_and_rejects_unknown_facts() {
    check(
        r#"USER='prompt-user'; HOSTNAME='prompt.host.test'; p='\u@\h|\H'; args "${p@P}""#,
        &[&["prompt-user@prompt|prompt.host.test"]],
    );
    check(
        r#"p='\303\251\360\237\231\202'; args "${p@P}""#,
        &[&["é🙂"]],
    );
    for code in [
        "u", "h", "H", "$", "d", "t", "j", "#", "v", "D{%Y}", "D{}", "777",
    ] {
        let rig = Rig::new(Limits::default());
        let source = format!(r#"p='\{code}'; args "${{p@P}}""#);
        assert_eq!(rig.run(&source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
}

#[test]
fn transformation_prompt_output_and_scanning_obey_limits_and_cancellation() {
    let rig = Rig::new(Limits {
        expansion_bytes: 32,
        ..Limits::default()
    });
    rig.variable("p", &"a".repeat(40));
    assert_eq!(rig.run(r#"args "${p@P}""#), 2);
    assert!(rig.calls.borrow().is_empty());
    let rig = Rig::new(Limits::default());
    rig.variable("p", &"a".repeat(100_000));
    let job = rig
        .shell
        .start(r#"f() { local v=inner; args "${p@P}"; }; f arg"#)
        .unwrap();
    rig.drive_until_value(200, "v", "inner");
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(4);
    assert!(peer.is_finished());
    rig.interrupt_without_calls(job);
    assert_eq!(rig.value("v"), None);
}
