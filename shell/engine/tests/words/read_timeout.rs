use super::*;
use shell_engine::io::{DescriptorKind, HostEndpoint, IoError, OpenOptions, pipe};
use std::{
    cell::Cell,
    time::{Duration, Instant},
};

fn install(rig: &Rig, input: Endpoint) {
    let mut fds = FdTable::default();
    fds.insert(0, input);
    fds.insert(1, Endpoint::null());
    fds.insert(2, Endpoint::null());
    rig.shell.set_descriptors(fds).unwrap();
}

fn arm(rig: &Rig, source: &str) -> JoinHandle<i32> {
    let job = rig.shell.start(source).unwrap();
    for _ in 0..1000 {
        rig.ex.drive(1);
        if rig.ex.next_deadline().is_some() {
            return job;
        }
        assert!(!job.is_finished(), "read ended before arming its timer");
    }
    panic!("read never armed its timer");
}

fn expire(rig: &Rig) {
    assert_eq!(rig.ex.fire_timers(rig.ex.next_deadline().unwrap()), 1);
}

#[test]
fn read_timeout_zero_observes_without_validation_assignment_or_consumption() {
    for (bytes, closed, expected) in [
        (b"".as_slice(), false, 1),
        (b"abc\n", false, 0),
        (b"", true, 0),
    ] {
        let rig = Rig::new(Limits::default());
        let (input, writer) = pipe();
        assert_eq!(writer.write(bytes).now_or_never(), Some(Ok(bytes.len())));
        let writer = (!closed).then_some(writer);
        install(&rig, input.clone());
        rig.variable("x", "old");
        assert_eq!(rig.run("read -t0 -p ignored -s 1bad x"), expected);
        assert_eq!(rig.value("x").as_deref(), Some("old"));
        assert!(rig.ex.next_deadline().is_none());
        let mut buffer = [0; 8];
        if expected == 0 {
            assert_eq!(
                input.read(&mut buffer).now_or_never(),
                Some(Ok(bytes.len()))
            );
            assert_eq!(&buffer[..bytes.len()], bytes);
        }
        drop(writer);
    }
}

#[test]
fn read_timeout_zero_descriptor_matrix() {
    for source in [
        "read -t0 1bad",
        "read -t0 1bad <<<data",
        "read -t0 -u3 3>file",
        "read -t0 -u0",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
    }
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("read -t0 -u99"), 1);
    assert_eq!(rig.run("read -t0 -u1"), 1);
    let (input, writer) = pipe();
    assert_eq!(writer.write(b"data").now_or_never(), Some(Ok(4)));
    install(&rig, writer.clone());
    assert_eq!(rig.run("read -t0"), 1);
    drop(input);
    assert_eq!(rig.run("read -t0"), 0);
}

#[test]
fn read_timeout_numeric_option_order_and_tmout_override() {
    check_output(
        "x=old; read -tbad -t0 x <<<hello; printf '%s[%s]\\n' \"$?\" \"$x\"",
        "1[old]\n",
    );
    check_output("read -t; printf '%s\\n' \"$?\"", "2\n");
    check_output("read -t1 -t0 1bad; printf '%s\\n' \"$?\"", "0\n");
    check_output("read -t0.5 x; printf '%s[%s]\\n' \"$?\" \"$x\"", "1[]\n");
    check_output(
        "x=old; read -t-0.5 x <<<hello; printf '%s[%s]\\n' \"$?\" \"$x\"",
        "1[old]\n",
    );
    check_output(
        "TMOUT=0.2; x=old; read -t0 x <<<hello; printf '%s[%s]\\n' \"$?\" \"$x\"",
        "0[old]\n",
    );
}

