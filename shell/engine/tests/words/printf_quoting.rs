use super::{Limits, Rig, printf};

#[test]
fn printf_quoting_escapes_shell_syntax_and_reuses_missing_operands() {
    printf::check_bytes(
        r#"printf '[%q]' '' 'a b' "it's" 'a,b' '~' 'a~' 'a:~' 'a=~' '#a' 'a#'; printf '[%q][%Q]'"#,
        br"[''][a\ b][it\'s][a\,b][\~][a~][a:\~][a=\~][\#a][a#]['']['']",
    );
}

#[test]
fn printf_quoting_precision_applies_after_q_but_before_uppercase_q() {
    printf::check_bytes(
        r"printf '[%12q][%-6q][%.5q][%.5Q][%.0q][%.0Q]' 'foo bar' x 'foo bar' 'foo bar' x x",
        br"[    foo\ bar][x     ][foo\ ][foo\ b][]['']",
    );
    printf::check_bytes(
        r"printf '[%*.*q][%*.*Q]' -10 5 'foo bar' 10 5 'foo bar'",
        br"[foo\      ][    foo\ b]",
    );
}

#[test]
fn printf_quoting_ansi_controls_and_alternate_single_quotes() {
    printf::check_bytes(
        r#"printf '[%q][%#q][%#q][%#Q]' $'a\n\t\e\001\177' "x'y" foo $'a\nb'"#,
        br"[$'a\n\t\E\001\177']['x'\''y']['foo'][$'a\nb']",
    );
}

