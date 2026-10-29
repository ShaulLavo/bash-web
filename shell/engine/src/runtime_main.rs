//! Persistent interactive WASI shell. Host stdin/stdout are runtime_proc endpoints;
//! blocking preview1 fd_read/fd_write are never used by the shell's reactor.
#[cfg(target_os = "wasi")]
mod terminal;
#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("shell-runtime requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}
#[cfg(target_os = "wasi")]
fn main() {
    guest::main();
}

#[cfg(target_os = "wasi")]
mod guest {
    use super::terminal::{Action, Editor};
    use futures::FutureExt;
    use shell_engine::{
        Limits, Session,
        executor::{Cancel, Executor},
        io::{Endpoint, IoError},
        runtime::{Runtime, WasiAbi},
    };
    use std::{cell::RefCell, rc::Rc};
    #[link(wasm_import_module = "shell_terminal")]
    unsafe extern "C" {
        fn phase(value: i32);
        fn columns() -> i32;
    }
    fn set_phase(value: i32) {
        unsafe {
            phase(value);
        }
    }
    fn report(error: impl std::fmt::Display) -> ! {
        eprintln!("shell-runtime: {error}");
        std::process::exit(2);
    }
    enum Startup {
        Interactive,
        Command {
            source: String,
            name: String,
            args: Vec<String>,
        },
        File {
            name: String,
            args: Vec<String>,
        },
    }
    fn startup(mut args: impl Iterator<Item = String>) -> Startup {
        let program = args.next().unwrap_or_else(|| usage());
        match args.next() {
            None => Startup::Interactive,
            Some(flag) if flag == "-i" && args.next().is_none() => Startup::Interactive,
            Some(flag) if flag == "-c" => {
                let source = args.next().unwrap_or_else(|| usage());
                let name = args.next().unwrap_or(program);
                Startup::Command {
                    source,
                    name,
                    args: args.collect(),
                }
            }
            Some(name) if !name.starts_with('-') => Startup::File {
                name,
                args: args.collect(),
            },
            _ => usage(),
        }
    }
    fn usage() -> ! {
        report("usage: shell-runtime [-i | -c SCRIPT [NAME [ARG...]] | FILE [ARG...]]")
    }
    pub fn main() {
        let startup = startup(std::env::args());
        let abi = Rc::new(
            WasiAbi::new()
                .unwrap_or_else(|errno| report(format!("missing root preopen (errno {errno})"))),
        );
        abi.handle_interrupts()
            .unwrap_or_else(|errno| report(format!("signal setup errno {errno}")));
        let executor = Executor::new();
        let runtime = Runtime::new(abi, executor.clone());
        let session = Rc::new(Session::new(
            executor.clone(),
            Rc::new(runtime.clone()),
            Rc::new(runtime.clone()),
            Limits::default(),
        ));
        {
            let state = session.state();
            let mut state = state.borrow_mut();
            state.interactive = matches!(startup, Startup::Interactive);
            state.inherit_environment(std::env::vars());
            state.command_string = matches!(startup, Startup::Command { .. });
            if let Ok(cwd) = std::env::var("PWD") {
                state.cwd = cwd;
            }
        }
        // Only an interactive shell gives each command its own job; `-c` and scripts keep theirs.
        runtime.set_job_control(matches!(startup, Startup::Interactive));
        let fds = runtime.take_stdio().unwrap_or_else(|error| report(error));
        session
            .set_descriptors(fds)
            .unwrap_or_else(|error| report_runtime(&session, error));
        let editor_cancel = Rc::new(RefCell::new(Cancel::new()));
        let shell = session.clone();
        let input_cancel = editor_cancel.clone();
        let root = executor.spawn(async move {
            let result = run(shell.clone(), startup, input_cancel).await;
            set_phase(0);
            shell.shutdown().await;
            result
        });
        loop {
            if runtime.take_interrupt() {
                session.interrupt();
                editor_cancel.borrow().cancel();
            }
            let turn = executor.drive(64);
            if root.is_finished() {
                break;
            }
            // A zero-time reactor scan between busy turns prevents a yielding
            // builtin from starving ready process/pipe events. Idle poll is the
            // ONLY blocking operation; interruption is also checked in budgets.
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .unwrap_or_else(|errno| report_runtime(&session, format!("poll errno {errno}")));
        }
        let status = root.now_or_never().unwrap();
        // Session shutdown awaited every owned job. Finish host-owned cleanup
        // tasks created by dropped ProcessGroup guards before ending this guest.
        loop {
            let turn = executor.drive(64);
            if turn.pending == 0 {
                break;
            }
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .unwrap_or_else(|errno| {
                    report_runtime(&session, format!("cleanup poll errno {errno}"))
                });
        }
        std::process::exit(status);
    }
    fn report_runtime(session: &Session, error: impl std::fmt::Display) -> ! {
        if let Some(endpoint) = session.descriptor(2) {
            let bytes = format!("shell-runtime: {error}\n");
            let _ = endpoint.write(bytes.as_bytes()).now_or_never();
        }
        std::process::exit(2);
    }
    async fn write(endpoint: &Endpoint, bytes: &[u8]) -> Result<(), IoError> {
        endpoint.write_all(bytes, &Cancel::new()).await
    }
    async fn diagnostic(session: &Session, bytes: &[u8]) {
        if let Some(endpoint) = session.descriptor(2) {
            let _ = write(&endpoint, bytes).await;
        }
    }
    async fn run(session: Rc<Session>, startup: Startup, input_cancel: Rc<RefCell<Cancel>>) -> i32 {
        let job = match startup {
            Startup::Interactive => return interactive(session, input_cancel).await,
            Startup::Command { source, name, args } => {
                set_phase(2);
                session
                    .set_arguments(name, args)
                    .and_then(|()| session.start(&source))
            }
            Startup::File { name, args } => {
                set_phase(2);
                session.start_file(name, args)
            }
        };
        match job {
            Ok(job) => job.await,
            Err(error) => {
                diagnostic(&session, format!("shell: {error}\n").as_bytes()).await;
                error.status()
            }
        }
    }
    struct PromptRead<'a> {
        editor: &'a mut Editor,
        prompt: &'a str,
        input: &'a Endpoint,
        output: &'a Endpoint,
        cancel: &'a RefCell<Cancel>,
        skip_lf: &'a mut bool,
    }
    impl PromptRead<'_> {
        async fn paint(&mut self, byte: u8) -> Result<Action, IoError> {
            self.editor
                .resize(self.prompt, unsafe { columns() }.max(2) as usize);
            match self.editor.feed(byte) {
                Action::Echo(byte) => {
                    write(self.output, &[byte]).await?;
                    self.editor.echoed(byte);
                }
                Action::Redraw => write(self.output, &self.editor.redraw(self.prompt)).await?,
                Action::Bell => write(self.output, b"\x07").await?,
                action => return Ok(action),
            }
            Ok(Action::None)
        }
        async fn read(&mut self) -> Result<Action, IoError> {
            loop {
                let mut byte = [0];
                let cancel = self.cancel.borrow().clone();
                match self.input.read_cancelled(&mut byte, &cancel).await {
                    Ok(0) => return Ok(Action::Eof),
                    Err(IoError::Cancelled) => return Ok(Action::Interrupt),
                    Err(error) => return Err(error),
                    Ok(_) => {}
                }
                if std::mem::take(self.skip_lf) && byte[0] == b'\n' {
                    continue;
                }
                let action = self.paint(byte[0]).await?;
                if matches!(action, Action::Submit(_)) {
                    *self.skip_lf = byte[0] == b'\r';
                }
                if action != Action::None {
                    return Ok(action);
                }
            }
        }
    }
    async fn finish_prompt(
        session: &Session,
        editor: &mut Editor,
        output: &Endpoint,
        action: Result<Action, IoError>,
    ) -> Result<Option<Vec<u8>>, i32> {
        write(output, b"\x1b[?2004l").await.map_err(|_| 1)?;
        match action {
            Ok(Action::Submit(source)) => {
                write(output, b"\r\n").await.map_err(|_| 1)?;
                Ok(Some(source))
            }
            Ok(Action::Interrupt) => {
                session.state().borrow_mut().publish_status(130);
                editor.clear();
                write(output, b"^C\r\n").await.map_err(|_| 1)?;
                Ok(None)
            }
            Ok(Action::Eof) => {
                let _ = write(output, b"\r\n").await;
                Err(session.state().borrow().status())
            }
            Err(_) => Err(1),
            Ok(_) => unreachable!("prompt reader returns a command, interrupt or EOF"),
        }
    }
    async fn interactive(session: Rc<Session>, input_cancel: Rc<RefCell<Cancel>>) -> i32 {
        let mut editor = Editor::default();
        let mut skip_lf = false;
        loop {
            let (Some(input), Some(output)) = (session.descriptor(0), session.descriptor(1)) else {
                return 1;
            };
            *input_cancel.borrow_mut() = Cancel::new();
            let prompt = session
                .state()
                .borrow()
                .bindings()
                .get("PS1")
                .map(ToString::to_string)
                .unwrap_or_else(|| "$ ".to_owned());
            editor.begin(&prompt, unsafe { columns() }.max(2) as usize);
            if write(&output, b"\x1b[?2004h").await.is_err() {
                return 1;
            }
            if write(&output, prompt.as_bytes()).await.is_err() {
                let _ = write(&output, b"\x1b[?2004l").await;
                return 1;
            }
            set_phase(1);
            let action = PromptRead {
                editor: &mut editor,
                prompt: &prompt,
                input: &input,
                output: &output,
                cancel: &input_cancel,
                skip_lf: &mut skip_lf,
            }
            .read()
            .await;
            let source = match finish_prompt(&session, &mut editor, &output, action).await {
                Ok(source) => source,
                Err(code) => return code,
            };
            drop(input);
            drop(output);
            let Some(source) = source else { continue };
            let source = match String::from_utf8(source) {
                Ok(source) => source,
                Err(_) => {
                    diagnostic(&session, b"shell: command is not UTF-8\n").await;
                    continue;
                }
            };
            if source.trim().is_empty() {
                continue;
            }
            set_phase(2);
            match session.start(&source) {
                Ok(job) => {
                    let code = job.await;
                    if session.exit_requested() {
                        return code;
                    }
                }
                Err(error) => {
                    diagnostic(&session, format!("shell: {error}\n").as_bytes()).await;
                    session.state().borrow_mut().publish_status(error.status());
                }
            }
        }
    }
}