#[test]
fn read_timeout_assigns_partial_records_and_preserves_assignment_precedence() {
    for (options, bytes, names, values, status) in [
        ("", "", "x", vec![("x", "")], 142),
        ("", "ab", "x", vec![("x", "ab")], 142),
        ("", "a b c", "x y", vec![("x", "a"), ("y", "b c")], 142),
        ("-rN5", "ab", "x", vec![("x", "ab")], 142),
        ("-d ''", "ab", "x", vec![("x", "ab")], 142),
        ("", "ab", "x", vec![("x", "old")], 1),
    ] {
        let rig = Rig::new(Limits::default());
        let (input, writer) = pipe();
        assert_eq!(
            writer.write(bytes.as_bytes()).now_or_never(),
            Some(Ok(bytes.len()))
        );
        install(&rig, input);
        rig.variable("x", "old");
        if status == 1 {
            assert_eq!(rig.run("readonly x"), 0);
        }
        let job = arm(&rig, &format!("read -t60 {options} {names}"));
        expire(&rig);
        assert_eq!(rig.finish(job), status);
        for (name, expected) in values {
            assert_eq!(rig.value(name).as_deref(), Some(expected));
        }
        assert!(rig.ex.next_deadline().is_none());
        drop(writer);
    }
}

#[test]
fn read_timeout_already_fired_wins_queued_bytes_and_cancel_wins_expiry() {
    for cancelled in [false, true] {
        let rig = Rig::new(Limits::default());
        let (input, writer) = pipe();
        install(&rig, input.clone());
        rig.variable("x", "old");
        let job = arm(&rig, "read -t60 x");
        expire(&rig);
        assert_eq!(writer.write(b"queued\n").now_or_never(), Some(Ok(7)));
        if cancelled {
            rig.shell.interrupt();
        }
        assert_eq!(rig.finish(job), if cancelled { 130 } else { 142 });
        assert_eq!(
            rig.value("x").as_deref(),
            Some(if cancelled { "old" } else { "" })
        );
        assert!(rig.ex.next_deadline().is_none());
        let mut bytes = [0; 7];
        assert_eq!(input.read(&mut bytes).now_or_never(), Some(Ok(7)));
        assert_eq!(&bytes, b"queued\n");
    }
}

#[test]
fn read_timeout_tmout_uses_positive_nameref_and_ignores_other_values() {
    let rig = Rig::new(Limits::default());
    let (input, _writer) = pipe();
    install(&rig, input);
    assert_eq!(rig.run("delay=60; declare -n TMOUT=delay"), 0);
    let job = arm(&rig, "read x");
    expire(&rig);
    assert_eq!(rig.finish(job), 142);
    for value in ["", "bad", "0", "-1", "4294967296"] {
        rig.variable("delay", value);
        let job = rig.shell.start("read x").unwrap();
        rig.ex.drive(128);
        assert!(!job.is_finished());
        assert!(rig.ex.next_deadline().is_none());
        rig.shell.interrupt();
        assert_eq!(rig.finish(job), 130);
    }
}

struct Stream {
    input: Endpoint,
    reads: Rc<Cell<usize>>,
    executor: Executor,
    fire_on_read: bool,
}
impl HostEndpoint for Stream {
    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        Ok(DescriptorKind::Terminal)
    }
    fn read_ready(&self) -> Result<bool, IoError> {
        self.input.read_ready()
    }
    fn read<'a>(
        &'a self,
        output: &'a mut [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        async move {
            assert!(
                self.executor.next_deadline().is_some(),
                "timer must be armed before input"
            );
            self.reads.set(self.reads.get() + 1);
            let result = self.input.read(output).await;
            if self.fire_on_read {
                self.executor
                    .fire_timers(self.executor.next_deadline().unwrap());
            }
            result
        }
        .boxed_local()
    }
    fn write<'a>(
        &'a self,
        _: &'a [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        async { Err(IoError::Unsupported) }.boxed_local()
    }
}

