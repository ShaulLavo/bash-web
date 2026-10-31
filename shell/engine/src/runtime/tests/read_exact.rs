use super::*;

fn input(fake: &Fake, bytes: Vec<u8>) {
    fake.fds.borrow_mut().insert(0, Endpoint::bytes(bytes));
}

fn assert_script_output(
    executor: &Executor,
    fake: &Fake,
    runtime: &Runtime,
    session: &Session,
    source: &str,
    expected: &[u8],
) {
    assert_eq!(finish(executor, runtime, session.start(source).unwrap()), 0);
    assert_eq!(fake.output.bytes(), expected);
}

fn cancel_exact_read(
    executor: &Executor,
    runtime: &Runtime,
    session: &Session,
    job: crate::executor::JoinHandle<i32>,
) {
    session.interrupt();
    assert_eq!(finish(executor, runtime, job), 130);
    assert_eq!(value(session, "x").as_deref(), Some("old"));
}

#[test]
fn raw_exact_c_read_batches_runtime_calls_without_consuming_an_alias_sentinel() {
    let (executor, fake, runtime) = setup();
    input(
        &fake,
        vec![b'x'; 65536].into_iter().chain(*b"!\n").collect(),
    );
    let session = runtime_session(&executor, &runtime);
    let source = "LC_ALL=C; exec 3<&0; read -r -N65536 value; printf '%s:%s:' \"$?\" \"${#value}\"; read -r -u3 tail; printf '%s' \"$tail\"; exec 3<&-";
    assert_script_output(&executor, &fake, &runtime, &session, source, b"0:65536:!");
    let reads = fake.reads.borrow();
    let requests: Vec<_> = reads.iter().map(|(_, length)| *length).collect();
    eprintln!(
        "raw exact 65536 plus sentinel: calls={} max={}",
        requests.len(),
        requests.iter().max().unwrap()
    );
    assert!(requests.len() <= 18, "requests={}", requests.len());
    assert_eq!(requests.iter().copied().max(), Some(4096));
    assert_eq!(requests.iter().sum::<usize>(), 65538);
    drop(reads);
    shutdown_session(&executor, &runtime, &fake, session);
}

fn value(session: &Session, name: &str) -> Option<String> {
    session
        .state()
        .borrow()
        .bindings()
        .get(name)
        .map(|value| value.as_str().to_owned())
}

