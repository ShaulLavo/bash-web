use super::{Limits, Rig, printf};

#[test]
fn printf_assignment_plain_attached_and_repeated_formats() {
    printf::check_bytes("printf -v x '%s|' a b c; echo \"$x\"", b"a|b|c|\n");
    printf::check_bytes("printf -vva value; echo \"$va\"", b"value\n");
    printf::check_bytes(
        "printf -v x -vy -- '%s-' -- a; echo \"${x-unset}:$y\"",
        b"unset:---a-\n",
    );
}

#[test]
fn printf_assignment_dynamic_scope_nameref_and_ifs_use_existing_bindings() {
    printf::check_bytes(
        "x=global; f() { local x=local; g; echo \"$x\"; }; g() { printf -v x %s dynamic; printf -v y %s global; }; f; echo \"$x:$y\"",
        b"dynamic\nglobal:global\n",
    );
    printf::check_bytes(
        "declare -n ref=target; printf -v ref %s saved; echo \"$ref:$target\"",
        b"saved:saved\n",
    );
    printf::check_bytes(
        "printf -v IFS :; set -- 'a:b'; for x in $1; do echo \"<$x>\"; done",
        b"<a>\n<b>\n",
    );
}

#[test]
fn printf_assignment_never_writes_stdout_and_accepts_closed_stdout() {
    let rig = Rig::new(Limits::default());
    let (endpoint, writes) = printf::recorded_endpoint();
    printf::replace_output(&rig, endpoint);
    assert_eq!(rig.run("printf -v x '%8193s' hi"), 0);
    assert!(writes.borrow().is_empty());
    assert_eq!(rig.run("test ${#x} = 8193"), 0);
    printf::check_bytes("printf -v x %s saved 1>&-; echo \"$?:$x\"", b"0:saved\n");
}

#[test]
fn printf_assignment_numeric_errors_and_stop_escape_assign_partial_output() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf -v x 'a%d:%s' 3x tail"), 1);
    assert_eq!(rig.shell.state().borrow().bindings()["x"], "a3:tail");
    assert!(rig.output.bytes().is_empty());
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: 3x: invalid number\n"
    );
    assert_eq!(rig.run(r"printf -v x '[%d]%bBAD' nope 'a\cb'"), 0);
    assert_eq!(rig.shell.state().borrow().bindings()["x"], "[0]a");
}

#[test]
fn printf_assignment_invalid_operands_and_readonly_preserve_existing_bindings() {
    for (source, status) in [
        ("printf -v x", 2),
        ("printf -v 2bad %s changed", 2),
        ("printf -v '' %s changed", 2),
        ("printf -v 'x[0]' %s changed", 2),
        ("printf -v 'x[$(y=changed)]' %s changed", 2),
        ("readonly x; printf -v x %s changed", 1),
        ("readonly x; declare -n ref=x; printf -v ref %s changed", 1),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("x", "original");
        rig.variable("y", "original");
        assert_eq!(rig.run(source), status, "{source}");
        assert_eq!(rig.shell.state().borrow().bindings()["x"], "original");
        assert_eq!(rig.shell.state().borrow().bindings()["y"], "original");
        assert!(rig.output.bytes().is_empty());
    }
}

#[test]
fn printf_assignment_nul_truncates_but_non_utf8_never_becomes_lossy_text() {
    for (source, status, expected) in [
        (r"printf -v x 'a\0b%s' tail", 0, "a"),
        (r"printf -v x '%b' '\0\377'", 0, ""),
        (r"printf -v x '%b' '\377'", 2, "original"),
        ("printf -v x '%.1s' é", 2, "original"),
        ("printf -v x '%s' 'é🙂'", 0, "é🙂"),
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("x", "original");
        assert_eq!(rig.run(source), status, "{source}");
        assert_eq!(rig.shell.state().borrow().bindings()["x"], expected);
        assert!(rig.output.bytes().is_empty());
    }
}

#[test]
fn printf_assignment_output_limit_and_storage_admission_preserve_target() {
    for source in ["printf -v x '%1000000000s' a", "printf -v x '%900s' a b"] {
        let rig = Rig::new(Limits {
            expansion_bytes: 1024,
            ..Limits::default()
        });
        rig.variable("x", "original");
        assert_eq!(rig.run(source), 2);
        assert_eq!(rig.shell.state().borrow().bindings()["x"], "original");
        assert!(rig.output.bytes().is_empty());
        assert!(rig.errors.bytes().is_empty());
    }
}

#[test]
fn printf_assignment_cancellation_before_commit_is_atomic_and_session_recovers() {
    let rig = Rig::new(Limits::default());
    rig.variable("x", "original");
    let job = rig
        .shell
        .start("started=yes; printf -v x '%900000s' a; echo bad")
        .unwrap();
    rig.drive_until_variable("started", "yes");
    for _ in 0..500 {
        rig.ex.drive(1);
    }
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.shell.state().borrow().bindings()["x"], "original");
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("printf -v x %s recovered"), 0);
    assert_eq!(rig.shell.state().borrow().bindings()["x"], "recovered");
}

#[test]
fn printf_assignment_unsupported_conversion_keeps_the_existing_formatter_boundary() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("printf -v x 'prefix%f' 3"), 2);
    assert_eq!(rig.shell.state().borrow().bindings()["x"], "prefix");
    assert_eq!(
        rig.errors.bytes(),
        b"/usr/bin/bash: printf: unsupported format conversion\n"
    );
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn printf_assignment_cancelled_diagnostic_delivery_does_not_commit_output() {
    printf::assert_diagnostic_backpressure_cancellation("printf -v x '%8193s%d' hi nope", 2);
}

