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
    let session = Rc::new(Session::new(
        executor.clone(),
        Rc::new(runtime.clone()),
        Rc::new(runtime.clone()),
        Limits::default(),
    ));
    session.set_descriptors(runtime.stdio().unwrap()).unwrap();
    session
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
