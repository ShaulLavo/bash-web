use super::*;

fn run_exec(source: &str, interactive: bool, errno: i32) -> (i32, Rc<Fake>) {
    let (executor, fake, runtime) = setup();
    fake.exec_errno.set(errno);
    let session = runtime_session(&executor, &runtime);
    session.state().borrow_mut().interactive = interactive;
    session.state().borrow_mut().command_string = !interactive;
    let job = session.start(source).unwrap();
    let status = finish(&executor, &runtime, job);
    shutdown_session(&executor, &runtime, &fake, session);
    (status, fake)
}

#[test]
fn explicit_options_and_effective_environment_do_not_change_lookup() {
    let (status, fake) = run_exec(
        "export KEEP=old; PATH=/special X=new exec -cl -a custom -- tool one",
        false,
        58,
    );
    assert_eq!(status, 126);
    assert!(fake.requests.borrow().is_empty());
    let requests = fake.exec_requests.borrow();
    let request = &requests[0];
    assert_eq!(request.executable, "/special/tool");
    assert_eq!(request.argv, ["-custom", "one"]);
    assert_eq!(
        request.env,
        BTreeMap::from([
            ("PATH".into(), "/special".into()),
            ("X".into(), "new".into())
        ])
    );
    assert_eq!(
        request
            .fds
            .iter()
            .map(|binding| binding.child)
            .collect::<Vec<_>>(),
        [0, 1, 2]
    );
    let json = serde_json::to_value(request).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 5);
    assert!(json.get("job").is_none());
}

#[test]
fn explicit_failure_exits_only_noninteractive_shell_and_keeps_redirects() {
    for interactive in [false, true] {
        let (status, fake) = run_exec(
            "exec tool > /output; echo after; echo error >&2",
            interactive,
            58,
        );
        assert_eq!(status, if interactive { 0 } else { 126 });
        let file = fake.fs.open("/output", &OpenOptions::default()).unwrap();
        let mut buffer = [0; 32];
        let count = file.read(&mut buffer).now_or_never().unwrap().unwrap();
        assert_eq!(
            &buffer[..count],
            if interactive {
                b"after\n".as_slice()
            } else {
                b""
            }
        );
        assert_eq!(fake.exec_requests.borrow().len(), 1);
    }
}

#[test]
fn automatic_replacement_only_falls_back_for_unsupported_hosts() {
    for errno in [52, 58, 44, 2, 48] {
        let (status, fake) = run_exec("tool", false, errno);
        assert_eq!(fake.exec_requests.borrow().len(), 1, "errno {errno}");
        let fallback = matches!(errno, 52 | 58);
        assert_eq!(fake.requests.borrow().len(), usize::from(fallback));
        assert_eq!(
            status,
            if fallback {
                0
            } else if errno == 44 {
                127
            } else {
                126
            }
        );
    }
}

#[test]
fn parser_and_lifecycle_eligibility_matrix() {
    for (source, attempts) in [
        ("tool", 1),
        ("true; tool", 1),
        ("true\ntool\n", 1),
        ("tool; true", 0),
        ("tool >/output", 0),
        ("! tool", 0),
        ("time tool", 0),
        ("tool | tool", 0),
        ("tool & wait", 0),
        ("true && tool", 0),
        ("true || tool", 0),
        ("{ tool; }", 0),
        ("(tool)", 0),
        ("f() { tool; }; f", 0),
        ("eval tool", 0),
        ("trap : EXIT; tool", 0),
        ("tool\n)", 0),
        ("tool $(true)", 0),
        ("tool ${x:-$(true)}", 0),
        (
            "shopt -s expand_aliases\nalias final='tool; true'\nfinal",
            0,
        ),
        ("shopt -s expand_aliases\nalias final=tool\nfinal", 1),
    ] {
        let (_, fake) = run_exec(source, false, 58);
        assert_eq!(fake.exec_requests.borrow().len(), attempts, "{source}");
    }
    let (_, fake) = run_exec("tool", true, 58);
    assert!(fake.exec_requests.borrow().is_empty());
}

