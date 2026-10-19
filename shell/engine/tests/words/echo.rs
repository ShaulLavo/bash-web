//! Original byte-exact controls for Bash's default echo mode.
use super::*;
use shell_engine::io::pipe;

fn check(source: &str, expected: &[u8]) {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(source), 0, "{source}");
    assert_eq!(rig.output.bytes(), expected, "{source}");
    assert!(rig.errors.bytes().is_empty(), "{source}");
}

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
    assert_eq!(rig.run("echo \"$payload\""), 2);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}

#[test]
fn echo_delivery_cancellation_and_epipe_do_not_leak_state() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = pipe();
    let mut fds = FdTable::default();
    fds.insert(0, Endpoint::null());
    fds.insert(1, writer);
    fds.insert(2, Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
    let job = rig
        .shell
        .start(&format!("echo -ne '{}'; echo bad", r"\0377".repeat(12_000)))
        .unwrap();
    let mut first = [0; 1];
    for _ in 0..100_000 {
        rig.ex.drive(1);
        if reader.read(&mut first).now_or_never() == Some(Ok(1)) {
            break;
        }
    }
    assert_eq!(first, [0xff]);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("true"), 0);
    drop(reader);
    assert_eq!(rig.run("echo -e broken"), 141);
    assert_eq!(rig.run("true"), 0);
}