#[test]
fn read_timeout_always_ready_is_armed_and_retains_bytes_returned_during_expiry() {
    for fire_on_read in [false, true] {
        let rig = Rig::new(Limits::default());
        let input = Endpoint::bytes(vec![b'a'; 65536]);
        let reads = Rc::new(Cell::new(0));
        install(
            &rig,
            Endpoint::host(Rc::new(Stream {
                input: input.clone(),
                reads: reads.clone(),
                executor: rig.ex.clone(),
                fire_on_read,
            })),
        );
        let job = rig.shell.start("LC_ALL=C; read -rN65536 -t60 x").unwrap();
        for _ in 0..1000 {
            rig.ex.drive(1);
            if reads.get() != 0 {
                break;
            }
        }
        assert!(reads.get() > 0);
        if !fire_on_read {
            expire(&rig);
        }
        assert_eq!(rig.finish(job), 142);
        let consumed = reads.get() * 4096;
        assert!(consumed > 0 && consumed < 65536);
        assert_eq!(rig.value("x").unwrap().len(), consumed);
        assert!(rig.ex.next_deadline().is_none());
        let mut tail = vec![0; 65536];
        let first = input.read(&mut tail).now_or_never().unwrap().unwrap();
        let second = input
            .read(&mut tail[first..])
            .now_or_never()
            .unwrap()
            .unwrap();
        assert_eq!(first + second, 65536 - consumed);
    }
}

#[test]
fn read_timeout_regular_descriptions_never_register_a_timer() {
    for variant in 0..3 {
        let rig = Rig::new(Limits::default());
        let bytes = vec![b'x'; 65536];
        let input = match variant {
            0 => Endpoint::bytes(bytes),
            1 => Endpoint::bytes(bytes).buffered_source(),
            _ => {
                rig.fs.write_file("/regular", &bytes).unwrap();
                rig.fs.open("/regular", &OpenOptions::default()).unwrap()
            }
        };
        install(&rig, input);
        let job = rig
            .shell
            .start("LC_ALL=C; read -rN65536 -t0.000001 x")
            .unwrap();
        while !job.is_finished() {
            rig.ex.drive(1);
            assert!(rig.ex.next_deadline().is_none());
            assert_eq!(
                rig.ex.fire_timers(Instant::now() + Duration::from_secs(60)),
                0
            );
        }
        assert_eq!(rig.finish(job), 0);
        assert_eq!(rig.value("x").unwrap().len(), 65536);
    }
}

struct ExportedInput {
    input: Endpoint,
    executor: Executor,
    ready: bool,
    reads: Rc<Cell<usize>>,
}
impl HostEndpoint for ExportedInput {
    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        Ok(DescriptorKind::Pipe)
    }
    fn read_ready(&self) -> Result<bool, IoError> {
        Ok(self.ready)
    }
    fn read<'a>(
        &'a self,
        output: &'a mut [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        async move {
            assert!(self.executor.next_deadline().is_none());
            self.reads.set(self.reads.get() + 1);
            self.input.read(output).await
        }
        .boxed_local()
    }
    fn write<'a>(
        &'a self,
        _: &'a [u8],
    ) -> futures::future::LocalBoxFuture<'a, Result<usize, IoError>> {
        async { Err(IoError::Unsupported) }.boxed_local()
    }
}

#[test]
fn read_timeout_exported_bytes_observe_host_but_keep_logical_regular_policy() {
    for ready in [false, true] {
        let rig = Rig::new(Limits::default());
        let bytes = Endpoint::bytes(b"original\n".to_vec());
        let source = bytes.buffered_source();
        let reads = Rc::new(Cell::new(0));
        bytes.export_buffer(&Endpoint::host(Rc::new(ExportedInput {
            input: Endpoint::bytes(b"exported\n".to_vec()),
            executor: rig.ex.clone(),
            ready,
            reads: reads.clone(),
        })));
        install(&rig, bytes);
        assert_eq!(rig.run("x=old; read -t0 x"), if ready { 0 } else { 1 });
        assert_eq!(rig.value("x").as_deref(), Some("old"));
        assert_eq!(reads.get(), 0);
        assert_eq!(rig.run("read -t0.000001 x"), 0);
        assert_eq!(rig.value("x").as_deref(), Some("exported"));
        assert_eq!(reads.get(), 9);
        let mut original = [0; 9];
        assert_eq!(source.read(&mut original).now_or_never(), Some(Ok(9)));
        assert_eq!(&original, b"original\n");
    }
}
