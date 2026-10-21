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
        ("x=a", "${x@P}"),
        ("x=a", "${x@Z}"),
        ("x='\\777'", "${x@E}"),
        ("x='\\uD800'", "${x@E}"),
        ("LC_ALL=C; x='\\u00e9'", "${x@E}"),
        ("LC_ALL=C.UTF-8; x=μ", "${x@U}"),
        ("p=x; x=a", "${!p@Q}"),
        ("x=a", "${w:-${x@Q}}"),
        ("x=a", "${x#${x@Q}}"),
    ] {
        let rig = Rig::new(Limits::default());
        let source = format!("{setup}; args {form}");
        assert_eq!(rig.run(&source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty(), "{source}");
    }
}
