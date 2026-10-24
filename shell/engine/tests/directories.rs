//! cd/pushd/popd/dirs contracts against the pinned GNU Bash 5.3.15 recording in
//! scripts/fixtures/shell-directories.json. The recording ran in a sandbox
//! shaped like this filesystem: /, /home/guest (cwd and HOME), /tmp. Its stderr
//! had Bash's `/usr/bin/bash: line N: ` prefix rewritten to `/usr/bin/bash: `
//! (the fixture's `stderrNormalization`), because the engine prints no line
//! numbers; stdout and status are unmodified.
use futures::FutureExt;
use shell_engine::{
    Limits, Session,
    executor::Executor,
    io::{Capture, Endpoint, FdTable, MemoryFs, capture},
    process::InProcessHost,
};
use std::rc::Rc;

const FIXTURE: &str = include_str!("../../../scripts/fixtures/shell-directories.json");

#[derive(serde::Deserialize)]
struct Recording {
    bash: String,
    cases: Vec<Case>,
}
#[derive(serde::Deserialize)]
struct Case {
    name: String,
    setup: Vec<String>,
    code: String,
    status: i32,
    stdout: String,
    stderr: String,
}

struct Run {
    status: i32,
    output: Capture,
    errors: Capture,
}

fn run(case: &Case) -> Run {
    let executor = Executor::new();
    let host = InProcessHost::new(executor.clone());
    let (stdout, output) = capture(65536);
    let (stderr, errors) = capture(65536);
    let mut fds = FdTable::default();
    for (fd, endpoint) in [(0, Endpoint::null()), (1, stdout), (2, stderr)] {
        fds.insert(fd, endpoint);
    }
    let fs = MemoryFs::new(65536);
    for directory in &case.setup {
        fs.mkdir(directory, true).unwrap();
    }
    let session = Session::new(
        executor.clone(),
        Rc::new(host.clone()),
        Rc::new(fs),
        Limits::default(),
    );
    session
        .state()
        .borrow_mut()
        .assign_parameter("HOME".into(), "/home/guest".into())
        .unwrap();
    session.set_descriptors(fds).unwrap();
    let job = session.start(&case.code).unwrap();
    for _ in 0..100_000 {
        if job.is_finished() {
            break;
        }
        executor.drive(64);
    }
    assert!(job.is_finished(), "{} exceeded the turn limit", case.name);
    let status = job.now_or_never().unwrap();
    let shutdown = session.shutdown();
    futures::pin_mut!(shutdown);
    while shutdown.as_mut().now_or_never().is_none() {
        executor.drive(64);
    }
    Run {
        status,
        output,
        errors,
    }
}

#[test]
fn directory_builtins_match_recorded_bash() {
    let recording: Recording = serde_json::from_str(FIXTURE).unwrap();
    assert!(
        recording
            .bash
            .starts_with("GNU bash, version 5.3.15(1)-release"),
        "{}",
        recording.bash
    );
    assert!(!recording.cases.is_empty());
    for case in &recording.cases {
        let run = run(case);
        assert_eq!(
            String::from_utf8_lossy(&run.output.bytes()),
            case.stdout,
            "stdout of {}",
            case.name
        );
        assert_eq!(run.status, case.status, "status of {}", case.name);
        assert_eq!(
            String::from_utf8_lossy(&run.errors.bytes()),
            case.stderr,
            "stderr of {}",
            case.name
        );
    }
}
