//! Original noninteractive select controls, observed with GNU Bash 5.3.15.
use super::*;
use shell_engine::io::pipe;

fn park(rig: &Rig, job: &JoinHandle<i32>) {
    for _ in 0..200 {
        rig.ex.drive(64);
    }
    assert!(!job.is_finished(), "select must wait for its input");
}

fn value(rig: &Rig, name: &str) -> Option<String> {
    rig.shell.state().borrow().bindings().get(name).cloned()
}

fn input(rig: &Rig, bytes: &[u8], stderr: Endpoint) -> (Endpoint, Endpoint) {
    let (reader, writer) = pipe();
    assert_eq!(writer.write(bytes).now_or_never(), Some(Ok(bytes.len())));
    let mut fds = FdTable::default();
    for (fd, endpoint) in [(0, reader.clone()), (1, Endpoint::null()), (2, stderr)] {
        fds.insert(fd, endpoint);
    }
    rig.shell.set_descriptors(fds).unwrap();
    (reader, writer)
}

#[test]
fn select_menu_reply_and_input_ownership() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("{ select x in a b; do echo \"<$x>:<$REPLY>\"; break; done; read tail; echo \"$tail\"; } <<'EOF'\n 02 \nTAIL\nEOF"), 0);
    assert_eq!(rig.output.bytes(), b"<b>:< 02 >\nTAIL\n");
    assert_eq!(rig.errors.bytes(), b"1) a\n2) b\n#? ");
}

#[test]
fn select_empty_choices_do_not_read_or_bind() {
    let rig = Rig::new(Limits::default());
    let (reader, _writer) = input(&rig, b"1\n", Endpoint::null());
    rig.variable("REPLY", "old");
    assert_eq!(rig.run("select x in; do false; done"), 0);
    assert_eq!(value(&rig, "REPLY").as_deref(), Some("old"));
    let mut bytes = [0; 2];
    assert_eq!(reader.read(&mut bytes).now_or_never(), Some(Ok(2)));
    assert_eq!(bytes, *b"1\n");
}

#[test]
fn select_pending_and_partial_cancellation_preserve_bindings_and_recover() {
    for bytes in [b"".as_slice(), b"1".as_slice()] {
        let rig = Rig::new(Limits::default());
        let (_reader, writer) = input(&rig, bytes, Endpoint::null());
        rig.variable("x", "old");
        rig.variable("REPLY", "kept");
        let job = rig
            .shell
            .start("select x in a; do x=bad; break; done; x=bad")
            .unwrap();
        park(&rig, &job);
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
        assert_eq!(value(&rig, "x").as_deref(), Some("old"));
        assert_eq!(value(&rig, "REPLY").as_deref(), Some("kept"));
        assert_eq!(rig.run("true"), 0);
        drop(writer);
    }
}

#[test]
fn select_blank_input_yields_and_does_not_spend_elapsed_iteration_storage() {
    let rig = Rig::new(Limits::default());
    let (reader, writer) = input(&rig, &vec![b'\n'; 12000], Endpoint::null());
    let job = rig.shell.start("select x in a; do break; done").unwrap();
    let peer = rig.ex.spawn(async { 42 });
    rig.ex.drive(8);
    assert!(peer.is_finished());
    assert!(!job.is_finished());
    let mut unread = [0];
    assert_eq!(reader.read(&mut unread).now_or_never(), Some(Ok(1)));
    assert_eq!(
        unread,
        [b'\n'],
        "blank redisplays must yield before draining input"
    );
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("true"), 0);
    drop(writer);
}

#[test]
fn select_line_limit_and_invalid_utf8_do_not_bind_partial_input() {
    for bytes in [b"12345\n".as_slice(), b"\xff\n".as_slice()] {
        let rig = Rig::new(Limits {
            line_bytes: 4,
            ..Limits::default()
        });
        let (_reader, _writer) = input(&rig, bytes, Endpoint::null());
        rig.variable("x", "old");
        rig.variable("REPLY", "kept");
        assert_eq!(rig.run("select x in a; do x=bad; break; done"), 2);
        assert_eq!(value(&rig, "x").as_deref(), Some("old"));
        assert_eq!(value(&rig, "REPLY").as_deref(), Some("kept"));
        assert_eq!(rig.run("true"), 0);
    }
}

#[test]
fn select_argument_and_storage_limits_fail_before_input_is_consumed() {
    for limits in [
        Limits {
            arguments: 1,
            ..Limits::default()
        },
        Limits {
            expansion_bytes: 256,
            ..Limits::default()
        },
    ] {
        let rig = Rig::new(limits);
        let (reader, _writer) = input(&rig, b"1\n", Endpoint::null());
        assert_eq!(rig.run("select x in a b; do break; done"), 2);
        let mut bytes = [0; 2];
        assert_eq!(reader.read(&mut bytes).now_or_never(), Some(Ok(2)));
        assert_eq!(bytes, *b"1\n");
        assert_eq!(rig.run("true"), 0);
    }
}

#[test]
fn select_prompt_write_failures_do_not_consume_input_and_refund_storage() {
    let (read_end, write_end) = pipe();
    drop(read_end);
    for (stderr, status) in [(write_end, 141), (capture(1).0, 2)] {
        let rig = Rig::new(Limits::default());
        let (reader, _writer) = input(&rig, b"1\n", stderr);
        assert_eq!(rig.run("select x in a; do break; done"), status);
        let mut bytes = [0; 2];
        assert_eq!(reader.read(&mut bytes).now_or_never(), Some(Ok(2)));
        assert_eq!(rig.run("true"), 0);
    }
}

#[test]
fn select_skipped_input_spends_work_without_partial_assignment() {
    let rig = Rig::new(Limits {
        source_bytes: 128,
        expansion_bytes: 2048,
        arguments: 16,
        line_bytes: 16,
        ..Limits::default()
    });
    let (reader, _writer) = input(&rig, &[0; 4000], Endpoint::null());
    rig.variable("REPLY", "old");
    assert_eq!(rig.run("select x in a; do break; done"), 2);
    assert_eq!(value(&rig, "REPLY").as_deref(), Some("old"));
    let mut remaining = [0; 4000];
    let read = reader.read(&mut remaining).now_or_never().unwrap().unwrap();
    assert!(
        read > 0 && read < 4000,
        "work limit must stop after some NUL bytes"
    );
    assert_eq!(rig.run("true"), 0);
}

#[test]
fn select_cancelled_buffers_release_a_small_live_execution_allowance() {
    let rig = Rig::new(Limits {
        execution_bytes: 128 * 1024,
        ..Limits::default()
    });
    let (_reader, _writer) = input(&rig, b"", Endpoint::null());
    for _ in 0..8 {
        let job = rig.shell.start("select x in a; do break; done").unwrap();
        park(&rig, &job);
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
    }
    assert_eq!(rig.run("true"), 0);
}