#[test]
fn raw_exact_short_reads_and_eof_keep_counts_and_assign_partial_input() {
    let (executor, fake, runtime) = setup();
    fake.read_limit.set(7);
    input(&fake, vec![b'a'; 100]);
    let session = runtime_session(&executor, &runtime);
    let source = "LC_ALL=C; read -rN99 x; printf '%s:%s:' \"$?\" \"${#x}\"; read -rN2 y; printf '%s:%s' \"$?\" \"$y\"";
    assert_script_output(&executor, &fake, &runtime, &session, source, b"0:99:1:a");
    assert_eq!(fake.reads.borrow().len(), 17);
    assert_eq!(fake.reads.borrow()[0].1, 99);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_nuls_do_not_count_or_consume_an_alias_suffix() {
    let (executor, fake, runtime) = setup();
    let bytes = b"a\0".repeat(4096).into_iter().chain(*b"!\n").collect();
    input(&fake, bytes);
    let session = runtime_session(&executor, &runtime);
    let source = "LC_ALL=C; exec 3<&0; read -rN4096 x; read -r -u3 tail; printf '%s:%s' \"${#x}\" \"$tail\"; exec 3<&-";
    assert_script_output(&executor, &fake, &runtime, &session, source, b"4096:!");
    assert!(fake.reads.borrow().len() < 20);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn delimiter_utf8_and_escape_reads_remain_byte_exact() {
    for (source, bytes, expected) in [
        ("LC_ALL=C; read -r x", b"abc\n!".as_slice(), "abc"),
        ("LC_ALL=C; read -rn99 x", b"abc\n!", "abc"),
        ("LC_ALL=C; read -r -d: x", b"abc:!", "abc"),
        ("LC_ALL=C; read -N3 x", b"a\\b\\\nc!", "abc"),
        ("LC_ALL=C.UTF-8; read -rN2 x", "é中!".as_bytes(), "é中"),
    ] {
        byte_exact_control(source, bytes, expected);
    }
}

fn byte_exact_control(source: &str, bytes: &[u8], expected: &str) {
    let (executor, fake, runtime) = setup();
    input(&fake, bytes.to_vec());
    let session = runtime_session(&executor, &runtime);
    assert_eq!(
        finish(&executor, &runtime, session.start(source).unwrap()),
        0
    );
    assert_eq!(value(&session, "x").as_deref(), Some(expected));
    assert!(fake.reads.borrow().iter().all(|(_, length)| *length == 1));
    let mut tail = [0];
    assert_eq!(
        fake.fds.borrow()[&0].read(&mut tail).now_or_never(),
        Some(Ok(1))
    );
    assert_eq!(tail, [b'!']);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_invalid_utf8_preserves_assignment_and_suffix() {
    let (executor, fake, runtime) = setup();
    input(&fake, b"ab\xff!".to_vec());
    let session = runtime_session(&executor, &runtime);
    let source = "LC_ALL=C; x=old; read -rN3 x; printf '%s:%s:' \"$?\" \"$x\"; read -rN1 tail; printf '%s' \"$tail\"";
    assert_script_output(&executor, &fake, &runtime, &session, source, b"2:old:!");
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_line_limit_stops_at_the_first_excess_byte() {
    let (executor, fake, runtime) = setup();
    input(&fake, b"abcdEz".to_vec());
    let session = runtime_session_with_limits(
        &executor,
        &runtime,
        Limits {
            line_bytes: 4,
            ..Limits::default()
        },
    );
    let source = "LC_ALL=C; x=old; read -rN99 x; printf '%s:%s:' \"$?\" \"$x\"; read -rN1 tail; printf '%s' \"$tail\"";
    assert_script_output(&executor, &fake, &runtime, &session, source, b"2:old:z");
    assert_eq!(
        fake.reads
            .borrow()
            .iter()
            .map(|(_, length)| *length)
            .collect::<Vec<_>>(),
        vec![5, 1]
    );
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_admission_and_zero_count_do_not_read() {
    let (executor, fake, runtime) = setup();
    input(&fake, b"a!".to_vec());
    let session = runtime_session_with_limits(
        &executor,
        &runtime,
        Limits {
            expansion_bytes: 512,
            ..Limits::default()
        },
    );
    let source = "LC_ALL=C; x=old; read -rN65536 x";
    assert_eq!(
        finish(&executor, &runtime, session.start(source).unwrap()),
        2
    );
    assert_eq!(value(&session, "x").as_deref(), Some("old"));
    assert!(fake.reads.borrow().is_empty());
    assert_eq!(
        finish(&executor, &runtime, session.start("read -rN0 x").unwrap()),
        0
    );
    assert!(fake.reads.borrow().is_empty());
    assert_eq!(
        finish(&executor, &runtime, session.start("read -rN1 x").unwrap()),
        0
    );
    assert_eq!(value(&session, "x").as_deref(), Some("a"));
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_pending_eagain_cancels_without_assignment_and_releases_waiters() {
    let (executor, fake, runtime) = setup();
    let (reader, writer) = io::pipe();
    fake.fds.borrow_mut().insert(0, reader);
    assert_eq!(writer.write(b"ab").now_or_never(), Some(Ok(2)));
    let session = runtime_session(&executor, &runtime);
    let job = session
        .start("LC_ALL=C; x=old; read -rN65536 x; x=bad")
        .unwrap();
    for _ in 0..100 {
        executor.drive(8);
        runtime.poll(0).unwrap();
    }
    assert!(!job.is_finished());
    assert!(
        fake.polls
            .borrow()
            .iter()
            .any(|(_, subscriptions)| subscriptions.iter().any(|sub| sub.kind == 0))
    );
    assert!(
        fake.reads
            .borrow()
            .iter()
            .all(|(_, length)| *length <= 4096)
    );
    cancel_exact_read(&executor, &runtime, &session, job);
    assert_eq!(
        finish(&executor, &runtime, session.start("true").unwrap()),
        0
    );
    drop(writer);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_pipe_backpressure_and_short_reads_make_progress() {
    let (executor, fake, runtime) = setup();
    let session = runtime_session(&executor, &runtime);
    let source = "LC_ALL=C; printf '%065536d!\\n' 0 | { exec 3<&0; read -rN65536 x; printf '%s:%s:' \"$?\" \"${#x}\"; read -r -u3 tail; printf '%s' \"$tail\"; exec 3<&-; }";
    assert_script_output(&executor, &fake, &runtime, &session, source, b"0:65536:!");
    let reads = fake.reads.borrow();
    eprintln!(
        "bounded fake-runtime pipe: calls={} max={}",
        reads.len(),
        reads.iter().map(|(_, n)| n).max().unwrap()
    );
    assert!(reads.len() < 100);
    assert_eq!(reads.iter().map(|(_, n)| *n).max(), Some(4096));
    drop(reads);
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn raw_exact_ready_input_yields_and_cancels_with_bounded_consumption() {
    let (executor, fake, runtime) = setup();
    input(&fake, vec![b'x'; 65536]);
    let session = runtime_session(&executor, &runtime);
    let job = session
        .start("LC_ALL=C; x=old; read -rN65536 x; x=bad")
        .unwrap();
    for _ in 0..10000 {
        executor.drive(1);
        if !fake.reads.borrow().is_empty() {
            break;
        }
    }
    assert_eq!(
        fake.reads
            .borrow()
            .iter()
            .map(|(_, length)| *length)
            .collect::<Vec<_>>(),
        vec![4096]
    );
    let peer = executor.spawn(async { 42 });
    executor.drive(2);
    assert!(peer.is_finished());
    assert!(!job.is_finished());
    cancel_exact_read(&executor, &runtime, &session, job);
    assert_eq!(
        fake.reads
            .borrow()
            .iter()
            .map(|(_, length)| *length)
            .collect::<Vec<_>>(),
        vec![4096]
    );
    assert_eq!(
        finish(&executor, &runtime, session.start("true").unwrap()),
        0
    );
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn timed_read_removes_runtime_waiter_after_timeout_and_cancellation() {
    for cancelled in [false, true] {
        timed_runtime_cleanup(cancelled);
    }
}

fn timed_runtime_cleanup(cancelled: bool) {
    let (executor, fake, runtime) = setup();
    let (reader, writer) = io::pipe();
    fake.fds.borrow_mut().insert(0, reader.clone());
    let session = runtime_session(&executor, &runtime);
    let before = runtime.0.support.waiter_count();
    let job = session.start("read -t60 x").unwrap();
    for _ in 0..1000 {
        executor.drive(1);
        if executor.next_deadline().is_some() && runtime.0.support.waiter_count() > before {
            break;
        }
    }
    assert_eq!(runtime.0.support.waiter_count(), before + 1);
    assert_eq!(executor.fire_timers(executor.next_deadline().unwrap()), 1);
    assert_eq!(writer.write(b"tail\n").now_or_never(), Some(Ok(5)));
    if cancelled {
        session.interrupt();
    }
    assert_eq!(
        finish(&executor, &runtime, job),
        if cancelled { 130 } else { 142 }
    );
    assert_eq!(runtime.0.support.waiter_count(), before);
    assert!(executor.next_deadline().is_none());
    let mut bytes = [0; 5];
    assert_eq!(reader.read(&mut bytes).now_or_never(), Some(Ok(5)));
    assert_eq!(&bytes, b"tail\n");
    assert!(reader.read(&mut bytes).now_or_never().is_none());
    assert_eq!(
        finish(&executor, &runtime, session.start("true").unwrap()),
        0
    );
    shutdown_session(&executor, &runtime, &fake, session);
}

#[test]
fn timed_runtime_regular_read_ignores_deadline_across_cooperative_turns() {
    let (executor, fake, runtime) = setup();
    fake.fs.write_file("/regular", &vec![b'x'; 65536]).unwrap();
    fake.fds.borrow_mut().insert(
        0,
        fake.fs
            .open("/regular", &io::OpenOptions::default())
            .unwrap(),
    );
    let session = runtime_session(&executor, &runtime);
    let job = session
        .start("LC_ALL=C; read -rN65536 -t0.000001 x")
        .unwrap();
    for _ in 0..10000 {
        executor.drive(1);
        assert!(executor.next_deadline().is_none());
        assert_eq!(
            executor.fire_timers(std::time::Instant::now() + std::time::Duration::from_secs(60)),
            0
        );
        if job.is_finished() {
            break;
        }
        runtime.poll(0).unwrap();
    }
    assert_eq!(finish(&executor, &runtime, job), 0);
    assert_eq!(value(&session, "x").unwrap().len(), 65536);
    shutdown_session(&executor, &runtime, &fake, session);
}
