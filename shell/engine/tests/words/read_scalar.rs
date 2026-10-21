//! Adapted scalar field controls with original byte and resource boundaries.
use super::*;

#[test]
fn scalar_fields_and_remainder() {
    check_output(
        r#"read a b c <<<'  a b  c  d  '; printf '[%s][%s][%s]\n' "$a" "$b" "$c""#,
        "[a][b][c  d]\n",
    );
    check_output(
        r#"IFS=: read a b <<<'x::y'; printf '[%s][%s]\n' "$a" "$b""#,
        "[x][:y]\n",
    );
    check_output(
        r#"IFS=': ' read a b <<<'x: y : z : w '; printf '[%s][%s]\n' "$a" "$b""#,
        "[x][y : z : w]\n",
    );
    check_output(
        r#"IFS= read a b <<<'  a b '; printf '[%s][%s]\n' "$a" "$b""#,
        "[  a b ][]\n",
    );
    check_output(
        r#"c=old; read a b c <<<a; printf '[%s][%s][%s]\n' "$a" "$b" "$c""#,
        "[a][][]\n",
    );
}

#[test]
fn scalar_escapes_reply_and_eof() {
    check_output(
        r#"read a b <<<'a\ b c\ '; printf '[%s][%s]\n' "$a" "$b""#,
        "[a b][c ]\n",
    );
    check_output(r#"read a <<<'a\ b c\ '; printf '[%s]\n' "$a""#, "[a b c]\n");
    check_output(
        "read <<'EOF'\n  a\\\n b  \nEOF\nprintf '[%s]\n' \"$REPLY\"",
        "[  a b  ]\n",
    );
    check_output(
        r#"printf 'ab\\' | { read a b; printf '%s:[%s][%s]\n' "$?" "$a" "$b"; }"#,
        "1:[ab][]\n",
    );
    check_output(
        r#"printf 'a\0b c' | { read a b; printf '%s:[%s][%s]\n' "$?" "$a" "$b"; }"#,
        "1:[ab][c]\n",
    );
}

#[test]
fn scalar_bad_name_keeps_prior_writes() {
    check_output(
        r#"b=old; read a 1x b <<<'x y z'; printf '%s:[%s][%s]\n' "$?" "$a" "$b""#,
        "1:[x][old]\n",
    );
    check_output(
        r#"read a -r <<<'x y'; printf '%s:[%s]\n' "$?" "$a""#,
        "1:[x]\n",
    );
}

#[test]
fn counted_fields_keep_boundary_and_protection() {
    check_output(
        r#"{ read -n5 a b; printf '%s:[%s][%s]\n' "$?" "$a" "$b"; read -r tail; printf '[%s]\n' "$tail"; } <<<'x y zrest'"#,
        "0:[x][y z]\n[rest]\n",
    );
    check_output(
        r#"read -n4 a b <<<'a\ b c'; printf '[%s][%s]\n' "$a" "$b""#,
        "[a b][]\n",
    );
    check_output(
        r#"LC_ALL=C.UTF-8; read -n4 a b <<<'é 中z!'; printf '[%s][%s]\n' "$a" "$b""#,
        "[é][中z]\n",
    );
}

#[test]
fn scalar_line_bound_preserves_bindings() {
    let rig = Rig::new(Limits {
        line_bytes: 4,
        ..Limits::default()
    });
    assert_eq!(rig.run("a=old; b=saved; read a b <<<abcde"), 2);
    assert_eq!(rig.run(r#"printf '[%s][%s]\n' "$a" "$b""#), 0);
    assert_eq!(rig.output.bytes(), b"[old][saved]\n");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn scalar_multibyte_ifs_membership() {
    check_output(
        r#"IFS='é¢'; read a b <<<'âz'; printf '[%s][%s]\n' "$a" "$b""#,
        "[âz][]\n",
    );
    check_output(
        r#"IFS='é¢'; read IFS a b <<<'xéâz¢q'; printf '[%s][%s][%s]\n' "$IFS" "$a" "$b""#,
        "[x][âz][q]\n",
    );
    check_output(
        r#"IFS='é¢'; read -r a b <<<'a\éâ¢b'; printf '[%s][%s]\n' "$a" "$b""#,
        "[a\\][â¢b]\n",
    );
    check_output(
        r#"IFS='é¢'; read a b <<<'a\éâ¢b'; printf '[%s][%s]\n' "$a" "$b""#,
        "[aéâ][b]\n",
    );
}

#[test]
fn scalar_readonly_destination_status() {
    for options in ["", "-r", "-n4", "-rn4", "-n0"] {
        for (readonly, line, empty) in [
            ("a", "2:[oldA][oldB][oldC]", "2:[oldA][oldB][oldC]"),
            ("b", "2:[x][oldB][oldC]", "2:[][oldB][oldC]"),
            ("c", "1:[x][y][oldC]", "1:[][][oldC]"),
        ] {
            let expected = if options == "-n0" { empty } else { line };
            check_output(
                &format!(
                    r#"a=oldA; b=oldB; c=oldC; readonly {readonly}; read {options} a b c <<<'x y z'; r=$?; printf '%s:[%s][%s][%s]\n' "$r" "$a" "$b" "$c""#
                ),
                &format!("{expected}\n"),
            );
        }
    }
    for options in ["", "-r", "-n2", "-n0"] {
        check_output(
            &format!(
                r#"REPLY=old; readonly REPLY; read {options} <<<'xyz'; printf '%s:[%s]\n' "$?" "$REPLY""#
            ),
            "2:[old]\n",
        );
    }
}

#[test]
fn scalar_multibyte_ifs_byte_collisions() {
    for options in ["-r", "-n4", "-rn4"] {
        check_output(
            &format!(
                r#"LC_ALL=C.UTF-8; IFS='éš'; read {options} a <<<'abcá'; printf '%s:[%s]\n' "$?" "$a""#
            ),
            "0:[abcá]\n",
        );
    }
    check_output(
        r#"IFS='éš'; read a b <<<'oneátwo'; printf '[%s][%s]\n' "$a" "$b""#,
        "[oneátwo][]\n",
    );
}
