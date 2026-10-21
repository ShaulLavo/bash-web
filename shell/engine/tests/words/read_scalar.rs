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
