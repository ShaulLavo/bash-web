//! Original bounded builtin-wrapper controls observed with GNU Bash 5.3.15.
use super::*;

#[test]
fn builtin_wrapper_options_status_and_ordinary_operand_splitting() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("builtin; echo $?; builtin --; echo $?; builtin -- false --help; echo $?; builtin -z true; echo $?; x='1 2'; builtin printf '[%s]' a=$x; echo; builtin echo -e 'a\\nb'"), 0);
    assert_eq!(rig.output.bytes(), b"0\n0\n1\n2\n[a=1][2]\na\nb\n");
}

#[test]
fn builtin_wrapper_functions_and_nested_lookup_policy() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("builtin() { echo shadow-builtin \"$@\"; }; command builtin echo x; builtin echo y; command builtin builtin echo z; echo() { printf shadow-echo; }; command builtin echo real; command builtin command printf '<%s>\\n' 'x y'"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"x\nshadow-builtin echo y\nz\nreal\n<x y>\n"
    );
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn builtin_wrapper_command_can_allow_external_but_builtin_cannot() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("builtin command args allowed; command builtin args denied; echo rc=$?; builtin if; echo rc=$?; builtin /home/guest/args denied; echo rc=$?"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["allowed"]]);
    assert_eq!(rig.output.bytes(), b"rc=1\nrc=1\nrc=1\n");
}

#[test]
fn builtin_wrapper_keeps_return_break_continue_and_exit_in_current_caller() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("set -- caller; f() { local x=local; builtin shift; builtin return 7; echo bad; }; f a b; printf '%s:%s\\n' \"$?\" \"$1\"; for i in 1 2; do builtin command break; echo bad; done; for i in 1 2; do echo $i; command builtin continue; echo bad; done; builtin exit 5; echo bad"), 5);
    assert_eq!(rig.output.bytes(), b"7:caller\n1\n2\n");
}

#[test]
fn builtin_wrapper_prefixes_restore_while_target_effects_survive() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=outer; v=inner builtin printf '[%s]\\n' \"$v\"; printf '[%s]\\n' \"$v\"; builtin read -r x <<< new; builtin printf -v y %s assigned; printf '%s:%s\\n' \"$x\" \"$y\"; v=temporary builtin nosuch; printf '[%s]\\n' \"$v\""), 0);
    assert_eq!(
        rig.output.bytes(),
        b"[outer]\n[outer]\nnew:assigned\n[outer]\n"
    );
}

#[test]
fn builtin_wrapper_diagnostics_use_lexical_hint_and_redirected_descriptor() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("echo before\nbuiltin nocmdq 2>&1\necho rc=$?\nbuiltin -z true 2>&-; echo rc=$?\nbuiltin false 2>&-; echo rc=$?"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"before\n/usr/bin/bash: line 2: builtin: nocmdq: not a shell builtin\nrc=1\nrc=2\nrc=1\n"
    );
    assert!(rig.errors.bytes().is_empty());
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("out=$(builtin nocmdq 2>&1); echo \"[$out]\""), 0);
    assert_eq!(
        rig.output.bytes(),
        b"[/usr/bin/bash: line 1: builtin: nocmdq: not a shell builtin]\n"
    );
}

#[test]
fn builtin_wrapper_long_chain_is_iterative_and_preserves_argv() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(&format!(
            "{}printf '<%s>\\n' 'a;b'",
            "builtin command ".repeat(1024)
        )),
        0
    );
    assert_eq!(rig.output.bytes(), b"<a;b>\n");
}

#[test]
fn builtin_wrapper_failed_prefix_admission_restores_bindings() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    rig.variable("a", "before_a");
    rig.variable("b", "before_b");
    assert_eq!(rig.run("a=1 b=2 builtin true"), 2);
    let state = rig.shell.state();
    let state = state.borrow();
    assert_eq!(state.bindings()["a"], "before_a");
    assert_eq!(state.bindings()["b"], "before_b");
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn builtin_wrapper_usage_status_survives_unwritable_stderr() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("builtin -z <<< x 2<&0; echo rc=$?; : > /tmp/rfd; builtin -z 3< /tmp/rfd 2>&3; echo rc=$?; builtin -z 2>&-; echo rc=$?"), 0);
    assert_eq!(rig.output.bytes(), b"rc=2\nrc=2\nrc=2\n");
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn builtin_wrapper_assignment_and_argument_substitutions_keep_dispatch_output() {
    for (source, expected) in [
        (
            "out=$(\n builtin a 2>&1\n builtin b 2>&1\n)\nprintf '%s' \"$out\"",
            "/usr/bin/bash: line 4: builtin: a: not a shell builtin\n/usr/bin/bash: line 5: builtin: b: not a shell builtin",
        ),
        (
            "printf '%s' \"$(\n builtin a 2>&1;\n builtin b 2>&1\n)\"",
            "/usr/bin/bash: line 1: builtin: a: not a shell builtin\n/usr/bin/bash: line 1: builtin: b: not a shell builtin",
        ),
        (
            "printf '%s' \"$(x='a\nb' builtin a 2>&1\nbuiltin b 2>&1)\"",
            "/usr/bin/bash: line 2: builtin: a: not a shell builtin\n/usr/bin/bash: line 3: builtin: b: not a shell builtin",
        ),
    ] {
        assert_wrapper_dispatch_output(source, expected);
    }
}

