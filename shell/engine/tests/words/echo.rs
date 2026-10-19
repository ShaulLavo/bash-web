//! Original byte-exact controls for Bash's default echo mode.
use super::printf::{
    assert_recovery, check_bytes as check, check_chunks, interrupt_delivery, interrupt_empty,
    recorded_endpoint, replace_output,
};
use super::*;

#[test]
fn echo_option_prefix_is_all_or_nothing_and_last_escape_flag_wins() {
    for (source, expected) in [
        ("echo", &b"\n"[..]),
        ("echo '' '' x", &b"  x\n"[..]),
        ("echo -n -n a b", &b"a b"[..]),
        (r"echo -neE 'a\nb'", &b"a\\nb"[..]),
        (r"echo -EnEe 'a\nb'", &b"a\nb"[..]),
        (r"echo -e -E -e 'a\nb'", &b"a\nb\n"[..]),
        (r"echo -neZ -n 'a\nb'", &b"-neZ -n a\\nb\n"[..]),
        ("echo -- -n", &b"-- -n\n"[..]),
        ("echo - -n", &b"- -n\n"[..]),
        ("echo x -n -e", &b"x -n -e\n"[..]),
    ] {
        check(source, expected);
    }
}

#[test]
fn echo_escapes_preserve_raw_bytes_and_distinct_octal_rules() {
    check(
        r"echo -ne '\a\b\e\E\f\n\r\t\v\\'",
        b"\x07\x08\x1b\x1b\x0c\n\r\t\x0b\\",
    );
    check(
        r"echo -ne '\0\0000\0777\0400\01\0123\123\777'",
        b"\0\0\xff\0\x01S\\123\\777",
    );
    check(
        r"echo -ne '\x\xG\x0\xff\x123\q\'",
        b"\\x\\xG\0\xff\x123\\q\\",
    );
    check("echo -e 'a\nb'", b"a\nb\n");
    check(r"echo -e 'before\cignored' later", b"before");
    check(r"echo -e a '\c' later", b"a ");
    check(r"echo -E '\0\c\xff'", b"\\0\\c\\xff\n");
}

#[test]
fn echo_unicode_respects_character_locale_without_scalar_validation() {
    let rig = Rig::new(Limits::default());
    rig.variable("LC_ALL", "C.UTF-8");
    assert_eq!(
        rig.run(r"echo -ne '\u0000\u00e9\ud800\U00110000\U80000000'"),
        0
    );
    assert_eq!(
        rig.output.bytes(),
        b"\0\xc3\xa9\xed\xa0\x80\xf4\x90\x80\x80"
    );
    check(
        r"LC_ALL=C echo -ne '\u00e9\U00110000\uZ\U'",
        b"\\u00E9\\U00110000\\uZ\\U",
    );
}

#[test]
fn echo_large_byte_output_and_closed_descriptor_recovery() {
    let rig = Rig::new(Limits::default());
    rig.variable("payload", &r"\0377".repeat(12_000));
    assert_eq!(rig.run("echo -ne \"$payload\""), 0);
    assert_eq!(rig.output.bytes(), vec![0xff; 12_000]);
    assert_eq!(rig.run("echo lost >&-"), 1);
    assert_eq!(rig.run("echo -ne '\\c' >&-"), 0);
    assert_eq!(rig.run("echo recovered"), 0);
    assert!(rig.output.bytes().ends_with(b"recovered\n"));
}

#[test]
fn echo_admission_rejects_before_output_and_recovers() {
    let rig = Rig::new(Limits {
        expansion_bytes: 1024,
        ..Limits::default()
    });
    rig.variable("payload", &"x".repeat(1024));
    assert_recovery(&rig, "echo \"$payload\"", 2);
}

#[test]
fn echo_delivery_cancellation_and_epipe_do_not_leak_state() {
    let rig = Rig::new(Limits::default());
    let reader = interrupt_delivery(
        &rig,
        &format!("echo -ne '{}'; echo bad", r"\0377".repeat(12_000)),
    );
    drop(reader);
    assert_eq!(rig.run("echo -e broken"), 141);
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn echo_small_invocations_are_single_writes_and_large_output_is_chunked() {
    let rig = Rig::new(Limits::default());
    let (output, records) = recorded_endpoint();
    replace_output(&rig, output);
    assert_eq!(rig.run(r"echo -e 'x\0y' z"), 0);
    assert_eq!(*records.borrow(), vec![b"x\0y z\n".to_vec()]);
    for (length, expected) in [
        (4095, vec![4096]),
        (4096, vec![4096, 1]),
        (4097, vec![4096, 2]),
    ] {
        check_chunks(
            &rig,
            &records,
            &format!("echo '{}'", "x".repeat(length)),
            &expected,
        );
    }
}

#[test]
fn echo_cancellation_during_work_admission_preserves_empty_output() {
    let rig = Rig::new(Limits::default());
    rig.variable("payload", &r"\0377".repeat(12_000));
    let job = rig
        .shell
        .start("started=yes; echo -ne \"$payload\"; echo bad")
        .unwrap();
    rig.drive_until_variable("started", "yes");
    for _ in 0..100 {
        rig.ex.drive(1);
    }
    interrupt_empty(&rig, job);
}

#[test]
fn echo_capture_cap_keeps_only_delivered_prefix_and_recovers() {
    let rig = Rig::new(Limits::default());
    rig.variable("payload", &"x".repeat(70_000));
    assert_eq!(rig.run("echo -n \"$payload\""), 1);
    assert_eq!(rig.output.bytes(), vec![b'x'; 64 * 1024]);
    let (fresh, _) = capture(64);
    replace_output(&rig, fresh);
    assert_eq!(rig.run("echo recovered"), 0);
}
