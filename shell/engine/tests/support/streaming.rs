// The seven scenarios from pipelines.acceptance.spec.ts adapted to the real
// engine and an explicitly in-process ProcessHost. These do NOT claim browser,
// Bun, transport interruption or shared-filesystem acceptance for step 1.
use futures::FutureExt;
use shell_engine::{
    Limits, Session,
    executor::{Budget, Cancel, Executor, JoinHandle},
    io::{Capture, Endpoint, FdTable, IoError, MemoryFs, capture},
    process::{InProcessHost, SpawnRequest},
};
use std::{cell::Cell, rc::Rc};

struct Rig {
    ex: Executor,
    host: InProcessHost,
    shell: Session,
    fs: MemoryFs,
    output: Capture,
    fds: FdTable,
    slow: Cancel,
    ticks: Vec<Cancel>,
    written: Rc<Cell<usize>>,
}
impl Rig {
    fn new() -> Self {
        Self::with_limits(Limits::default())
    }
    fn with_limits(limits: Limits) -> Self {
        let line_bytes = limits.line_bytes;
        let ex = Executor::new();
        let host = InProcessHost::new(ex.clone());
        let fs = MemoryFs::new(16 * 1024 * 1024);
        let shell = Session::new(
            ex.clone(),
            Rc::new(host.clone()),
            Rc::new(fs.clone()),
            limits,
        );
        // Stand-in programs live in one explicit directory, including after cd.
        shell
            .state()
            .borrow_mut()
            .assign_parameter("PATH".into(), "/home/guest".into())
            .unwrap();
        let (out, output) = capture(8 * 1024 * 1024);
        let mut fds = FdTable::default();
        fds.insert(0, Endpoint::null());
        fds.insert(1, out.clone());
        fds.insert(2, out);
        shell.set_descriptors(fds.clone()).unwrap();
        let slow = Cancel::new();
        let ticks = vec![Cancel::new(), Cancel::new(), Cancel::new()];
        let written = Rc::new(Cell::new(0));
        let value = Self {
            ex,
            host,
            shell,
            fs,
            output,
            fds,
            slow,
            ticks,
            written,
        };
        value.register();
        register_utilities(&value.host, &value.fs, line_bytes);
        value
    }
    fn register(&self) {
        self.host
            .register("/home/guest/okay", |_, _| async { 0 }.boxed_local());
        let ticks = self.ticks.clone();
        self.host
            .register("/home/guest/ticker", move |req, cancel| {
                let ticks = ticks.clone();
                async move {
                    for (i, gate) in ticks.into_iter().enumerate() {
                        if let Err(e) = req
                            .fds
                            .get(1)
                            .unwrap()
                            .write_all(format!("tick {i}\n").as_bytes(), &cancel)
                            .await
                        {
                            return e.status();
                        }
                        gate.cancelled().await;
                    }
                    futures::future::pending().await
                }
                .boxed_local()
            });
        let written = self.written.clone();
        self.host.register("/home/guest/emit", move |req, cancel| {
            let written = written.clone();
            async move {
                let size = req.argv[1].parse::<usize>().unwrap();
                let output = req.fds.get(1).unwrap();
                let mut offset = 0;
                while offset < size {
                    let n = (size - offset).min(8192);
                    let bytes = vec![(offset / 8192 % 251) as u8; n];
                    if let Err(e) = output.write_all(&bytes, &cancel).await {
                        return e.status();
                    }
                    offset += n;
                    written.set(offset);
                }
                0
            }
            .boxed_local()
        });
        self.host.register("/home/guest/copy", |req, cancel| {
            async move { copy(&req, &cancel, 0, 1).await }.boxed_local()
        });
        self.host.register("/home/guest/fdcat", |req, cancel| {
            async move { copy(&req, &cancel, 4, 3).await }.boxed_local()
        });
        self.host.register("/home/guest/count", |req, cancel| {
            async move { count(&req, &cancel, false).await }.boxed_local()
        });
        self.host.register("/home/guest/verify", |req, cancel| {
            async move { count(&req, &cancel, true).await }.boxed_local()
        });
        let slow = self.slow.clone();
        self.host
            .register("/home/guest/slow-count", move |req, cancel| {
                let slow = slow.clone();
                async move {
                    req.fds
                        .get(2)
                        .unwrap()
                        .write_all(b"READER_WAITING\n", &cancel)
                        .await
                        .unwrap();
                    slow.cancelled().await;
                    count(&req, &cancel, false).await
                }
                .boxed_local()
            });
        self.host.register("/home/guest/filter", |req, cancel| {
            async move {
                let needle = req.argv[1].as_bytes();
                let input = req.fds.get(0).unwrap();
                let output = req.fds.get(1).unwrap();
                let mut buffer = [0; 8192];
                let mut line = Vec::new();
                let mut found = false;
                let mut budget = Budget::default();
                loop {
                    let n = match input.read_cancelled(&mut buffer, &cancel).await {
                        Ok(n) => n,
                        Err(e) => return e.status(),
                    };
                    for &byte in &buffer[..n] {
                        if budget.checkpoint(&cancel).await.is_err() {
                            return 130;
                        }
                        if line.len() >= 65536 {
                            return 2;
                        }
                        line.push(byte);
                        if byte == b'\n' {
                            if needle.is_empty() || line.windows(needle.len()).any(|v| v == needle)
                            {
                                if let Err(e) = output.write_all(&line, &cancel).await {
                                    return e.status();
                                }
                                found = true;
                            }
                            line.clear();
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                if !line.is_empty()
                    && (needle.is_empty() || line.windows(needle.len()).any(|v| v == needle))
                {
                    if let Err(e) = output.write_all(&line, &cancel).await {
                        return e.status();
                    }
                    found = true;
                }
                i32::from(!found)
            }
            .boxed_local()
        });
        for name in ["endless", "handled"] {
            self.host
                .register(format!("/home/guest/{name}"), move |req, cancel| {
                    async move {
                        req.fds
                            .get(2)
                            .unwrap()
                            .write_all(b"PRODUCER_READY\n", &cancel)
                            .await
                            .unwrap();
                        let output = req.fds.get(1).unwrap();
                        loop {
                            if let Err(e) = output.write_all(b"first\n", &cancel).await {
                                return if name == "handled" && e == IoError::BrokenPipe {
                                    23
                                } else {
                                    e.status()
                                };
                            }
                        }
                    }
                    .boxed_local()
                });
        }
        self.host.register("/home/guest/take", |req, cancel| {
            async move {
                let mut byte = [0];
                let input = req.fds.get(0).unwrap();
                let output = req.fds.get(1).unwrap();
                loop {
                    match input.read_cancelled(&mut byte, &cancel).await {
                        Ok(0) => return 0,
                        Ok(_) => {}
                        Err(e) => return e.status(),
                    };
                    if let Err(e) = output.write_all(&byte, &cancel).await {
                        return e.status();
                    }
                    if byte[0] == b'\n' {
                        return 0;
                    }
                }
            }
            .boxed_local()
        });
        self.host.register("/home/guest/hold", |req, cancel| {
            async move {
                req.fds
                    .get(1)
                    .unwrap()
                    .write_all(b"HOLDING\n", &cancel)
                    .await
                    .unwrap();
                futures::future::pending().await
            }
            .boxed_local()
        });
        self.host.register("/home/guest/accumulate", |req, cancel| {
            async move {
                let (sink, _capture) = capture(65536);
                let mut buffer = [0; 8192];
                let input = req.fds.get(0).unwrap();
                loop {
                    let n = match input.read_cancelled(&mut buffer, &cancel).await {
                        Ok(0) => return 0,
                        Ok(n) => n,
                        Err(e) => return e.status(),
                    };
                    if let Err(e) = sink.write_all(&buffer[..n], &cancel).await {
                        return e.status();
                    }
                }
            }
            .boxed_local()
        });
        self.host
            .register("/home/guest/environment", |req, cancel| {
                async move {
                    let text = format!(
                        "{}:{}:{}\n",
                        req.env.get("EXPORTED").map(String::as_str).unwrap_or(""),
                        req.env.contains_key("secret"),
                        req.cwd
                    );
                    match req
                        .fds
                        .get(1)
                        .unwrap()
                        .write_all(text.as_bytes(), &cancel)
                        .await
                    {
                        Ok(()) => 0,
                        Err(e) => e.status(),
                    }
                }
                .boxed_local()
            });
    }
    fn start(&self, script: &str) -> JoinHandle<i32> {
        self.shell.start(script).unwrap()
    }
    fn finish(&self, job: JoinHandle<i32>) -> i32 {
        for _ in 0..200000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            let drive = self.ex.drive(256);
            assert!(
                drive.runnable || job.is_finished(),
                "job unexpectedly parked, output={}",
                self.text()
            );
        }
        panic!("work budget exhausted")
    }
    fn run(&self, script: &str) -> i32 {
        self.finish(self.start(script))
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.bytes()).into_owned()
    }
    fn until(&self, text: &str) {
        for _ in 0..10000 {
            if self.text().contains(text) {
                return;
            }
            self.ex.drive(64);
        }
        panic!("missing {text}: {}", self.text());
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.shell.interrupt();
        let shutdown = self.shell.shutdown();
        futures::pin_mut!(shutdown);
        for _ in 0..10000 {
            self.ex.drive(256);
            if shutdown.as_mut().now_or_never().is_some() {
                self.ex.drive(256);
                assert_eq!(self.host.active_count(), 0);
                assert_eq!(self.host.retained_count(), 0);
                return;
            }
        }
        panic!("session shutdown did not finish");
    }
}
async fn copy(req: &SpawnRequest, cancel: &Cancel, input: u32, output: u32) -> i32 {
    let input = req.fds.get(input).unwrap();
    let output = req.fds.get(output).unwrap();
    let mut buffer = [0; 8192];
    loop {
        let n = match input.read_cancelled(&mut buffer, cancel).await {
            Ok(0) => return 0,
            Ok(n) => n,
            Err(e) => return e.status(),
        };
        if let Err(e) = output.write_all(&buffer[..n], cancel).await {
            return e.status();
        }
    }
}
async fn count(req: &SpawnRequest, cancel: &Cancel, verify: bool) -> i32 {
    let input = req.fds.get(0).unwrap();
    let mut buffer = [0; 8192];
    let mut total = 0;
    let mut lines = 0;
    let mut correct = true;
    loop {
        let n = match input.read_cancelled(&mut buffer, cancel).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return e.status(),
        };
        for (index, &byte) in buffer[..n].iter().enumerate() {
            lines += usize::from(byte == b'\n');
            if verify {
                correct &= byte == ((total + index) / 8192 % 251) as u8;
            }
        }
        total += n;
    }
    let text = if verify {
        format!("COUNT:{total}:{correct}\n")
    } else {
        format!("COUNT:{total}:{lines}\n")
    };
    match req
        .fds
        .get(1)
        .unwrap()
        .write_all(text.as_bytes(), cancel)
        .await
    {
        Ok(()) => 0,
        Err(e) => e.status(),
    }
}

