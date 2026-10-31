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
    use super::terminal::{Action, Editor, Geometry, Mode};
    use futures::FutureExt;
    use shell_engine::{
        Limits, Session,
        executor::{Cancel, Executor},
        io::{Endpoint, IoError},
        runtime::{Runtime, WasiAbi},
    };
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        time::Instant,
    };
    #[link(wasm_import_module = "shell_terminal")]
    unsafe extern "C" {
        fn phase(value: i32, status: i32);
        fn columns() -> i32;
        fn rows() -> i32;
        fn prompt_names(output: *mut u8, capacity: usize) -> i32;
        fn prompt(
            turn: u32,
            context: *const u8,
            length: usize,
            output: *mut u8,
            capacity: usize,
        ) -> i32;
        fn prompt_update(turn: u32, output: *mut u8, capacity: usize) -> i32;
        fn output_position() -> i32;
    }
    fn set_phase(value: i32, status: i32) {
        unsafe {
            phase(value, status);
        }
    }
    fn geometry() -> Geometry {
        let (columns, rows) = unsafe { (columns(), rows()) };
        Geometry::new(columns.max(2) as usize, rows.max(2) as usize)
    }
    fn report(error: impl std::fmt::Display) -> ! {
        eprintln!("shell-runtime: {error}");
        std::process::exit(2);
    }
    struct Interactive {
        mode: Mode,
        /// The page draws each prompt (`--prompt-host`).
        prompt_host: bool,
    }
    enum Startup {
        Interactive(Interactive),
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
            None => Startup::Interactive(Interactive {
                mode: Mode::Bash,
                prompt_host: false,
            }),
            Some(flag) if flag == "-i" => Startup::Interactive(interactive_options(args)),
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
    fn interactive_options(mut args: impl Iterator<Item = String>) -> Interactive {
        let mut options = Interactive {
            mode: Mode::Bash,
            prompt_host: false,
        };
        let mut flag = args.next();
        if flag.as_deref() == Some("--line-editor") {
            options.mode = match args.next().as_deref() {
                Some("bash") => Mode::Bash,
                Some("zsh") => Mode::Zsh,
                _ => usage(),
            };
            flag = args.next();
        }
        if flag.as_deref() == Some("--prompt-host") {
            options.prompt_host = true;
            flag = args.next();
        }
        if flag.is_some() {
            usage();
        }
        options
    }
    fn usage() -> ! {
        report(
            "usage: shell-runtime [-i [--line-editor bash|zsh] [--prompt-host] | -c SCRIPT [NAME [ARG...]] | FILE [ARG...]]",
        )
    }
    pub fn main() {
        let startup = startup(std::env::args());
        let abi = Rc::new(
            WasiAbi::new()
                .unwrap_or_else(|errno| report(format!("missing root preopen (errno {errno})"))),
        );
        abi.handle_interrupts()
            .unwrap_or_else(|errno| report(format!("signal setup errno {errno}")));
        let prompt_host = matches!(
            startup,
            Startup::Interactive(Interactive {
                prompt_host: true,
                ..
            })
        );
        if prompt_host {
            abi.handle_window_changes()
                .unwrap_or_else(|errno| report(format!("signal setup errno {errno}")));
        }
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
            state.interactive = matches!(startup, Startup::Interactive(_));
            state.inherit_environment(std::env::vars());
            state.command_string = matches!(startup, Startup::Command { .. });
            if let Ok(cwd) = std::env::var("PWD") {
                state.cwd = cwd;
            }
        }
        // Only an interactive shell gives each command its own job; `-c` and scripts keep theirs.
        runtime.set_job_control(matches!(startup, Startup::Interactive(_)));
        let fds = runtime.take_stdio().unwrap_or_else(|error| report(error));
        session
            .set_descriptors(fds)
            .unwrap_or_else(|error| report_runtime(&session, error));
        let editor_cancel = Rc::new(RefCell::new(Cancel::new()));
        let wake = Rc::new(Cell::new(Wake::None));
        let shell = session.clone();
        let input = Input {
            cancel: editor_cancel.clone(),
            wake: wake.clone(),
        };
        let root = executor.spawn(async move {
            let result = run(shell.clone(), startup, input).await;
            set_phase(0, result);
            shell.shutdown().await;
            result
        });
        loop {
            if runtime.take_interrupt() {
                session.interrupt();
                wake.set(Wake::Interrupt);
                editor_cancel.borrow().cancel();
            }
            if prompt_host && runtime.take_window_change() && wake.get() == Wake::None {
                wake.set(Wake::Prompt);
                editor_cancel.borrow().cancel();
            }
            let turn = executor.drive(64);
            if session.take_delegated_interrupt() {
                set_phase(-1, 0);
            }
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
    async fn run(session: Rc<Session>, startup: Startup, input: Input) -> i32 {
        let job = match startup {
            Startup::Interactive(options) => return interactive(session, input, options).await,
            Startup::Command { source, name, args } => {
                set_phase(2, session.state().borrow().status());
                session
                    .set_arguments(name, args)
                    .and_then(|()| session.start(&source))
            }
            Startup::File { name, args } => {
                set_phase(2, session.state().borrow().status());
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
    /// Why the prompt reader's input read was cancelled.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Wake {
        None,
        /// SIGWINCH: the page pushed newer prompt text, or the terminal resized.
        Prompt,
        /// SIGINT wins over a pending prompt wake.
        Interrupt,
    }
    struct Input {
        cancel: Rc<RefCell<Cancel>>,
        wake: Rc<Cell<Wake>>,
    }
    /// Writes `value` as a JSON string. serde_json already carries the escaping rules.
    fn json_string(json: &mut Vec<u8>, value: &str) {
        let _ = serde_json::to_writer(&mut *json, value);
    }
    const PROMPT_BYTES: usize = 8 * 1024;
    const NAME_BYTES: usize = 1024;
    /// The page draws the prompt (`--prompt-host`). Buffers are allocated once.
    struct PromptHost {
        turn: u32,
        names: Vec<u8>,
        text: Vec<u8>,
        duration_ms: Option<u64>,
        /// The bridge's output counter after this editor's last write. Anything else
        /// moving it means the editor no longer knows where the prompt is.
        written: Cell<Option<i32>>,
    }
    impl PromptHost {
        fn new() -> Self {
            Self {
                turn: 0,
                names: vec![0; NAME_BYTES],
                text: vec![0; PROMPT_BYTES],
                duration_ms: None,
                written: Cell::new(None),
            }
        }
        /// The provider's text for the next prompt, or `None` to draw PS1.
        fn render(&mut self, session: &Session, ps1: &str) -> Option<String> {
            self.turn += 1;
            self.written.set(None);
            let names = unsafe { prompt_names(self.names.as_mut_ptr(), self.names.len()) };
            let names = &self.names[..usize::try_from(names).unwrap_or(0)];
            // The page's PromptContext: columns, rows and the editor mode come from
            // the page, which already knows them.
            let state = session.state();
            let state = state.borrow();
            let mut json = b"{\"cwd\":".to_vec();
            json_string(&mut json, &state.cwd);
            let statuses: Vec<_> = state.pipeline_status().iter().map(i32::to_string).collect();
            let duration = self
                .duration_ms
                .take()
                .map_or("null".into(), |ms| ms.to_string());
            json.extend_from_slice(
                format!(
                    ",\"status\":{},\"pipestatus\":[{}],\"duration_ms\":{duration},\"jobs\":{},\"ps1\":",
                    state.status(),
                    statuses.join(","),
                    session.background_jobs(),
                )
                .as_bytes(),
            );
            json_string(&mut json, ps1);
            json.extend_from_slice(b",\"variables\":{");
            let bindings = state.bindings();
            let variables = names
                .split(|&byte| byte == b',')
                .filter_map(|name| std::str::from_utf8(name).ok())
                .filter_map(|name| Some((name, bindings.get(name)?.as_str())));
            for (index, (name, value)) in variables.enumerate() {
                if index > 0 {
                    json.push(b',');
                }
                json_string(&mut json, name);
                json.push(b':');
                json_string(&mut json, value);
            }
            json.extend_from_slice(b"}}");
            drop(state);
            let length = unsafe {
                prompt(
                    self.turn,
                    json.as_ptr(),
                    json.len(),
                    self.text.as_mut_ptr(),
                    self.text.len(),
                )
            };
            let length = usize::try_from(length).ok()?;
            Some(String::from_utf8_lossy(&self.text[..length]).into_owned())
        }
        /// Newer text the page pushed for this turn's prompt, applied at most once.
        fn update(&mut self) -> Option<&[u8]> {
            let length =
                unsafe { prompt_update(self.turn, self.text.as_mut_ptr(), self.text.len()) };
            Some(&self.text[..usize::try_from(length).ok()?])
        }
        /// Whether anything but the editor wrote since the editor's last write.
        fn moved(&self) -> bool {
            self.written
                .get()
                .is_some_and(|written| written != unsafe { output_position() })
        }
        /// Writes for the editor and reports whether only the editor wrote since its
        /// previous write. Two atomic loads per write.
        async fn write(&self, output: &Endpoint, bytes: &[u8]) -> Result<bool, IoError> {
            let before = unsafe { output_position() };
            let alone = self.written.get().is_none_or(|written| written == before);
            write(output, bytes).await?;
            let after = unsafe { output_position() };
            let expected = before.wrapping_add(bytes.len() as i32);
            self.written.set(Some(after));
            Ok(alone && after == expected)
        }
    }
    struct PromptRead<'a> {
        editor: &'a mut Editor,
        input: &'a Endpoint,
        output: &'a Endpoint,
        cancel: &'a RefCell<Cancel>,
        wake: &'a Cell<Wake>,
        host: Option<&'a mut PromptHost>,
        skip_lf: &'a mut bool,
    }
    impl PromptRead<'_> {
        async fn write(&mut self, bytes: &[u8]) -> Result<(), IoError> {
            let Some(host) = &self.host else {
                return write(self.output, bytes).await;
            };
            if !host.write(self.output, bytes).await? {
                self.editor.foreign_output();
            }
            Ok(())
        }
        async fn paint(&mut self, byte: u8) -> Result<Action, IoError> {
            self.editor.resize(geometry());
            match self.editor.feed(byte) {
                Action::Echo(byte) => {
                    self.write(&[byte]).await?;
                    self.editor.echoed(byte);
                }
                Action::Redraw => {
                    let bytes = self.editor.redraw();
                    self.write(&bytes).await?;
                }
                Action::Bell => self.write(b"\x07").await?,
                action => return Ok(action),
            }
            Ok(Action::None)
        }
        /// Applies text the page pushed for this prompt, if any, and recounts a resize.
        async fn refresh(&mut self) -> Result<(), IoError> {
            let Some(host) = self.host.as_deref_mut() else {
                return Ok(());
            };
            self.editor.resize(geometry());
            if host.moved() {
                self.editor.foreign_output();
            }
            let Some(prompt) = host.update() else {
                return Ok(());
            };
            let Some(bytes) = self.editor.replace_prompt(prompt) else {
                return Ok(());
            };
            self.write(&bytes).await
        }
        async fn read(&mut self) -> Result<Action, IoError> {
            // The page may have pushed before this prompt was drawn.
            self.refresh().await?;
            loop {
                let mut byte = [0];
                let cancel = self.cancel.borrow().clone();
                match self.input.read_cancelled(&mut byte, &cancel).await {
                    Ok(0) => return Ok(Action::Eof),
                    Err(IoError::Cancelled) if self.wake.get() == Wake::Prompt => {
                        self.wake.set(Wake::None);
                        *self.cancel.borrow_mut() = Cancel::new();
                        self.refresh().await?;
                        continue;
                    }
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
                write(output, &editor.finish(geometry(), false))
                    .await
                    .map_err(|_| 1)?;
                Ok(Some(source))
            }
            Ok(Action::Interrupt) => {
                session.state().borrow_mut().publish_status(130);
                editor.clear();
                write(output, &editor.finish(geometry(), true))
                    .await
                    .map_err(|_| 1)?;
                Ok(None)
            }
            Ok(Action::Eof) => {
                let _ = write(output, &editor.finish(geometry(), false)).await;
                Err(session.state().borrow().status())
            }
            Err(_) => Err(1),
            Ok(_) => unreachable!("prompt reader returns a command, interrupt or EOF"),
        }
    }
    async fn interactive(session: Rc<Session>, input: Input, options: Interactive) -> i32 {
        let mut editor = Editor::new(options.mode);
        let mut host = options.prompt_host.then(PromptHost::new);
        let mut skip_lf = false;
        loop {
            let (Some(stdin), Some(output)) = (session.descriptor(0), session.descriptor(1)) else {
                return 1;
            };
            *input.cancel.borrow_mut() = Cancel::new();
            input.wake.set(Wake::None);
            let ps1 = session
                .state()
                .borrow()
                .bindings()
                .get("PS1")
                .map(ToString::to_string)
                .unwrap_or_else(|| "$ ".to_owned());
            let prompt = host
                .as_mut()
                .and_then(|host| host.render(&session, &ps1))
                .unwrap_or(ps1);
            editor.begin(&prompt, geometry());
            if write(&output, b"\x1b[?2004h").await.is_err() {
                return 1;
            }
            let drawn = match &host {
                Some(host) => host.write(&output, prompt.as_bytes()).await.map(|alone| {
                    if !alone {
                        editor.foreign_output();
                    }
                }),
                None => write(&output, prompt.as_bytes()).await,
            };
            if drawn.is_err() {
                let _ = write(&output, b"\x1b[?2004l").await;
                return 1;
            }
            set_phase(1, session.state().borrow().status());
            let action = PromptRead {
                editor: &mut editor,
                input: &stdin,
                output: &output,
                cancel: &input.cancel,
                wake: &input.wake,
                host: host.as_mut(),
                skip_lf: &mut skip_lf,
            }
            .read()
            .await;
            let source = match finish_prompt(&session, &mut editor, &output, action).await {
                Ok(source) => source,
                Err(code) => return code,
            };
            drop(stdin);
            drop(output);
            let Some(source) = source else { continue };
            let source = match String::from_utf8(source) {
                Ok(source) => source,
                Err(_) => {
                    diagnostic(&session, b"shell: command is not UTF-8\n").await;
                    session.state().borrow_mut().publish_status(2);
                    continue;
                }
            };
            if source.trim().is_empty() {
                continue;
            }
            set_phase(2, session.state().borrow().status());
            let started = Instant::now();
            match session.start(&source) {
                Ok(job) => {
                    let code = job.await;
                    if let Some(host) = &mut host {
                        host.duration_ms = Some(started.elapsed().as_millis() as u64);
                    }
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
