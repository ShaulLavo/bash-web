//! WASI-only usage fixture. This binary is not installed as a utility.
#[cfg(not(all(target_arch = "wasm32", target_os = "wasi")))]
fn main() {
    panic!("process fixture requires wasm32-wasip1 and Waffle");
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
fn main() {
    fixture::main();
}

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
mod fixture {
    use shell_wasi_process::{
        DescriptorBinding, Error, Outcome, Request, inherited_stdio, resolve_executable, run, spawn,
    };
    use std::collections::BTreeMap;

    #[link(wasm_import_module = "runtime_proc")]
    unsafe extern "C" {
        #[link_name = "write"]
        fn write(fd: u32, ptr: *const u8, length: usize) -> i32;
        #[link_name = "start_status"]
        fn start_status(pid: u32) -> i32;
        #[link_name = "poll"]
        fn poll(ptr: *const u8, count: usize, timeout: i32, output: *mut u8) -> i32;
        #[link_name = "signal"]
        fn signal(number: i32, mode: i32) -> i32;
        #[link_name = "fd_kind"]
        fn fd_kind(fd: u32) -> i32;
        #[link_name = "job_of"]
        fn job_of(pid: u32) -> i32;
        #[link_name = "spawn"]
        fn raw_spawn(ptr: *const u8, length: usize) -> i32;
        #[link_name = "interrupted"]
        fn interrupted() -> i32;
        #[link_name = "wait"]
        fn raw_wait(pid: u32, output: *mut u8) -> i32;
        #[link_name = "wait_job"]
        fn raw_wait_job(job: u32, flags: u32, output: *mut u8) -> i32;
    }

    #[link(wasm_import_module = "fixture_control")]
    unsafe extern "C" {
        fn release_fence();
    }

    pub fn main() {
        let arguments: Vec<_> = std::env::args().collect();
        match arguments.get(1).map(String::as_str) {
            Some("driver") => driver(),
            Some("inspect") => inspect(),
            Some("spin" | "delayed-spin") => spin(),
            Some("closed") => closed(),
            Some("leader") => leader(),
            Some("exit") => std::process::exit(arguments[2].parse().unwrap()),
            Some("review-cancel") => review_cancel(false),
            Some("review-drop-pending") => review_cancel(true),
            Some("review-drop-child") => review_drop_child(),
            Some("review-drop-access") => review_drop_access(),
            Some("review-noop") => println!("REVIEW_OK"),
            Some("review-delayed-cancel") => review_delayed_cancel(false),
            Some("review-delayed-wait") => review_delayed_cancel(true),
            Some("review-delayed-drop") => review_delayed_drop(),
            _ => panic!("unknown fixture mode"),
        }
    }

    fn review_delayed_cancel(wait_signal: bool) {
        let mut child = spawn(&request("delayed-spin")).unwrap();
        await_entry(child.pid());
        assert_eq!(unsafe { signal(2, 2) }, 0);
        assert_eq!(unsafe { signal(2, 3) }, 0);
        if wait_signal {
            assert_eq!(unsafe { signal(3, 2) }, 0);
            assert_eq!(unsafe { signal(3, 3) }, 0);
        }
        let result = if wait_signal {
            child.wait()
        } else {
            child.cancel()
        };
        assert_eq!(
            result,
            Err(Error::CleanupWaitUnsupported {
                interrupted: if wait_signal { Some(2) } else { None },
            })
        );
        assert_eq!(child.try_wait(), Ok(None), "held fence was collected early");
        assert_eq!(unsafe { interrupted() }, if wait_signal { 3 } else { 2 });
        assert_eq!(unsafe { signal(2, 0) }, 0);
        assert_eq!(unsafe { signal(3, 0) }, 0);
        unsafe { release_fence() };
        assert_eq!(child.wait(), Ok(Outcome::Signaled(9)));
        println!("REVIEW_OK");
    }

    fn review_delayed_drop() {
        let child = spawn(&request("delayed-spin")).unwrap();
        await_entry(child.pid());
        let pid = child.pid();
        let job = u32::try_from(unsafe { job_of(pid) }).unwrap();
        assert_eq!(unsafe { signal(2, 2) }, 0);
        assert_eq!(unsafe { signal(2, 3) }, 0);
        drop(child);
        assert_eq!(unsafe { interrupted() }, 2);
        assert_eq!(unsafe { signal(2, 0) }, 0);
        unsafe { release_fence() };
        // This test owner retained the identities before Drop. Product callers
        // cannot rely on Drop to collect a job when the host cannot park.
        collect(|out| unsafe { raw_wait(pid, out) }, 2, pid);
        collect(|out| unsafe { raw_wait_job(job, 1, out) }, 4, job);
        println!("REVIEW_OK");
    }

    fn review_cancel(drop_child: bool) {
        let mut child = spawn(&request("spin")).unwrap();
        await_entry(child.pid());
        assert_eq!(unsafe { signal(2, 2) }, 0);
        assert_eq!(unsafe { signal(2, 3) }, 0);
        let pid = child.pid();
        let job = u32::try_from(unsafe { job_of(pid) }).unwrap();
        if drop_child {
            drop(child);
        } else {
            assert!(matches!(
                child.cancel(),
                Ok(Outcome::Signaled(9)) | Err(Error::CleanupWaitUnsupported { interrupted: None })
            ));
            assert_eq!(unsafe { interrupted() }, 2, "parent SIGINT was consumed");
            assert_eq!(unsafe { signal(2, 0) }, 0);
            assert_eq!(child.wait(), Ok(Outcome::Signaled(9)));
            println!("REVIEW_OK");
            return;
        }
        assert_eq!(unsafe { interrupted() }, 2, "parent SIGINT was consumed");
        assert_eq!(unsafe { signal(2, 0) }, 0);
        collect(|out| unsafe { raw_wait(pid, out) }, 2, pid);
        collect(|out| unsafe { raw_wait_job(job, 1, out) }, 4, job);
        println!("REVIEW_OK");
    }

    fn review_drop_child() {
        assert_eq!(unsafe { fd_kind(2) }, -8);
        let child = spawn(&request("spin")).unwrap();
        await_entry(child.pid());
        let pid = child.pid();
        let job = u32::try_from(unsafe { job_of(pid) }).unwrap();
        // The test worker kills the real child, then injects an error return.
        drop(child);
        collect(|out| unsafe { raw_wait(pid, out) }, 2, pid);
        collect(|out| unsafe { raw_wait_job(job, 1, out) }, 4, job);
        println!("REVIEW_OK");
    }

    fn review_drop_access() {
        assert_eq!(unsafe { fd_kind(2) }, -8);
        assert_eq!(unsafe { signal(2, 2) }, 0);
        assert_eq!(unsafe { signal(2, 3) }, 0);
        assert_eq!(
            resolve_executable("fixture", Some("/bin"), "/"),
            Err(Error::Interrupted(2))
        );
        assert_eq!(unsafe { signal(2, 0) }, 0);
        println!("REVIEW_OK");
    }

    fn collect(call: impl Fn(*mut u8) -> i32, kind: u32, id: u32) {
        let mut record = [0u8; 8];
        let mut subscription = [0u8; 16];
        subscription[..4].copy_from_slice(&kind.to_le_bytes());
        subscription[4..8].copy_from_slice(&id.to_le_bytes());
        let mut output = [0u8; 16];
        loop {
            let result = call(record.as_mut_ptr());
            if result == 0 || result == -12 {
                return;
            }
            assert_eq!(result, -6);
            assert!(unsafe { poll(subscription.as_ptr(), 1, -1, output.as_mut_ptr()) } >= 0);
        }
    }

    fn request(mode: &str) -> Request {
        Request {
            executable: "/bin/fixture".into(),
            argv: vec!["custom argv0".into(), mode.into()],
            env: BTreeMap::new(),
            cwd: "/".into(),
            fds: inherited_stdio().unwrap(),
        }
    }

    fn driver() {
        lookup();
        let mut inspection = request("inspect");
        inspection.argv.extend(["".into(), "a b\n雪".into()]);
        inspection.env = BTreeMap::from([("ONLY".into(), "exact=value".into())]);
        // The parent owns sparse high fds and fd 3. Reserve child fd 3 too, so
        // its private root preopen must relocate and patched libc must find it.
        inspection.fds.retain(|binding| binding.child != 1);
        inspection.fds.extend([
            DescriptorBinding {
                child: 1,
                parent: 9,
            },
            DescriptorBinding {
                child: 3,
                parent: 9,
            },
            DescriptorBinding::inherit(1_000_000),
        ]);
        assert_eq!(run(&inspection), Ok(Outcome::Exited(0)));
        let mut empty = request("exit");
        empty.argv.push("127".into());
        assert_eq!(run(&empty), Ok(Outcome::Exited(127)));
        empty.argv[2] = "126".into();
        assert_eq!(run(&empty), Ok(Outcome::Exited(126)));
        let mut badfd = request("exit");
        badfd.fds.push(DescriptorBinding {
            child: 77,
            parent: 99,
        });
        assert!(matches!(
            run(&badfd),
            Err(Error::Host {
                operation: "spawn",
                errno: 8
            })
        ));
        let mut missing = request("exit");
        missing.executable = "/bin/missing".into();
        assert_eq!(run(&missing), Ok(Outcome::StartFailed(44)));
        missing.executable = "/bin/no-start".into();
        assert_eq!(run(&missing), Ok(Outcome::StartFailed(45)));
        let mut closed = request("closed");
        closed.fds = vec![DescriptorBinding {
            child: 1_000_000,
            parent: 1,
        }];
        assert_eq!(run(&closed), Ok(Outcome::Exited(0)));
        descendant_cleanup();
        cancel_and_drop();
        println!("CONSUMER_OK");
    }

    fn lookup() {
        assert_eq!(
            resolve_executable("fixture", Some("/denied:/missing:/bin"), "/").unwrap(),
            "/bin/fixture"
        );
        assert_eq!(
            resolve_executable("fixture", Some(""), "/bin").unwrap(),
            "fixture"
        );
        assert_eq!(
            resolve_executable("./fixture", Some("/missing"), "/bin").unwrap(),
            "./fixture"
        );
        assert_eq!(
            resolve_executable("fixture", None, "/").unwrap(),
            "/bin/fixture"
        );
        assert!(matches!(
            resolve_executable("fixture", Some("/denied:/missing"), "/"),
            Err(Error::Host { errno: 2, .. })
        ));
        assert!(matches!(
            resolve_executable("fixture", Some("/missing"), "/"),
            Err(Error::Host { errno: 44, .. })
        ));
        println!("LOOKUP_OK");
    }

    fn cancel_and_drop() {
        let mut child = spawn(&request("spin")).unwrap();
        await_entry(child.pid());
        assert_eq!(child.try_wait().unwrap(), None);
        assert_eq!(child.cancel().unwrap(), Outcome::Signaled(9));
        assert_eq!(child.cancel().unwrap(), Outcome::Signaled(9));
        assert_eq!(child.wait().unwrap(), Outcome::Signaled(9));
        let child = spawn(&request("spin")).unwrap();
        await_entry(child.pid());
        drop(child);
        let mut child = spawn(&request("spin")).unwrap();
        await_entry(child.pid());
        assert_eq!(unsafe { signal(2, 2) }, 0);
        assert_eq!(unsafe { signal(2, 3) }, 0);
        assert_eq!(child.wait(), Err(Error::Interrupted(2)));
        assert_eq!(unsafe { signal(2, 0) }, 0);
        assert_eq!(unsafe { signal(2, 2) }, 0);
        assert_eq!(unsafe { signal(2, 3) }, 0);
        assert_eq!(
            resolve_executable("fixture", Some("/bin"), "/"),
            Err(Error::Interrupted(2))
        );
        assert_eq!(unsafe { signal(2, 0) }, 0);
        println!("CLEANUP_OK");
    }

    fn await_entry(pid: u32) {
        let mut subscription = [0u8; 16];
        subscription[..4].copy_from_slice(&6u32.to_le_bytes());
        subscription[4..8].copy_from_slice(&pid.to_le_bytes());
        let mut output = [0u8; 16];
        loop {
            let result = unsafe { start_status(pid) };
            if result == 0 {
                return;
            }
            assert_eq!(result, -6);
            assert!(unsafe { poll(subscription.as_ptr(), 1, -1, output.as_mut_ptr()) } >= 0);
        }
    }

    fn inspect() {
        assert_eq!(
            std::env::args().collect::<Vec<_>>(),
            ["custom argv0", "inspect", "", "a b\n雪"]
        );
        assert_eq!(
            std::env::vars().collect::<BTreeMap<_, _>>(),
            BTreeMap::from([("ONLY".into(), "exact=value".into())])
        );
        assert_eq!(std::env::current_dir().unwrap().to_str(), Some("/"));
        assert_eq!(
            std::fs::read_to_string("/workspace/probe").unwrap(),
            "shared filesystem"
        );
        assert_eq!(unsafe { write(3, b"FD3_OK\n".as_ptr(), 7) }, 7);
        assert_eq!(
            unsafe { write(1_000_000, b"HIGH_FD_OK\n".as_ptr(), 11) },
            11
        );
        println!("INSPECT_OK");
    }

    fn closed() {
        for fd in 0..=2 {
            assert_eq!(unsafe { fd_kind(fd) }, -8);
        }
        assert_eq!(
            unsafe { write(1_000_000, b"CLOSED_STDIO_OK\n".as_ptr(), 16) },
            16
        );
    }

    fn leader() {
        let mut encoded: serde_json::Value =
            serde_json::from_slice(&request("spin").encode().unwrap()).unwrap();
        encoded["job"] = serde_json::json!(unsafe { job_of(0) });
        let bytes = serde_json::to_vec(&encoded).unwrap();
        let pid = unsafe { raw_spawn(bytes.as_ptr(), bytes.len()) };
        assert!(pid > 0);
        await_entry(u32::try_from(pid).unwrap());
        std::fs::write("/workspace/grandchild.ready", b"ready").unwrap();
        // Exit without waiting. The outer consumer's job owns the orphan.
    }

    fn descendant_cleanup() {
        let mut child = spawn(&request("leader")).unwrap();
        let mut subscription = [0u8; 16];
        subscription[..4].copy_from_slice(&2u32.to_le_bytes());
        subscription[4..8].copy_from_slice(&child.pid().to_le_bytes());
        let mut output = [0u8; 16];
        assert_eq!(
            unsafe { poll(subscription.as_ptr(), 1, -1, output.as_mut_ptr()) },
            1
        );
        assert_eq!(
            std::fs::read("/workspace/grandchild.ready").unwrap(),
            b"ready"
        );
        assert_eq!(child.try_wait().unwrap(), None);
        // The leader really exited zero; SIGKILL only retires its live member.
        assert_eq!(child.cancel().unwrap(), Outcome::Exited(0));
        println!("DESCENDANT_OK");
    }

    fn spin() {
        loop {
            let _ = unsafe { interrupted() };
        }
    }
}