#[test]
fn printf_quoting_uses_existing_character_locale_and_byte_precision() {
    for (locale, expected) in [
        ("C", &br"[$'\303\251\344\270\255'][$'\303'][   $'\30]"[..]),
        (
            "C.UTF-8",
            &b"[\xc3\xa9\xe4\xb8\xad][$'\\303'][   \xc3\xa9\xe4\xb8\xad]"[..],
        ),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", locale);
        assert_eq!(rig.run("printf '[%q][%.1Q][%8.5q]' é中 é é中"), 0);
        assert_eq!(rig.output.bytes(), expected, "{locale}");
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_quoting_flags_star_diagnostics_and_stop_preserve_order() {
    printf::check_bytes(r"printf '[%--++## 00012q]' 'foo bar'", b"['foo bar'   ]");
    printf::check_bytes(
        r#"printf "[%05q][%05Q][%'q]" 'a b' x 'a b'"#,
        br"[ a\ b][    x][a\ b]",
    );
    for redirect in ["", " 2>&-", " 2>&1"] {
        let rig = Rig::new(Limits::default());
        let source = format!(r"printf 'prefix[%*.*q]%bBAD' 7x 5x 'foo bar' '\c'{redirect}");
        assert_eq!(rig.run(&source), 0);
        let output = rig.output.bytes();
        assert!(output.ends_with(br"prefix[  foo\ ]"));
        if redirect == " 2>&1" {
            assert!(output.starts_with(b"/usr/bin/bash: printf: 7x: invalid number\n"));
        }
    }
}

#[test]
fn printf_quoting_literal_count_overflow_warns_but_keeps_format_reuse() {
    for (source, expected) in [
        (
            "printf '[%2147483648q][%s]' 'a b' done",
            &br"[a\ b][done]"[..],
        ),
        ("printf '[%.2147483648q][%s]' 'a b' done", &b"[][done]"[..]),
        (
            "printf '[%.2147483648Q][%s]' 'a b' done",
            &br"[a\ b][done]"[..],
        ),
        ("printf '[%*.2147483648Q]' 7x 'a b'", &br"[   a\ b]"[..]),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1, "{source}");
        assert_eq!(rig.output.bytes(), expected);
        assert!(
            rig.errors
                .bytes()
                .ends_with(b"2147483648: Numerical result out of range\n")
        );
    }
}

#[test]
fn printf_quoting_controls_choose_ansi_for_the_whole_word() {
    for (character, escape) in [
        (1, "\\001"),
        (7, "\\a"),
        (8, "\\b"),
        (9, "\\t"),
        (10, "\\n"),
        (11, "\\v"),
        (12, "\\f"),
        (13, "\\r"),
        (27, "\\E"),
        (31, "\\037"),
        (127, "\\177"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("value", &format!("a'\\\"{}z", char::from(character)));
        assert_eq!(rig.run("printf '%q' \"$value\""), 0);
        assert_eq!(
            rig.output.bytes(),
            format!("$'a\\'\\\\\"{escape}z'").as_bytes()
        );
    }
}

#[test]
fn printf_quoting_unicode_classification_is_local_and_preserves_printable_sequences() {
    let rig = Rig::new(Limits::default());
    rig.variable("LC_ALL", "C.UTF-8");
    rig.variable(
        "value",
        "é\u{80}\u{a0}\u{ad}\u{200b}\u{2028}\u{feff}\u{ffff}",
    );
    assert_eq!(rig.run("printf '%q' \"$value\""), 0);
    assert_eq!(
        rig.output.bytes(),
        "$'é\\302\\200\u{a0}\u{ad}\u{200b}\\342\\200\\250\u{feff}\\357\\277\\277'".as_bytes()
    );
    assert_eq!(rig.run("LC_ALL=C; printf '|%q' é"), 0);
    assert!(rig.output.bytes().ends_with(br"|$'\303\251'"));
}

#[test]
fn printf_quoting_growth_is_admitted_before_any_output() {
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    rig.variable("value", &"\u{1}".repeat(300));
    printf::assert_recovery(&rig, "printf 'prefix%q' \"$value\"", 2);
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    printf::assert_recovery(&rig, "printf 'prefix%1000000000Q' x", 2);
}

#[test]
fn printf_quoting_precision_does_not_charge_hidden_expanded_output() {
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    rig.variable("value", &"\u{1}".repeat(300));
    assert_eq!(rig.run("printf '[%.5q][%.2Q]' \"$value\" \"$value\""), 0);
    assert_eq!(rig.output.bytes(), br"[$'\00][$'\001\001']");
}

#[test]
fn printf_quoting_partial_writes_reassemble_chunked_output() {
    let rig = Rig::new(Limits::default());
    rig.variable("value", &" ".repeat(5000));
    let (endpoint, records) = printf::recorded_endpoint_with_limit(3);
    printf::replace_output(&rig, endpoint);
    assert_eq!(rig.run("printf '%q' \"$value\""), 0);
    assert!(records.borrow().iter().all(|bytes| bytes.len() <= 3));
    assert_eq!(records.borrow().concat(), br"\ ".repeat(5000));
}

#[test]
fn printf_quoting_admission_cancellation_is_silent() {
    let rig = Rig::new(Limits::default());
    rig.variable("value", &"\u{1}".repeat(150_000));
    let job = rig
        .shell
        .start("started=yes; printf 'prefix%q' \"$value\"; echo bad")
        .unwrap();
    rig.drive_until_variable("started", "yes");
    for _ in 0..50 {
        rig.ex.drive(1);
    }
    printf::interrupt_empty(&rig, job);
}

#[test]
fn printf_quoting_delivery_cancellation_keeps_only_written_escapes() {
    use futures::FutureExt;
    use shell_engine::io::pipe;
    let rig = Rig::new(Limits::default());
    rig.variable("value", &" ".repeat(100_000));
    let (reader, writer) = pipe();
    printf::replace_output(&rig, writer);
    let job = rig.shell.start("printf '%q' \"$value\"; echo bad").unwrap();
    assert_eq!(printf::read_first_byte(&rig, &reader), b'\\');
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    let mut bytes = vec![0; shell_engine::io::PIPE_CAPACITY];
    let Some(Ok(length)) = reader.read(&mut bytes).now_or_never() else {
        panic!("expected written quoting bytes");
    };
    assert_eq!(
        &bytes[..length],
        &br" \".repeat(length.div_ceil(2))[..length]
    );
    assert!(reader.read(&mut [0]).now_or_never().is_none());
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn printf_quoting_closed_outputs_and_diagnostic_backpressure_keep_status() {
    for source in ["printf '%q' 'a b' 1>&-", "printf '%q' 'a b' 1>&- 2>&-"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1);
        assert!(rig.output.bytes().is_empty());
    }
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%*q]%bBAD' 7x 'a b' '\c'", 2);
}
