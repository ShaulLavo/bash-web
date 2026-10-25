use super::*;

fn inherited_pipe(writer: bool, bindings: &[u32]) -> (Executor, Rc<Fake>, Runtime, Endpoint) {
    let (executor, fake, runtime) = setup();
    let (read, write) = io::pipe();
    let (endpoint, peer) = if writer { (write, read) } else { (read, write) };
    for &fd in bindings {
        fake.fds.borrow_mut().insert(fd, endpoint.clone());
        fake.inherited.borrow_mut().push(fd);
    }
    (executor, fake, runtime, peer)
}

fn transferred_session(executor: &Executor, runtime: &Runtime) -> Rc<Session> {
    runtime_session_with_fds(executor, runtime, runtime.take_stdio().unwrap())
}

fn assert_peer_closed(peer: &Endpoint, writer: bool) {
    if writer {
        assert_eq!(peer.read(&mut [0]).now_or_never(), Some(Ok(0)));
        return;
    }
    assert_eq!(
        peer.write(b"x").now_or_never(),
        Some(Err(IoError::BrokenPipe))
    );
}

#[test]
fn inherited_transfer_releases_last_pipe_before_session_exit() {
    for writer in [true, false] {
        let (executor, fake, runtime, peer) = inherited_pipe(writer, &[3]);
        let session = transferred_session(&executor, &runtime);
        assert!(!fake.fds.borrow().contains_key(&3));
        let source = if writer {
            "exec 3>&-; printf CLOSED"
        } else {
            "exec 3<&-; printf CLOSED"
        };
        assert_eq!(
            finish(&executor, &runtime, session.start(source).unwrap()),
            0
        );
        assert_eq!(fake.output.bytes(), b"CLOSED");
        assert_peer_closed(&peer, writer);
        assert_eq!(finish(&executor, &runtime, session.start(":").unwrap()), 0);
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn inherited_transfer_keeps_true_aliases_until_final_close_or_replace() {
    for writer in [true, false] {
        let (executor, fake, runtime, peer) = inherited_pipe(writer, &[3, 1_000_000]);
        let session = transferred_session(&executor, &runtime);
        let source = if writer {
            "exec 7>&3; exec 3>&-"
        } else {
            "exec 7<&3; exec 3<&-"
        };
        assert_eq!(
            finish(&executor, &runtime, session.start(source).unwrap()),
            0
        );
        assert_eq!(
            finish(
                &executor,
                &runtime,
                session.start("exec 1000000>&-").unwrap()
            ),
            0
        );
        if writer {
            assert!(peer.read(&mut [0]).now_or_never().is_none());
        }
        if !writer {
            assert_eq!(peer.write(b"x").now_or_never(), Some(Ok(1)));
        }
        let source = if writer {
            "exec 7>/replacement"
        } else {
            "exec 7<&-"
        };
        assert_eq!(
            finish(&executor, &runtime, session.start(source).unwrap()),
            0
        );
        assert_peer_closed(&peer, writer);
        shutdown_session(&executor, &runtime, &fake, session);
    }
}

#[test]
fn inherited_transfer_failure_leaves_originals_and_cleans_partial_duplicates() {
    let (_executor, fake, runtime, _peer) = inherited_pipe(true, &[3]);
    let before: Vec<_> = fake.fds.borrow().keys().copied().collect();
    fake.inherited.borrow_mut().push(999);
    assert!(runtime.take_stdio().is_err());
    assert_eq!(
        fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
        before
    );
    fake.inherited.borrow_mut().pop();
    let fds = runtime.take_stdio().unwrap();
    assert!(runtime.take_stdio().is_err());
    assert!(runtime.stdio().is_err());
    drop(fds);
    assert!(fake.fds.borrow().is_empty());
}

#[test]
fn inherited_transfer_preserves_preopens_and_shared_offsets() {
    let (_executor, fake, runtime) = setup();
    fake.fs.write_file("/data", b"abcdef").unwrap();
    let file = fake.fs.open("/data", &OpenOptions::default()).unwrap();
    fake.fds.borrow_mut().insert(1_000_000, file.clone());
    fake.inherited.borrow_mut().push(1_000_000);
    let private = fake.fd(Endpoint::null());
    let fds = runtime.take_stdio().unwrap();
    assert!(fds.get(private).is_none());
    let mut bytes = [0; 3];
    assert_eq!(
        fds.get(1_000_000).unwrap().read(&mut bytes).now_or_never(),
        Some(Ok(3))
    );
    assert_eq!(&bytes, b"abc");
    assert_eq!(file.read(&mut bytes).now_or_never(), Some(Ok(3)));
    assert_eq!(&bytes, b"def");
    drop(fds);
    assert_eq!(
        fake.fds.borrow().keys().copied().collect::<Vec<_>>(),
        [private]
    );
}

#[test]
fn inherited_transfer_cancellation_does_not_keep_a_closed_writer() {
    let (executor, fake, runtime, peer) = inherited_pipe(true, &[3]);
    let (input, _writer) = io::pipe();
    fake.fds.borrow_mut().insert(0, input);
    let session = transferred_session(&executor, &runtime);
    let job = session.start("exec 3>&-; read value").unwrap();
    executor.drive(64);
    assert!(!job.is_finished());
    assert_peer_closed(&peer, true);
    session.interrupt();
    assert_eq!(finish(&executor, &runtime, job), 130);
    assert_peer_closed(&peer, true);
    shutdown_session(&executor, &runtime, &fake, session);
}