#[test]
fn exec_remaps_original_root_to_lowest_unoccupied_child_without_reopening() {
    let (executor, fake, runtime) = setup();
    fake.root_preopen.set(Some(4));
    for user in [None, Some(3), Some(7)] {
        let mut fds = runtime.stdio().unwrap();
        if let Some(child) = user {
            fds.insert(child, fds.get(1).unwrap());
        }
        let request = ExecRequest {
            executable: "/tool".into(),
            argv: vec!["tool".into()],
            env: BTreeMap::new(),
            cwd: "/".into(),
            fds,
        };
        let before = fake.next_fd.get();
        assert!(runtime.exec(&request).is_err());
        let requests = fake.exec_requests.borrow();
        let root = requests
            .last()
            .unwrap()
            .fds
            .iter()
            .find(|binding| binding.parent == 4)
            .unwrap();
        assert_eq!(root.child, if user == Some(3) { 4 } else { 3 });
        assert_eq!(
            fake.next_fd.get(),
            before,
            "must not reopen or duplicate the root"
        );
    }
    assert_no_runtime_waiters(&executor, &runtime, &fake);
}

#[test]
fn exec_refuses_shell_pumped_input_and_reads_precommit_diagnostic_zero() {
    let (executor, fake, runtime) = setup();
    let mut fds = runtime.stdio().unwrap();
    fds.insert(0, Endpoint::bytes(b"buffered".to_vec()));
    let mut request = ExecRequest {
        executable: "/tool".into(),
        argv: vec!["tool".into()],
        env: BTreeMap::new(),
        cwd: "/".into(),
        fds,
    };
    assert!(matches!(
        runtime.exec(&request),
        Err(ProcessError::Runtime(58))
    ));
    assert!(fake.exec_requests.borrow().is_empty());
    request.fds = runtime.stdio().unwrap();
    fake.spawn_diagnostic
        .replace(b"replacement refused".to_vec());
    fake.exec_errno.set(48);
    assert_eq!(
        runtime.exec(&request),
        Err(ProcessError::StartFailed(48, "replacement refused".into()))
    );
    assert_eq!(fake.diagnostic_reads.borrow().as_slice(), &[(0, 4096)]);
    drop(request);
    assert_no_runtime_waiters(&executor, &runtime, &fake);
}

#[test]
fn exec_lookup_errors_and_wrappers_keep_shell_semantics() {
    for (path, errno, expected) in [("/missing", 44, 127), ("/denied", 2, 126)] {
        let (executor, fake, runtime) = setup();
        fake.access_results
            .borrow_mut()
            .insert(path.into(), Some(Err(errno)));
        let session = runtime_session(&executor, &runtime);
        let command = session.start(&format!("exec {path}; echo BAD")).unwrap();
        assert_eq!(finish(&executor, &runtime, command), expected);
        assert!(session.exit_requested());
        assert!(fake.exec_requests.borrow().is_empty());
        assert!(fake.output.bytes().is_empty());
        shutdown_session(&executor, &runtime, &fake, session);
    }
    for source in ["command exec -a custom tool", "builtin exec -- tool"] {
        let (status, fake) = run_exec(source, false, 58);
        assert_eq!(status, 126, "{source}");
        assert_eq!(fake.exec_requests.borrow().len(), 1, "{source}");
    }
    let (status, fake) = run_exec("command exec tool >/output; echo after", true, 58);
    assert_eq!(status, 0);
    let input = fake.fs.open("/output", &OpenOptions::default()).unwrap();
    let mut bytes = [0; 32];
    let count = input.read(&mut bytes).now_or_never().unwrap().unwrap();
    assert_eq!(&bytes[..count], b"after\n");
}

#[test]
fn automatic_exec_accepts_empty_groups_but_rejects_pending_runtime_ownership() {
    let (executor, fake, runtime) = setup();
    let group = runtime.allocate_group();
    assert!(
        runtime.exec_ready(),
        "an empty logical group has no process work"
    );
    runtime
        .0
        .groups
        .borrow_mut()
        .get_mut(&group)
        .unwrap()
        .cleanup_failed = true;
    assert!(!runtime.exec_ready());
    runtime
        .0
        .groups
        .borrow_mut()
        .get_mut(&group)
        .unwrap()
        .cleanup_failed = false;
    let pid = runtime.spawn(request(&runtime, "echo", group)).unwrap();
    assert!(
        !runtime.exec_ready(),
        "unreaped direct process owns its slot"
    );
    executor.drive(64);
    assert!(
        !runtime.exec_ready(),
        "an exited but unreaped process still disqualifies exec"
    );
    wait_status(&executor, &runtime, pid).unwrap();
    finish(
        &executor,
        &runtime,
        executor.spawn(runtime.wait_group(group)),
    )
    .unwrap();
    assert!(runtime.exec_ready());
    assert_no_runtime_waiters(&executor, &runtime, &fake);
}