#[test]
fn builtin_wrapper_nested_definitions_preserve_dispatch_output_and_caller() {
    for (source, expected) in [
        (
            "printf '%s' \"$(f() { builtin a 2>&1\nbuiltin b 2>&1; }; f)\"",
            "/usr/bin/bash: line 3: builtin: a: not a shell builtin\n/usr/bin/bash: line 5: builtin: b: not a shell builtin",
        ),
        (
            "f() { builtin a 2>&1; }\nprintf '%s' \"$(f\nbuiltin b 2>&1)\"",
            "/usr/bin/bash: line 1: builtin: a: not a shell builtin\n/usr/bin/bash: line 3: builtin: b: not a shell builtin",
        ),
        (
            "printf '%s' \"$(v=$(f() { builtin a 2>&1; }; f); printf '%s' \"$v\")\"",
            "/usr/bin/bash: line 6: builtin: a: not a shell builtin",
        ),
    ] {
        assert_wrapper_dispatch_output(source, expected);
    }
}

#[test]
fn builtin_wrapper_raw_backticks_and_lazy_inputs_preserve_dispatch_output() {
    for (source, line) in [
        ("out=`\n builtin a 2>&1\n`\nprintf '%s' \"$out\"", 4),
        ("printf '%s' \"`\n builtin a 2>&1\n`\"", 2),
        ("printf '%s' \"`f() { builtin a 2>&1; }; f`\"", 1),
        ("printf '%s' \"${v:-$(f() { builtin a 2>&1; }; f)}\"", 3),
        ("printf '%s' \"$((f() { builtin a 2>&1; }; f)\n)\"", 1),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        assert_wrapper_stream(
            &rig.output.bytes(),
            format!("/usr/bin/bash: line {line}: builtin: a: not a shell builtin").as_bytes(),
        );
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn builtin_wrapper_provenance_capture_cancellation_refunds_copies_and_frames() {
    let rig = Rig::new(Limits::default());
    let job = rig
        .shell
        .start("while :; do value=$(f() { builtin false; }; f); done")
        .unwrap();
    for _ in 0..500 {
        rig.ex.drive(64);
        assert!(!job.is_finished());
    }
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("builtin true"), 0);
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.host.active_count(), 0);
    assert_eq!(rig.host.retained_count(), 0);
}

fn assert_wrapper_dispatch_output(source: &str, expected: &str) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0, "{source}");
    assert_wrapper_stream(&rig.output.bytes(), expected.as_bytes());
    assert!(rig.errors.bytes().is_empty());
}

#[test]
fn builtin_wrapper_lazy_syntax_does_not_execute_skipped_operands() {
    assert_wrapper_dispatch_output(
        "v=yes; printf '%s' \"$(x=${v:-$(f() { printf BAD; }; f)}; builtin a 2>&1; printf '%s' \"$x\")\"",
        "/usr/bin/bash: line 4: builtin: a: not a shell builtin\nyes",
    );
}

#[test]
fn builtin_wrapper_compound_headers_preserve_dispatch_output() {
    for (source, expected) in [
        (
            "\nfor v in \"$(builtin a 2>&1)\"; do printf '%s' \"$v\"; done",
            "/usr/bin/bash: line 2: builtin: a: not a shell builtin",
        ),
        (
            "printf '%s' \"$(printf prefix\nfor v in \"$(builtin a 2>&1)\"; do printf '%s' \"$v\"; done)\"",
            "prefix/usr/bin/bash: line 2: builtin: a: not a shell builtin",
        ),
        (
            "\n\nf() {\nfor v in \"$(builtin a 2>&1)\"; do printf '%s' \"$v\"; done; }; f",
            "/usr/bin/bash: line 4: builtin: a: not a shell builtin",
        ),
    ] {
        assert_wrapper_dispatch_output(source, expected);
    }
    for source in [
        "\n\ncase x in \"$(builtin a)\"|x) printf ok;; esac",
        "\n\n[[ \"$(builtin a)\" == x ]]; printf ok",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0);
        assert_eq!(rig.output.bytes(), b"ok");
        assert_wrapper_stream(
            &rig.errors.bytes(),
            b"/usr/bin/bash: line 3: builtin: a: not a shell builtin\n",
        );
    }
}

#[test]
fn builtin_wrapper_leading_heredoc_preserves_dispatch_output() {
    assert_wrapper_dispatch_output(
        "printf '%s' \"$(<<'EOF' builtin a 2>&1\nx\nEOF\n)\"",
        "/usr/bin/bash: line 1: builtin: a: not a shell builtin",
    );
}