#[test]
fn printf_assignment_nul_truncated_locals_keep_only_their_stored_capacity() {
    let rig = Rig::new(Limits {
        execution_bytes: 131072,
        ..Limits::default()
    });
    let job = rig.shell.start(r"f() { local a b; printf -v a 'x\0%8193s'; printf -v b '\0%8193s'; ready=yes; while :; do :; done; }; f").unwrap();
    rig.ex.drive(10000);
    rig.drive_until_variable("ready", "yes");
    let sizes = ["a", "b"].map(|name| {
        let state = rig.shell.state();
        let state = state.borrow();
        let value = &state.bindings()[name];
        (value.len(), state.bindings().scalar_capacity(name).unwrap())
    });
    assert_eq!(sizes, [(1, 1), (0, 0)]);
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
}

#[test]
fn printf_assignment_review_escape_warnings_commit_with_open_or_closed_stderr() {
    for (source, expected, diagnostic) in [
        (
            r"printf -v x 'prefix\xZ'",
            "prefix\\xZ",
            "missing hex digit for \\x",
        ),
        (
            r"printf -v x 'prefix\uZ'",
            "prefix\\uZ",
            "missing unicode digit for \\u",
        ),
        (
            r"printf -v x 'prefix\UZ'",
            "prefix\\UZ",
            "missing unicode digit for \\U",
        ),
        (
            r"printf -v x '%b' 'prefix\xZ'",
            "prefix\\xZ",
            "missing hex digit for \\x",
        ),
        (
            r"printf -v x '%b' 'prefix\uZ'",
            "prefix\\uZ",
            "missing unicode digit for \\u",
        ),
        (
            r"printf -v x '%b' 'prefix\UZ'",
            "prefix\\UZ",
            "missing unicode digit for \\U",
        ),
    ] {
        let warning = format!("/usr/bin/bash: printf: {diagnostic}\n");
        for closed in [false, true] {
            let rig = Rig::new(Limits::default());
            rig.variable("x", "old");
            let redirect = ["", " 2>&-"][usize::from(closed)];
            assert_eq!(
                rig.run(&format!("{source}{redirect}")),
                0,
                "{source}{redirect}"
            );
            assert_eq!(rig.shell.state().borrow().bindings()["x"], expected);
            assert!(rig.output.bytes().is_empty());
            assert_eq!(
                rig.errors.bytes(),
                [warning.as_bytes(), b""][usize::from(closed)]
            );
        }
    }
}

#[test]
fn printf_assignment_safe_ifs_refreshes_resolved_binding_and_star() {
    for prior in ["", "IFS=:", "unset IFS", "IFS=''"] {
        for (alias, value, expected) in [
            (
                "declare -n ref=IFS",
                ":;",
                "<a>\n<b>\n<c,d x>\nstar=<left:right>\n",
            ),
            (
                "declare -n first=IFS; declare -n ref=first",
                ",",
                "<a:b;c>\n<d x>\nstar=<left,right>\n",
            ),
            (
                "declare -n first=IFS; declare -n ref=first",
                "",
                "<a:b;c,d x>\nstar=<leftright>\n",
            ),
        ] {
            let source = format!(
                "{prior}; {alias}; printf -v ref '%s' '{value}'; set -- 'a:b;c,d x'; for y in $1; do echo \"<$y>\"; done; set -- left right; echo \"star=<$*>\""
            );
            printf::check_bytes(source.trim_start_matches(';'), expected.as_bytes());
        }
    }
}

#[test]
fn printf_assignment_safe_local_ifs_restores_outer_scope() {
    printf::check_bytes(
        "IFS=:; f() { local IFS=,; local -n ref=IFS; printf -v ref ';'; set -- left right; echo \"inner=<$*>\"; }; f; set -- left right; echo \"outer=<$*>\"",
        b"inner=<left;right>\nouter=<left:right>\n",
    );
}

#[test]
fn printf_assignment_review_direct_ifs_still_refreshes_splitting() {
    printf::check_bytes(
        "printf -v IFS ':'; set -- a:b; for y in $1; do echo \"<$y>\"; done",
        b"<a>\n<b>\n",
    );
}

#[test]
fn printf_assignment_review_ordinary_nameref_ifs_write_still_refreshes_splitting() {
    printf::check_bytes(
        "declare -n ref=IFS; ref=:; set -- a:b; for y in $1; do echo \"<$y>\"; done",
        b"<a>\n<b>\n",
    );
}

#[test]
fn printf_assignment_review_escape_warning_broken_pipe_preserves_target() {
    let rig = Rig::new(Limits::default());
    rig.variable("x", "old");
    let (reader, writer) = shell_engine::io::pipe();
    drop(reader);
    let mut fds = shell_engine::io::FdTable::default();
    fds.insert(0, shell_engine::io::Endpoint::null());
    fds.insert(1, shell_engine::io::Endpoint::null());
    fds.insert(2, writer);
    rig.shell.set_descriptors(fds).unwrap();
    assert_eq!(rig.run(r"printf -v x 'prefix\xZ'"), 141);
    assert_eq!(rig.shell.state().borrow().bindings()["x"], "old");
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn printf_assignment_review_escape_warning_cancellation_does_not_commit() {
    printf::assert_diagnostic_backpressure_cancellation(r"printf -v x 'prefix\xZ'", 2);
}
