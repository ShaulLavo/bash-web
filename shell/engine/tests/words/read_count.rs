use super::*;
use shell_engine::io::pipe;

fn check(source: &str, expected: &[u8]) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0, "{source}");
    assert_eq!(rig.output.bytes(), expected, "{source}");
}

fn assert_value(rig: &Rig, name: &str, value: &str) {
    assert_eq!(
        rig.shell
            .state()
            .borrow()
            .bindings()
            .get(name)
            .map(|value| value.as_str()),
        Some(value)
    );
}

fn pending_input(rig: &Rig, bytes: &[u8]) -> (Endpoint, Endpoint) {
    let (reader, writer) = pipe();
    assert_eq!(writer.write(bytes).now_or_never(), Some(Ok(bytes.len())));
    let mut fds = FdTable::default();
    fds.insert(0, reader.clone());
    fds.insert(1, Endpoint::null());
    fds.insert(2, Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
    (reader, writer)
}

#[test]
fn read_count_stops_without_consuming_the_next_character_or_newline() {
    check(
        "{ read -n3 x; echo \"[$x]:$?\"; read -r y; echo \"[$y]:$?\"; } <<'EOF'\nabcdef\nEOF",
        b"[abc]:0\n[def]:0\n",
    );
    check(
        "{ read -n3 x; echo \"[$x]:$?\"; read y; echo \"[$y]:$?\"; } <<'EOF'\nabc\nEOF",
        b"[abc]:0\n[]:0\n",
    );
    check("printf ab | { read -n3 x; echo \"[$x]:$?\"; }", b"[ab]:1\n");
    check("read -n3 x <<<ab; echo \"[$x]:$?\"", b"[ab]:0\n");
}

#[test]
fn read_count_counts_after_escapes_and_skips_nul_and_continuations() {
    check(
        r#"printf 'a\\bcdef' | { read -n3 x; echo "[$x]:$?"; }"#,
        b"[abc]:0\n",
    );
    check(
        "printf 'ab\\\\\\nc' | { read -n3 x; echo \"[$x]:$?\"; }",
        b"[abc]:0\n",
    );
    check(
        "printf 'a\\0bc' | { read -n3 x; echo \"[$x]:$?\"; }",
        b"[abc]:0\n",
    );
    check(
        "printf 'ab\\\\' | { read -n5 x; echo \"[$x]:$?\"; }",
        b"[ab]:1\n",
    );
    check(
        "printf 'a\\\\bc' | { read -rn3 x; echo \"[$x]:$?\"; }",
        b"[a\\b]:0\n",
    );
}

#[test]
fn read_count_utf8_characters_do_not_split_codepoints() {
    check(
        "LC_ALL=C.UTF-8; { read -n2 x; echo \"[$x]:$?\"; read y; echo \"[$y]:$?\"; } <<<é中😀",
        "[é中]:0\n[😀]:0\n".as_bytes(),
    );
    check(
        "LC_ALL=C.UTF-8; read -n2 x <<<éz; echo \"[$x]:$?\"",
        "[é]:0\n".as_bytes(),
    );
    check(
        "LC_ALL=C; read -n2 x <<<éz; echo \"[$x]:$?\"",
        "[é]:0\n".as_bytes(),
    );
}

#[test]
fn read_count_options_zero_and_invalid_counts_preserve_input() {
    check(
        "{ x=old; read -n0 x; echo \"[$x]:$?\"; read -r y; echo \"[$y]:$?\"; } <<<hello",
        b"[]:0\n[hello]:0\n",
    );
    check(
        "{ x=old; read -n abc x 2>/dev/null; echo \"[$x]:$?\"; read y; echo \"[$y]:$?\"; } <<<hello",
        b"[old]:1\n[hello]:0\n",
    );
    check("read -n -0 x <<<hello; echo \"[$x]:$?\"", b"[]:0\n");
    check(
        "read -n1 -n03 -u3 x 3<<<hello; echo \"[$x]:$?\"",
        b"[hel]:0\n",
    );
}

#[test]
fn read_count_named_whitespace_and_reply_have_distinct_trimming() {
    check(
        "read -n4 x <<<'  a b  '; echo \"[$x]\"; read -n4 <<<'  a b  '; echo \"[$REPLY]\"",
        b"[a]\n[  a ]\n",
    );
    check("IFS= read -n4 x <<<'  a b  '; echo \"[$x]\"", b"[  a ]\n");
    check(
        "read -n3 x <<'EOF'\n\\ a\\ \nEOF\necho \"[$x]\"",
        b"[ a ]\n",
    );
}

#[test]
fn read_count_line_limit_and_admission_failure_do_not_assign_partial_values() {
    let rig = Rig::new(Limits {
        line_bytes: 4,
        ..Limits::default()
    });
    rig.variable("x", "old");
    assert_eq!(rig.run("read -n5 x <<<abcde"), 2);
    assert_eq!(rig.run("echo \"[$x]\""), 0);
    assert_eq!(rig.output.bytes(), b"[old]\n");
    assert_eq!(rig.run("read -n4 x <<<abcd"), 0);
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn read_count_pending_cancellation_refunds_storage_and_keeps_assignment_atomic() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = pipe();
    let mut fds = FdTable::default();
    fds.insert(0, reader);
    fds.insert(1, capture(128).0);
    fds.insert(2, capture(128).0);
    rig.shell.set_descriptors(fds).unwrap();
    rig.variable("x", "old");
    assert_eq!(writer.write(b"ab").now_or_never(), Some(Ok(2)));
    let job = rig.shell.start("read -n2147483647 x; x=bad").unwrap();
    for _ in 0..200 {
        rig.ex.drive(64);
    }
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_value(&rig, "x", "old");
    assert_eq!(rig.run("true"), 0);
    drop(writer);
}

#[test]
fn read_count_rejects_other_modes_and_unrepresentable_input_without_partial_assignment() {
    let rig = Rig::new(Limits::default());
    rig.variable("x", "old");
    for source in [
        "read -N3 x <<<hello",
        "read -d: -n3 x <<<hello",
        "read -n3 x <&-",
        "LC_ALL=C read -n1 x <<<é",
        "printf '\\xff' | read -n1 x",
        "LC_ALL=C.UTF-8; printf '\\xc3' | read -n1 x",
    ] {
        assert_ne!(rig.run(source), 0, "{source}");
        assert_value(&rig, "x", "old");
        assert_eq!(rig.run("true"), 0);
    }
}

#[test]
fn read_count_storage_admission_and_zero_count_do_not_touch_input() {
    let rig = Rig::new(Limits {
        expansion_bytes: 512,
        ..Limits::default()
    });
    rig.variable("x", "old");
    let (reader, _writer) = pending_input(&rig, b"abcdef");
    assert_eq!(rig.run("read -n2147483647 x"), 2);
    assert_value(&rig, "x", "old");
    assert_eq!(rig.run("read -n0 x"), 0);
    let mut bytes = [0; 6];
    assert_eq!(reader.read(&mut bytes).now_or_never(), Some(Ok(6)));
    assert_eq!(bytes, *b"abcdef");
}

#[test]
fn read_count_pending_after_partial_input_keeps_unread_suffix() {
    let rig = Rig::new(Limits::default());
    let (reader, _writer) = pending_input(&rig, "é中x".as_bytes());
    rig.variable("LC_ALL", "C.UTF-8");
    assert_eq!(rig.run("read -n2 x"), 0);
    assert_value(&rig, "x", "é中");
    let mut byte = [0];
    assert_eq!(reader.read(&mut byte).now_or_never(), Some(Ok(1)));
    assert_eq!(byte, [b'x']);
    assert!(reader.read(&mut byte).now_or_never().is_none());
}

#[test]
fn read_count_short_local_values_do_not_retain_the_reserved_ceiling() {
    let rig = Rig::new(Limits {
        execution_bytes: 131072,
        ..Limits::default()
    });
    let (_reader, _writer) = pending_input(&rig, b"");
    let job = rig.shell.start("f() { local a b c d; read -n99999 a <<<x; read -n99999 b <<<x; read -n99999 c <<<x; read -n99999 d <<<x; read -n1 waiting; }; f").unwrap();
    for _ in 0..10000 {
        rig.ex.drive(64);
    }
    assert!(!job.is_finished());
    let capacities: Vec<_> = ["a", "b", "c", "d"]
        .map(|name| {
            let state = rig.shell.state();
            let state = state.borrow();
            let value = state.bindings().get(name).unwrap();
            (value.len(), value.scalar().unwrap().capacity())
        })
        .into();
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(capacities, vec![(1, 1); 4]);
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn read_count_invalid_scalar_names_leave_all_input_unread() {
    for name in ["1bad", "a-b", "a.b", "", "é"] {
        check(
            &format!(
                "{{ x=old; read -n3 '{name}' 2>/dev/null; echo \"[$x]:$?\"; read -r tail; echo \"[$tail]:$?\"; }} <<<abcdef"
            ),
            b"[old]:1\n[abcdef]:0\n",
        );
    }
    for name in ["a", "a0", "_a_9"] {
        check(
            &format!(
                "{{ read -n3 {name}; echo \"[${name}]:$?\"; read -r tail; echo \"[$tail]:$?\"; }} <<<abcdef"
            ),
            b"[abc]:0\n[def]:0\n",
        );
    }
}

#[test]
fn read_count_underscore_is_replaced_by_last_argument() {
    check(
        r#"{ read -n3 _; echo "[$_]:$?"; read -r tail; echo "[$tail]:$?"; } <<<abcdef"#,
        b"[_]:0\n[def]:0\n",
    );
}

#[test]
fn read_count_decimal_padding_and_numeric_boundaries() {
    for count in [
        "\u{b}3\u{b}",
        " \t\r\n\u{b}\u{c}+03 \t\r\n\u{b}\u{c}",
        "0003",
    ] {
        check(
            &format!(
                "{{ read -n '{count}' x; echo \"[$x]:$?\"; read -r tail; echo \"[$tail]:$?\"; }} <<<abcdef"
            ),
            b"[abc]:0\n[def]:0\n",
        );
    }
    for count in [
        "",
        " ",
        "+",
        "-",
        "-1",
        "3x",
        "3 0",
        "0x3",
        "2147483648",
        "999999999999999999999999",
        "\u{85}3",
        "\u{a0}3",
    ] {
        check(
            &format!(
                "{{ x=old; read -n '{count}' x 2>/dev/null; echo \"[$x]:$?\"; read -r tail; echo \"[$tail]:$?\"; }} <<<abcdef"
            ),
            b"[old]:1\n[abcdef]:0\n",
        );
    }
    check("read -n2147483647 x <<<a; echo \"[$x]:$?\"", b"[a]:0\n");
}

#[test]
fn read_count_signed_zero_descriptor_and_invalid_descriptors() {
    for fd in ["-0", "-00", "+0", "00"] {
        check(
            &format!(
                "{{ read -n3 -u '{fd}' x; echo \"[$x]:$?\"; read -r tail; echo \"[$tail]:$?\"; }} <<<abcdef"
            ),
            b"[abc]:0\n[def]:0\n",
        );
    }
    for fd in [
        "-1",
        "",
        "+",
        "0x0",
        "0.0",
        "4294967296",
        "999999999999999999999",
    ] {
        check(
            &format!(
                "{{ x=old; read -n3 -u '{fd}' x 2>/dev/null; echo \"[$x]:$?\"; read -r tail; echo \"[$tail]:$?\"; }} <<<abcdef"
            ),
            b"[old]:2\n[abcdef]:0\n",
        );
    }
}

#[path = "read_scalar.rs"]
mod scalar;