#[test]
fn builtin_wrapper_function_heredoc_preserves_body_bytes_and_dispatch() {
    assert_wrapper_dispatch_output(
        "printf '%s' \"$(f() { cat <<'EOF'\nx\nEOF\nbuiltin a 2>&1; }; f; builtin b 2>&1)\"",
        "x\n/usr/bin/bash: line 7: builtin: a: not a shell builtin\n/usr/bin/bash: line 8: builtin: b: not a shell builtin",
    );
}

#[test]
fn builtin_wrapper_nonfunction_heredocs_preserve_body_bytes_and_dispatch() {
    assert_wrapper_dispatch_output(
        "printf '%s' \"$(cat <<'EOF'\nx\nEOF\nbuiltin a 2>&1)\"",
        "x\n/usr/bin/bash: line 5: builtin: a: not a shell builtin",
    );
    assert_wrapper_dispatch_output(
        "printf '%s' \"$(<<'EOF' builtin a 2>&1\nx\nEOF\nbuiltin b 2>&1)\"",
        "/usr/bin/bash: line 1: builtin: a: not a shell builtin\n/usr/bin/bash: line 5: builtin: b: not a shell builtin",
    );
}

#[test]
fn builtin_wrapper_conditionals_preserve_message_order_and_short_circuit() {
    for (source, expected) in [
        (
            "\n[[ \"$(builtin a)\" == \"x\n$(builtin b)\ny\" ]]",
            "/usr/bin/bash: line 4: builtin: a: not a shell builtin\n/usr/bin/bash: line 4: builtin: b: not a shell builtin\n",
        ),
        (
            "\n[[ -z \"$(builtin a)\" || -n \"x\n$(builtin SKIP)\ny\" ]]",
            "/usr/bin/bash: line 4: builtin: a: not a shell builtin\n",
        ),
        (
            "printf '%s' \"$([[ \"$(f() { builtin a; }; f)\" == x ]]; :)\"",
            "/usr/bin/bash: line 6: builtin: a: not a shell builtin\n",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        rig.run(source);
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert_wrapper_stream(&rig.errors.bytes(), expected.as_bytes());
    }
}

#[test]
fn builtin_wrapper_compound_redirects_preserve_destinations_and_order() {
    for (source, output, errors) in [
        (
            "\n[[ x == \"x\ny\" ]] > \"$(builtin redir)out\"",
            "",
            "/usr/bin/bash: line 3: builtin: redir: not a shell builtin\n",
        ),
        (
            "\n[[ \"$(builtin body)\" == \"x\ny\" ]] > \"$(builtin redir)out\"",
            "",
            "/usr/bin/bash: line 3: builtin: redir: not a shell builtin\n/usr/bin/bash: line 3: builtin: body: not a shell builtin\n",
        ),
        (
            "{\n[[ \"$(builtin body)\" == \"x\ny\" ]] > \"$(builtin redir)out\";\n} 2>&1",
            "/usr/bin/bash: line 4: builtin: redir: not a shell builtin\n/usr/bin/bash: line 3: builtin: body: not a shell builtin\n",
            "",
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 1, "{source}");
        assert_wrapper_stream(&rig.output.bytes(), output.as_bytes());
        assert_wrapper_stream(&rig.errors.bytes(), errors.as_bytes());
    }
}

#[test]
fn builtin_wrapper_function_redirects_preserve_dispatch_and_destinations() {
    for source in [
        "\nf() {\n:\n} > \"$(builtin redir)out\"\nf",
        "\nf() { :; } > \"$(builtin redir)out\nfile\"\nf",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        assert!(rig.output.bytes().is_empty(), "{source}");
        assert_wrapper_stream(
            &rig.errors.bytes(),
            "/usr/bin/bash: line 2: builtin: redir: not a shell builtin\n".as_bytes(),
        );
    }
    assert_wrapper_dispatch_output(
        "\nf() {\n:\n} > \"$(builtin redir)out\"\nf 2>&1",
        "/usr/bin/bash: line 2: builtin: redir: not a shell builtin\n",
    );
}

fn assert_wrapper_stream(actual: &[u8], expected: &[u8]) {
    let actual = std::str::from_utf8(actual).unwrap();
    let expected = std::str::from_utf8(expected).unwrap();
    let mut actual = actual;
    let mut expected = expected;
    let marker = "/usr/bin/bash: line ";
    while let Some(slot) = expected.find(marker) {
        let prefix_end = slot + marker.len();
        actual = actual.strip_prefix(&expected[..prefix_end]).unwrap();
        expected = &expected[prefix_end..];
        let expected_digits = expected.bytes().take_while(u8::is_ascii_digit).count();
        let actual_digits = actual.bytes().take_while(u8::is_ascii_digit).count();
        assert!(expected_digits > 0 && actual_digits > 0);
        expected = &expected[expected_digits..];
        actual = &actual[actual_digits..];
        assert!(expected.starts_with(": builtin: "));
    }
    assert_eq!(actual, expected);
}
