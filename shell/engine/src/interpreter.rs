//! Original task-oriented interpreter for the engine gate, not a Bashkit
//! interpreter fork. Unsupported syntax returns status 2 rather than guessing.
use crate::commands;
use crate::{
    arithmetic, builtins,
    executor::{Budget, Cancel, Executor, JoinHandle, yield_now},
    expand,
    io::{self, FdTable, FileSystem, OpenOptions},
    parse::{self, ParseFailure},
    process::{GroupId, ProcessError, ProcessGroup, ProcessHost, SpawnRequest},
    state::{FunctionFrame, PrefixFrame, SharedState, State, StoredFunction, absolute},
};
use futures::{FutureExt, future::join_all};
use shell_parser::parser::*;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    rc::Rc,
};

mod builtin_wrapper;
mod command_builtin;
mod conditional;
mod control;
pub(crate) mod eval;
mod file_substitution;
mod function_names;
mod indexed;
mod reader;
mod select;
mod source;
mod trap;
#[cfg(test)]
mod trap_tests;
mod type_builtin;

#[derive(Clone, Debug)]
pub struct Limits {
    pub source_bytes: usize,
    /// Command name + arguments + assignment names, '=' and values, in bytes.
    pub expansion_bytes: usize,
    /// Live PATH/cwd/candidate/request storage, separate from command-word bytes.
    pub path_bytes: usize,
    /// All words, including command name and assignments (no empty AST placeholder).
    pub arguments: usize,
    pub pipeline_stages: usize,
    pub jobs: usize,
    /// Explicit host call-depth policy; usize::MAX means no depth policy.
    /// A positive FUNCNEST binding can impose a tighter dynamic limit.
    pub function_depth: usize,
    /// Session-wide live execution/frame memory, including suspended calls.
    pub execution_bytes: usize,
    pub line_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            source_bytes: 256 * 1024,
            expansion_bytes: 1024 * 1024,
            path_bytes: 1024 * 1024,
            // Bash has no builtin argument count limit; expansion_bytes
            // bounds memory. `{0..10000}` alone needs 10,001 arguments.
            arguments: 65_536,
            pipeline_stages: 128,
            jobs: 128,
            function_depth: usize::MAX,
            execution_bytes: 100_000_000,
            line_bytes: 64 * 1024,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Flow {
    Normal,
    Exit,
    Abort,
    // Unlike isolated errexit, a failed fork aborts the invoking reader even
    // when it happened in a non-last stage of a pipeline.
    SpawnFailed,
    Return,
    Break(usize),
    Continue(usize),
    DiscardReadUnit,
    Resource,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Outcome {
    pub code: i32,
    pub flow: Flow,
}
impl Outcome {
    pub(crate) fn status(code: i32) -> Self {
        Self {
            code: if code == crate::exec::RESOURCE_STATUS {
                2
            } else {
                code
            },
            flow: if code == crate::exec::RESOURCE_STATUS {
                Flow::Resource
            } else {
                Flow::Normal
            },
        }
    }
}
/// Diagnostics for redirect-target failures use the stderr reached so far.
/// Other expansions, including prefix RHSs, use the caller's original stderr.
enum DiagnosticStderr {
    Inherited,
    Redirected(Option<io::Endpoint>),
}

enum WeakStderr {
    Open(io::WeakEndpoint),
    Closed,
}

struct CommandError {
    error: expand::Error,
    stderr: DiagnosticStderr,
    heredoc_status: Option<i32>,
}
impl CommandError {
    fn at_line(mut self, line: Option<usize>) -> Self {
        self.error = self.error.at_line(line);
        self
    }
    fn redirect(
        error: expand::Error,
        stderr: Option<io::Endpoint>,
        heredoc_status: Option<i32>,
    ) -> Self {
        Self {
            error,
            stderr: DiagnosticStderr::Redirected(stderr),
            heredoc_status,
        }
    }
}
impl From<expand::Error> for CommandError {
    fn from(error: expand::Error) -> Self {
        Self {
            error,
            stderr: DiagnosticStderr::Inherited,
            heredoc_status: None,
        }
    }
}
impl From<i32> for CommandError {
    fn from(code: i32) -> Self {
        expand::Error::Status(code).into()
    }
}

type Descriptors = Rc<RefCell<FdTable>>;
const TASK_METADATA_BYTES: usize = 4096;
/// Shared forwarding keeps descendants attached when several isolated scopes
/// finish in a different order. Captured parent handles follow later transfers.
#[derive(Clone)]
struct Scope(Rc<ScopeState>);
struct ScopeState {
    id: u64,
    parent: RefCell<Option<Scope>>,
}
impl Scope {
    fn new(id: u64) -> Self {
        Self(Rc::new(ScopeState {
            id,
            parent: RefCell::new(None),
        }))
    }
    fn resolved(&self) -> Self {
        let mut scope = self.clone();
        loop {
            let parent = scope.0.parent.borrow().clone();
            match parent {
                Some(parent) => scope = parent,
                None => return scope,
            }
        }
    }
    fn resolved_id(&self) -> u64 {
        self.resolved().0.id
    }
    fn forward_to(&self, parent: Scope) {
        // Skip ancestors that already exited. Repeated background hand-offs
        // must not retain an ever-growing chain of otherwise dead scopes.
        *self.0.parent.borrow_mut() = Some(parent.resolved());
    }
}
impl PartialEq for Scope {
    fn eq(&self, other: &Self) -> bool {
        self.resolved_id() == other.resolved_id()
    }
}
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
// Registry identities supply synthetic async handles, never ProcessHost PIDs.
pub(crate) struct JobId(u64);
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobNumber(u64);
#[derive(Clone, Copy)]
pub(crate) enum JobSelector {
    Handle(JobId),
    Number(JobNumber),
}
impl JobSelector {
    pub(crate) fn parse(value: &str) -> Result<Self, i32> {
        match value.strip_prefix('%') {
            Some(number) => number
                .parse()
                .map(|n| Self::Number(JobNumber(n)))
                .map_err(|_| 2),
            None => value.parse().map(|n| Self::Handle(JobId(n))).map_err(|_| 2),
        }
    }
    fn matches(self, id: JobId, job: &Job) -> bool {
        match self {
            Self::Handle(handle) => id == handle && !matches!(job.kind, JobKind::Internal),
            Self::Number(number) => job.kind == JobKind::Background(number),
        }
    }
    fn matches_live(self, id: JobId, job: &Job) -> bool {
        self.matches(id, job) && !matches!(job.kind, JobKind::Completed)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Background(JobNumber),
    ProcessSubstitution,
    /// A completed numeric handle retained until the bounded job table needs
    /// its slot again. Percent-job selectors intentionally do not match it.
    Completed,
    Internal,
}
struct JobLabel {
    text: String,
    _storage: crate::exec::StorageAllocation,
}
struct Job {
    label: Option<Rc<JobLabel>>,
    notified: bool,
    owner: Scope,
    kind: JobKind,
    group: GroupId,
    cancel: Cancel,
    signal: Rc<Cell<Option<i32>>>,
    join: JoinHandle<i32>,
    _allocation: Option<crate::exec::Allocation>,
}
struct Residual {
    owner: Scope,
    cleanup: JoinHandle<Result<(), ProcessError>>,
    // Retries still belong to the invocation that created the descendants.
    lifetime: (Cancel, Rc<Cell<Option<i32>>>),
}
struct Core {
    executor: Executor,
    host: Rc<dyn ProcessHost>,
    fs: Rc<dyn FileSystem>,
    limits: Limits,
    eval_storage: crate::exec::StorageBudget,
    execution_storage: crate::exec::StorageBudget,
    descriptors: Descriptors,
    jobs: RefCell<BTreeMap<JobId, Job>>,
    residuals: RefCell<BTreeMap<GroupId, Residual>>,
    next: Cell<u64>,
    foreground: RefCell<Option<Job>>,
    exit_requested: Cell<bool>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandBoundary {
    Ordinary,
    PipelineStage,
    PipelineSubshell,
    FunctionBody,
}

#[derive(Clone)]
pub(crate) struct Context {
    core: Rc<Core>,
    source: crate::exec::Source,
    reader: crate::exec::ReaderLocation,
    pub cancel: Cancel,
    // The invoking foreground/background command, independent of nested scopes.
    lifetime: (Cancel, Rc<Cell<Option<i32>>>),
    signal: Rc<Cell<Option<i32>>>,
    pub group: GroupId,
    invocation_group: GroupId,
    scope: Scope,
    parameter_error_status: i32,
    compound_child: bool,
    evaluation: crate::exec::Scope,
    loop_depth: usize,
    ignore_errexit: bool,
    command_boundary: CommandBoundary,
}
impl Context {
    fn root(
        core: Rc<Core>,
        source: &str,
        evaluation: crate::exec::Scope,
        group: GroupId,
        cancel: Cancel,
        signal: Rc<Cell<Option<i32>>>,
    ) -> Self {
        Self {
            core,
            source: crate::exec::Source::root(source),
            reader: crate::exec::ReaderLocation::default(),
            lifetime: (cancel.clone(), signal.clone()),
            cancel,
            signal,
            group,
            invocation_group: group,
            scope: Scope::new(0),
            parameter_error_status: 127,
            compound_child: false,
            loop_depth: 0,
            ignore_errexit: false,
            command_boundary: CommandBoundary::Ordinary,
            evaluation,
        }
    }
    fn stop_signal(&self) -> i32 {
        self.signal.get().unwrap_or(2)
    }
    fn cancel_status(&self) -> i32 {
        128 + self.stop_signal()
    }
    /// Runtime executable registration is authoritative; never infer X_OK from open.
    pub(crate) async fn executable_path(&self, path: String, cwd: String) -> Result<bool, i32> {
        match self
            .cancel
            .run(self.core.host.access(path, cwd))
            .await
            .map_err(|_| self.cancel_status())?
        {
            Ok(()) => Ok(true),
            Err(ProcessError::Runtime(2 | 31 | 44 | 54)) => Ok(false),
            Err(_) => Err(2),
        }
    }
    pub(crate) fn fs(&self) -> &dyn FileSystem {
        self.core.fs.as_ref()
    }
    pub(crate) fn limits(&self) -> &Limits {
        &self.core.limits
    }
    pub(crate) fn admit_builtin_buffer(
        &self,
        bytes: usize,
    ) -> Result<crate::exec::Allocation, i32> {
        self.evaluation.admit_execution(bytes)
    }
    fn parser_budget(&self) -> shell_parser::limits::ExecutionBudget {
        let core = self.core.clone();
        let cancel = self.cancel.clone();
        self.evaluation.parser_budget(Some(Rc::new(move || {
            // A synchronous isolated parser may be the only running task when
            // Ctrl+C arrives. Consume it through the current foreground owner,
            // then test this reader's own token without canceling background.
            let foreground = core
                .foreground
                .borrow()
                .as_ref()
                .map(|job| job.cancel.clone());
            if let Some(foreground) = foreground {
                foreground.probe_now();
            }
            cancel.probe_now()
        })))
    }
    pub(crate) fn loop_depth(&self) -> usize {
        self.loop_depth
    }
    fn loop_body(&self) -> Self {
        Self {
            loop_depth: self.loop_depth + 1,
            ..self.clone()
        }
    }
    fn condition(&self) -> Self {
        Self {
            ignore_errexit: true,
            ..self.clone()
        }
    }
    fn isolated(&self) -> Self {
        Self {
            loop_depth: 0,
            scope: Scope::new(self.core.allocate_id()),
            evaluation: self.evaluation.new_task(),
            ..self.clone()
        }
    }
    fn child_error_status(&self, command: &Command) -> i32 {
        if matches!(
            command,
            Command::Simple(_) | Command::Function(_) | Command::Compound(..)
        ) {
            return self.parameter_error_status;
        }
        1
    }
    fn isolated_command(&self, command: &Command) -> Self {
        Self {
            parameter_error_status: self.child_error_status(command),
            compound_child: matches!(command, Command::Compound(..)),
            ..self.isolated()
        }
    }
    fn compound_body(&self) -> Self {
        Self {
            parameter_error_status: if self.compound_child {
                1
            } else {
                self.parameter_error_status
            },
            compound_child: false,
            ..self.clone()
        }
    }
    async fn cleanup_jobs(&self) {
        for job in self
            .core
            .jobs
            .borrow()
            .values()
            .filter(|job| job.owner == self.scope)
        {
            if job.signal.get().is_none() {
                job.signal.set(Some(self.stop_signal()));
            }
            job.cancel.cancel();
        }
        let residuals: Vec<_> = self
            .core
            .residuals
            .borrow()
            .iter()
            .filter(|(_, residual)| residual.owner == self.scope)
            .map(|(&group, residual)| (group, residual.cleanup.clone()))
            .collect();
        // Signal the whole scope before awaiting shell tasks or drains:
        // inherited members in different groups can depend on one another.
        for (group, _) in &residuals {
            let _ = self.core.host.kill_group(*group, self.stop_signal());
        }
        while let Some((id, join)) = self.next_job(None, true) {
            join.await;
            self.core.jobs.borrow_mut().remove(&id);
        }
        for (group, cleanup) in residuals {
            let result = match cleanup.await {
                Ok(()) => Ok(()),
                Err(_) => self.core.host.wait_group(group).await,
            };
            if result.is_ok() {
                self.core.residuals.borrow_mut().remove(&group);
            }
        }
    }
    /// A successful isolated scope leaves asynchronous descendants running.
    /// Transfer their cleanup ownership outward without making them waitable
    /// jobs of the caller. Cancellation still reaps the whole owned subtree.
    async fn finish_scope(&self, parent_scope: Scope) {
        if self.cancel.is_cancelled() {
            self.cleanup_jobs().await;
            return;
        }
        self.core.jobs.borrow_mut().retain(|_, job| {
            if job.owner != self.scope {
                return true;
            }
            job.kind = JobKind::Internal;
            job.label = None;
            !job.join.is_finished()
        });
        self.scope.forward_to(parent_scope);
    }
    async fn finish_group(&self, processes: &mut ProcessGroup, outcome: Outcome) -> i32 {
        let code = outcome.code;
        let finished = self.cancel.run(processes.complete()).await;
        match finished {
            Ok(Ok(cleanup)) => {
                self.core.retain_residual(
                    self.group,
                    self.scope.clone(),
                    cleanup,
                    self.lifetime.clone(),
                );
                code
            }
            Ok(Err(_)) => 1,
            Err(_) => processes
                .terminate(self.stop_signal())
                .await
                .map(|_| {
                    if outcome.flow == Flow::SpawnFailed {
                        code
                    } else {
                        self.cancel_status()
                    }
                })
                .unwrap_or(1),
        }
    }
    pub(crate) async fn wait_job(&self, id: Option<JobSelector>) -> Result<i32, i32> {
        let code = self.wait_jobs(id, false).await?;
        Ok(if id.is_none() { 0 } else { code })
    }
    async fn wait_jobs(
        &self,
        selector: Option<JobSelector>,
        include_internal: bool,
    ) -> Result<i32, i32> {
        let mut code = 0;
        loop {
            let Some((id, job)) = self.next_job(selector, include_internal) else {
                if selector.is_some() {
                    return Err(127);
                }
                self.core
                    .jobs
                    .borrow_mut()
                    .retain(|_, job| job.owner != self.scope || job.kind != JobKind::Completed);
                return Ok(code);
            };
            code = self.cancel.run(job).await.map_err(|_| 130)?;
            if selector.is_some() {
                let mut jobs = self.core.jobs.borrow_mut();
                let job = jobs
                    .get_mut(&id)
                    .expect("owned job stays registered while waiting");
                job.notified = true;
                // Noninteractive isolated shells discard the percent-job entry
                // after an explicit wait, but retain the numeric child status.
                if self.scope.resolved_id() != 0 || job.kind == JobKind::ProcessSubstitution {
                    job.kind = JobKind::Completed;
                    job.label = None;
                }
                return Ok(code);
            }
            self.core.jobs.borrow_mut().remove(&id);
            // Exiting children may transfer their own descendants to this
            // scope. Supervisors drain those too, unlike the shell's `wait`.
        }
    }
    fn next_job(
        &self,
        selector: Option<JobSelector>,
        include_internal: bool,
    ) -> Option<(JobId, JoinHandle<i32>)> {
        self.core
            .jobs
            .borrow()
            .iter()
            .find(|(id, job)| {
                let selected = selector.map_or(
                    include_internal
                        || matches!(
                            job.kind,
                            JobKind::Background(_) | JobKind::ProcessSubstitution
                        ),
                    |selector| selector.matches(**id, job),
                );
                selected && job.owner == self.scope
            })
            .map(|(id, job)| (*id, job.join.clone()))
    }
    pub(crate) async fn list_jobs(&self, fds: &FdTable) -> Result<(), i32> {
        let ids: Vec<_> = self
            .core
            .jobs
            .borrow()
            .iter()
            .filter(|(_, job)| {
                job.owner == self.scope && matches!(job.kind, JobKind::Background(_))
            })
            .map(|(&id, _)| id)
            .collect();
        let current = ids.last().copied();
        let previous = ids.iter().rev().nth(1).copied();
        for id in ids {
            let (number, label, status, notified) = {
                let jobs = self.core.jobs.borrow();
                let job = jobs.get(&id).expect("registered job");
                let JobKind::Background(number) = job.kind else {
                    continue;
                };
                (
                    number,
                    job.label.clone(),
                    job.join.clone().now_or_never(),
                    job.notified,
                )
            };
            if !notified || status.is_none() {
                let output = fds.get(1).ok_or(1)?;
                let marker = if Some(id) == current {
                    '+'
                } else if Some(id) == previous {
                    '-'
                } else {
                    ' '
                };
                let state = match status {
                    None => "Running".to_owned(),
                    Some(0) => "Done".to_owned(),
                    Some(code) => format!("Exit {code}"),
                };
                let header = format!("[{}]{}  {:<27}", number.0, marker, state);
                output
                    .write_all(header.as_bytes(), &self.cancel)
                    .await
                    .map_err(|e| e.status())?;
                if let Some(label) = label {
                    output
                        .write_all(label.text.as_bytes(), &self.cancel)
                        .await
                        .map_err(|e| e.status())?;
                }
                output
                    .write_all(if status.is_none() { b" &\n" } else { b"\n" }, &self.cancel)
                    .await
                    .map_err(|e| e.status())?;
            }
            if status.is_some() {
                let mut jobs = self.core.jobs.borrow_mut();
                let job = jobs.get_mut(&id).expect("registered job");
                job.kind = JobKind::Completed;
                // A remembered numeric status needs no retained source label.
                job.label = None;
            }
        }
        Ok(())
    }
    pub(crate) fn check_job(&self, selector: JobSelector) -> Result<(), i32> {
        self.core
            .jobs
            .borrow()
            .iter()
            .find(|(id, job)| {
                selector.matches_live(**id, job)
                    && job.owner == self.scope
                    && (matches!(selector, JobSelector::Number(_)) || !job.join.is_finished())
            })
            .map(|_| ())
            .ok_or(1)
    }
    pub(crate) fn kill_job(&self, selector: JobSelector, signal: i32) -> Result<(), i32> {
        let jobs = self.core.jobs.borrow();
        let job = jobs
            .iter()
            .find(|(id, job)| selector.matches_live(**id, job) && job.owner == self.scope)
            .map(|(_, job)| job)
            .ok_or(1)?;
        if job.join.is_finished() {
            // Non-monitor Bash accepts an unreported completed %job, but does
            // not signal its residual runtime group. Numeric handles are dead.
            return if matches!(selector, JobSelector::Number(_)) {
                Ok(())
            } else {
                Err(1)
            };
        }
        self.core
            .host
            .kill_group(job.group, signal)
            .map_err(|_| 1)?;
        job.signal.set(Some(signal));
        job.cancel.cancel();
        Ok(())
    }
}
/// Failure before a foreground job starts. Embeddings must preserve interrupt
/// status rather than reporting parser cancellation as a syntax error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartError {
    Interrupted,
    Invalid(String),
}
impl StartError {
    pub fn status(&self) -> i32 {
        match self {
            Self::Interrupted => 130,
            Self::Invalid(_) => 2,
        }
    }
}
impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Interrupted => f.write_str("request cancelled"),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for StartError {}

/// A persistent shell session. The embedding drives `Executor`, delivers
/// interrupts without a message-loop round trip, and drains terminal endpoints.
pub struct Session {
    core: Rc<Core>,
    state: SharedState,
}
impl Session {
    pub fn new(
        executor: Executor,
        host: Rc<dyn ProcessHost>,
        fs: Rc<dyn FileSystem>,
        limits: Limits,
    ) -> Self {
        let memory = crate::exec::StorageBudget::new(limits.execution_bytes);
        let state = State::with_memory(memory.clone()).shared();
        Self {
            core: Rc::new(Core {
                executor,
                host,
                fs,
                eval_storage: crate::exec::StorageBudget::new(limits.expansion_bytes),
                execution_storage: memory,
                limits,
                descriptors: Rc::new(RefCell::new(FdTable::default())),
                jobs: RefCell::new(BTreeMap::new()),
                residuals: RefCell::new(BTreeMap::new()),
                next: Cell::new(1),
                foreground: RefCell::new(None),
                exit_requested: Cell::new(false),
            }),
            state,
        }
    }
    pub fn state(&self) -> SharedState {
        self.state.clone()
    }
    pub fn exit_requested(&self) -> bool {
        self.core.exit_requested.get()
    }
    pub fn background_jobs(&self) -> usize {
        self.core
            .jobs
            .borrow()
            .values()
            .filter(|job| {
                matches!(job.kind, JobKind::Background(_))
                    && job.owner.resolved_id() == 0
                    && !job.join.is_finished()
            })
            .count()
    }
    pub fn interrupt(&self) {
        if let Some(job) = self.core.foreground.borrow().as_ref() {
            if job.signal.get().is_none() {
                job.signal.set(Some(2));
            }
            job.cancel.cancel();
        }
    }
    pub fn set_descriptors(&self, fds: FdTable) -> Result<(), String> {
        if self.core.foreground.borrow().is_some() {
            return Err("foreground job is already running".into());
        }
        *self.core.descriptors.borrow_mut() = fds;
        Ok(())
    }
    pub fn start(&self, source: &str) -> Result<JoinHandle<i32>, StartError> {
        if self.core.foreground.borrow().is_some() {
            return Err(StartError::Invalid(
                "foreground job is already running".into(),
            ));
        }
        if source.len() > self.core.limits.source_bytes {
            return Err(StartError::Invalid("shell source limit exceeded".into()));
        }
        let host = self.core.host.clone();
        let cancel = Cancel::with_probe(Rc::new(move || host.interrupted()));
        let parser_cancel = cancel.clone();
        let evaluation = crate::exec::Scope::new(
            self.core.limits.source_bytes,
            self.core.eval_storage.clone(),
            self.core.execution_storage.clone(),
        );
        let parser = evaluation.parser_budget(Some(Rc::new(move || parser_cancel.probe_now())));
        let aliases = reader::AliasOptions::snapshot(&self.state);
        let (script, failure) = parse::script(
            source,
            self.core.limits.source_bytes,
            &parser,
            aliases.options(),
        )
        .map_err(|error| {
            if error == "request cancelled" {
                StartError::Interrupted
            } else {
                StartError::Invalid(error)
            }
        })?;
        if script.commands.is_empty()
            && let Some(ParseFailure::Syntax { message, .. }) = failure.as_ref()
        {
            return Err(StartError::Invalid(message.clone()));
        }
        let group = self.core.host.allocate_group();
        let foreground_cancel = cancel.clone();
        let signal = Rc::new(Cell::new(None));
        let foreground_signal = signal.clone();
        let context = Context::root(self.core.clone(), source, evaluation, group, cancel, signal);
        let state = self.state.clone();
        let join = self.core.executor.spawn(async move {
            let _foreground = ForegroundGuard(context.core.clone());
            let mut processes = ProcessGroup::new(context.core.host.clone(), group)
                .with_signal(context.signal.clone());
            let result = reader::run(
                reader::Reader::new(script, failure, aliases, parser),
                "-c",
                false,
                state.clone(),
                context.core.descriptors.clone(),
                context.clone(),
            )
            .await;
            if result.flow == Flow::Exit {
                context.core.exit_requested.set(true);
            }
            let code = context.finish_group(&mut processes, result).await;
            state.borrow_mut().publish_status(code);
            code
        });
        *self.core.foreground.borrow_mut() = Some(Job {
            label: None,
            notified: false,
            owner: Scope::new(0),
            kind: JobKind::Internal,
            group,
            cancel: foreground_cancel,
            signal: foreground_signal,
            join: join.clone(),
            _allocation: None,
        });
        Ok(join)
    }
    pub async fn shutdown(&self) {
        self.interrupt();
        let jobs: Vec<_> = self
            .core
            .jobs
            .borrow()
            .values()
            .map(|j| {
                if j.signal.get().is_none() {
                    j.signal.set(Some(2));
                }
                j.cancel.cancel();
                j.join.clone()
            })
            .collect();
        let foreground = self
            .core
            .foreground
            .borrow()
            .as_ref()
            .map(|job| job.join.clone());
        let residuals: Vec<_> = self
            .core
            .residuals
            .borrow()
            .iter()
            .map(|(&group, residual)| (group, residual.cleanup.clone()))
            .collect();
        for (group, _) in &residuals {
            let _ = self.core.host.kill_group(*group, 2);
        }
        join_all(jobs.into_iter().chain(foreground)).await;
        self.core.jobs.borrow_mut().clear();
        for (group, cleanup) in residuals {
            if cleanup.await.is_err() {
                // A prior host error retains its signal/reaping handle for retry.
                let _ = self.core.host.wait_group(group).await;
            }
        }
        self.core.residuals.borrow_mut().clear();
        *self.core.descriptors.borrow_mut() = FdTable::default();
        self.core.host.shutdown_io().await;
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.interrupt();
        for &group in self.core.residuals.borrow().keys() {
            self.core.host.abandon_group(group, 2);
        }
        for job in self.core.jobs.borrow().values() {
            if job.signal.get().is_none() {
                job.signal.set(Some(2));
            }
            job.cancel.cancel();
        }
    }
}
impl Core {
    fn retain_residual(
        &self,
        group: GroupId,
        owner: Scope,
        cleanup: JoinHandle<Result<(), ProcessError>>,
        lifetime: (Cancel, Rc<Cell<Option<i32>>>),
    ) {
        // One natural retry per completion checkpoint keeps transient errors
        // recoverable without a retry loop. The host retains admission ownership
        // until full cleanup succeeds, even if its runtime members already exited.
        self.residuals.borrow_mut().retain(|group, residual| {
            if !residual.cleanup.is_finished() {
                return true;
            }
            if matches!(residual.cleanup.clone().now_or_never(), Some(Ok(()))) {
                return false;
            }
            residual.cleanup = self.monitor_residual(
                *group,
                self.host.detach_group(*group),
                residual.lifetime.clone(),
            );
            !residual.cleanup.is_finished()
                || !matches!(residual.cleanup.clone().now_or_never(), Some(Ok(())))
        });
        // Old monitors observe explicit cancellation only; they must not consume
        // a host interrupt belonging to the next foreground invocation.
        let lifetime = (lifetime.0.without_probe(), lifetime.1);
        let cleanup = self.monitor_residual(group, cleanup, lifetime.clone());
        if cleanup.is_finished() && matches!(cleanup.clone().now_or_never(), Some(Ok(()))) {
            return;
        }
        self.residuals.borrow_mut().insert(
            group,
            Residual {
                owner,
                cleanup,
                lifetime,
            },
        );
    }
    fn monitor_residual(
        &self,
        group: GroupId,
        cleanup: JoinHandle<Result<(), ProcessError>>,
        lifetime: (Cancel, Rc<Cell<Option<i32>>>),
    ) -> JoinHandle<Result<(), ProcessError>> {
        // Ready success has no ownership left; ready failure needs a future
        // checkpoint or shutdown retry, not an extra executor task.
        if cleanup.is_finished() {
            return cleanup;
        }
        let host = self.host.clone();
        self.executor.spawn(async move {
            match futures::future::select(cleanup, lifetime.0.cancelled().boxed_local()).await {
                futures::future::Either::Left((result, _)) => result,
                futures::future::Either::Right(((), cleanup)) => {
                    let _ = host.kill_group(group, lifetime.1.get().unwrap_or(2));
                    // Reaping, not signal delivery, decides whether ownership
                    // remains. A delivery error cannot undo confirmed cleanup.
                    cleanup.await
                }
            }
        })
    }
    fn reap_internal_jobs(&self) {
        self.jobs
            .borrow_mut()
            .retain(|_, job| job.kind != JobKind::Internal || !job.join.is_finished());
    }
    fn has_job_capacity(&self) -> bool {
        self.jobs
            .borrow()
            .values()
            .filter(|job| {
                job.kind != JobKind::Completed && !(job.notified && job.join.is_finished())
            })
            .count()
            < self.limits.jobs
    }
    fn reap_completed_jobs(&self) {
        let mut jobs = self.jobs.borrow_mut();
        for job in jobs.values_mut() {
            if job.notified && job.join.is_finished() && matches!(job.kind, JobKind::Background(_))
            {
                job.kind = JobKind::Completed;
                job.label = None;
            }
        }
        // Reserve one launch slot by evicting the oldest retained handle.
        // Inspect the bounded table in place; eviction allocates no scratch.
        while jobs.len() >= self.limits.jobs {
            let oldest = jobs
                .iter()
                .find_map(|(id, job)| matches!(job.kind, JobKind::Completed).then_some(*id));
            let Some(id) = oldest else { break };
            jobs.remove(&id);
        }
    }
    fn allocate_job_number(&self, owner: &Scope) -> Result<JobNumber, i32> {
        let jobs = self.jobs.borrow();
        for index in 0..=jobs.len() {
            let number = JobNumber(
                u64::try_from(index)
                    .map_err(|_| 2)?
                    .checked_add(1)
                    .ok_or(2)?,
            );
            let used = jobs
                .values()
                .any(|job| job.kind == JobKind::Background(number) && job.owner == *owner);
            if !used {
                return Ok(number);
            }
        }
        Err(2)
    }
    fn allocate_id(&self) -> u64 {
        let id = self.next.get();
        self.next.set(id.checked_add(1).expect("job ID overflow"));
        id
    }
}
struct ForegroundGuard(Rc<Core>);
impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        self.0.foreground.borrow_mut().take();
    }
}

/// Report where parsing stopped, after the commands before it ran. A bad
/// substitution body ends the shell with 127; other syntax errors with 2.
async fn parse_failure(
    failure: ParseFailure,
    reader: &str,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let (message, line) = match failure {
        ParseFailure::Word(line) => {
            let mut work = expansion_work(context);
            let error = work
                .admit_storage(256)
                .err()
                .unwrap_or(expand::Error::ShellBoundary {
                    stage: expand::ShellBoundaryStage::Word,
                    line: Some(line),
                });
            return expansion_failure(error.into(), fds, context).await;
        }
        ParseFailure::Syntax { message, line } => (message, line),
    };
    if message.len() > context.limits().expansion_bytes {
        return Outcome::status(2);
    }
    let diagnostic = format!("/usr/bin/bash: {reader}: line {line}: {message}\n");
    let stderr = fds.borrow().get(2);
    if let Some(stderr) = stderr {
        let _ = stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await;
    }
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    Outcome {
        code: 2,
        flow: Flow::Exit,
    }
}

fn sequence(
    commands: Vec<Command>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, Outcome> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        sequence_body(commands, state, fds, context),
        Outcome::status,
    )
}

async fn sequence_body(
    commands: Vec<Command>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut result = Outcome::status(0);
    for command in commands {
        result = execute(command, state.clone(), fds.clone(), context.clone()).await;
        if result.flow != Flow::Normal || context.cancel.is_cancelled() {
            break;
        }
    }
    if result.flow == Flow::SpawnFailed {
        return result;
    }
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    if result.flow == Flow::Resource {
        return abort_diagnostic(
            &fds,
            &context,
            b"shell live-execution memory limit exceeded",
            2,
        )
        .await;
    }
    result
}
fn execute(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, Outcome> {
    if context.cancel.is_cancelled() {
        return futures::future::Either::Left(futures::future::ready(Outcome::status(130)));
    }
    let evaluation = match context.evaluation.descend() {
        Ok(scope) => scope,
        Err(code) => {
            return futures::future::Either::Left(futures::future::ready(Outcome::status(code)));
        }
    };
    let context = Context {
        evaluation,
        ..context
    };
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        async move {
            yield_now().await;
            if context.cancel.is_cancelled() {
                return Outcome::status(130);
            }
            let preserve = matches!(command, Command::Pipeline(_) | Command::List(_))
                || (context.command_boundary == CommandBoundary::FunctionBody
                    && matches!(
                        &command,
                        Command::Compound(compound, _)
                            if !matches!(
                                compound,
                                CompoundCommand::Subshell(_)
                                    | CompoundCommand::Arithmetic(_)
                                    | CompoundCommand::Test(_)
                            )
                    ));
            let check_errexit = !context.ignore_errexit
                && context.command_boundary != CommandBoundary::PipelineStage
                && matches!(
                    &command,
                    Command::Simple(_)
                        | Command::Pipeline(Pipeline { negated: false, .. })
                        | Command::Compound(
                            CompoundCommand::Arithmetic(_)
                                | CompoundCommand::Test(_)
                                | CompoundCommand::Subshell(_),
                            _
                        )
                );
            let error_trap = check_errexit
                && state
                    .borrow()
                    .traps
                    .action(crate::state::traps::Event::Error)
                    .is_some();
            let context = Context {
                command_boundary: CommandBoundary::Ordinary,
                ..context
            };
            let trap_inputs = error_trap.then(|| (fds.clone(), context.clone()));
            let mut result = command_body(command, state.clone(), fds, context).await;
            let trap_inputs =
                trap_inputs.filter(|_| result.flow == Flow::Normal && result.code != 0);
            if let Some((fds, context)) = trap_inputs {
                finish_command(&state, result, preserve);
                result = trap::run(
                    crate::state::traps::Event::Error,
                    result,
                    state.clone(),
                    fds,
                    context,
                )
                .await;
            }
            if check_errexit
                && result.flow == Flow::Normal
                && result.code != 0
                && state.borrow().errexit
            {
                result.flow = Flow::Abort;
            }
            finish_command(&state, result, preserve)
        },
        Outcome::status,
    )
}

fn finish_command(state: &SharedState, result: Outcome, preserve_pipeline: bool) -> Outcome {
    // RETURN observes the status preceding the explicit return operand.
    if result.flow == Flow::Return {
        return result;
    }
    let mut state = state.borrow_mut();
    state.publish_status(result.code);
    if !preserve_pipeline {
        state.publish_pipeline_status(vec![result.code]);
    }
    result
}

// Select the future outside the recursive poll frame. An async match retains
// every branch's largest expansion/dispatch frame even when polling a brace.
#[inline(never)]
fn command_body(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    match command {
        Command::Simple(simple) => {
            evaluation.frame(simple_command(simple, state, fds, context), Outcome::status)
        }
        Command::Function(function) => evaluation.frame(
            function_names::declare(function, state, fds, context),
            Outcome::status,
        ),
        Command::Pipeline(pipeline) => evaluation.frame(
            pipeline_command(pipeline, state, fds, context),
            Outcome::status,
        ),
        Command::List(list) => {
            evaluation.frame(list_command(list, state, fds, context), Outcome::status)
        }
        Command::Compound(CompoundCommand::Subshell(commands), redirs) => evaluation.frame(
            subshell(commands, redirs, state, fds, context),
            Outcome::status,
        ),
        Command::Compound(compound, redirs) => evaluation.frame(
            compound_command(compound, redirs, state, fds, context),
            Outcome::status,
        ),
    }
}

async fn pipeline_command(
    pipeline: Pipeline,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let count = pipeline.commands.len();
    if count == 0 || count > context.limits().pipeline_stages {
        state.borrow_mut().publish_pipeline_status(vec![2]);
        return Outcome::status(2);
    }
    let share_last = count > 1 && {
        let state = state.borrow();
        state.lastpipe && !state.monitor
    };
    let mut work = expansion_work(&context);
    let children = match pipeline_children(count, &state, &context, &mut work).await {
        Ok(children) => children,
        Err(error) => {
            let outcome = expansion_failure(error.into(), &fds, &context).await;
            state
                .borrow_mut()
                .publish_pipeline_status(vec![outcome.code]);
            return outcome;
        }
    };
    let mut children = children.into_iter();
    let mut pipes = VecDeque::new();
    for _ in 1..count {
        let pipe = match context.fs().pipe() {
            Ok(pipe) => pipe,
            Err(error) => return Outcome::status(error.status()),
        };
        pipes.push_back(pipe);
    }
    let mut previous = None;
    let mut tasks = Vec::new();
    // All stage task/queue metadata is admitted before the first launch.
    let _tasks_allocation = match admit_task_metadata::<JoinHandle<Outcome>>(&context, count) {
        Ok(allocation) => allocation,
        Err(_) => {
            state.borrow_mut().publish_pipeline_status(vec![2]);
            return Outcome::status(2);
        }
    };
    if tasks.try_reserve_exact(count).is_err() {
        state.borrow_mut().publish_pipeline_status(vec![2]);
        return Outcome::status(2);
    }
    for (index, command) in pipeline.commands.into_iter().enumerate() {
        let mut stage_fds = fds.borrow().clone();
        if let Some(input) = previous.take() {
            stage_fds.insert(0, input);
        }
        if index + 1 < count {
            let (reader, writer) = pipes.pop_front().expect("reserved pipeline pipe");
            stage_fds.insert(1, writer);
            previous = Some(reader);
        }
        let child = if count == 1 {
            state.clone()
        } else {
            children.next().expect("all pipeline state was prepared")
        };
        let shared_stage = count == 1 || (share_last && index + 1 == count);
        let stage_context = if shared_stage {
            if pipeline.negated {
                context.condition()
            } else {
                context.clone()
            }
        } else {
            let child = context.isolated_command(&command);
            if pipeline.negated {
                child.condition()
            } else {
                child
            }
        };
        let stage_fds = if count == 1 {
            fds.clone()
        } else {
            Rc::new(RefCell::new(stage_fds))
        };
        let parent_scope = context.scope.clone();
        let command_boundary = match (count, index + 1 == count, &command) {
            (1, _, _) => CommandBoundary::Ordinary,
            (_, true, Command::Compound(CompoundCommand::Subshell(_), _)) => {
                CommandBoundary::PipelineSubshell
            }
            _ if shared_stage => CommandBoundary::Ordinary,
            _ => CommandBoundary::PipelineStage,
        };
        if command_boundary == CommandBoundary::PipelineSubshell {
            child.borrow_mut().traps.pipeline_subshell();
        }
        tasks.push(context.core.executor.spawn(pipeline_stage(
            command,
            child,
            stage_fds,
            Context {
                command_boundary,
                ..stage_context
            },
            parent_scope,
            !shared_stage,
        )));
    }
    drop(fds);
    drop(previous);
    let results = join_all(tasks).await;
    let codes: Vec<_> = results.iter().map(|r| r.code).collect();
    let mut code = if state.borrow().pipefail {
        codes.iter().rev().copied().find(|&n| n != 0).unwrap_or(0)
    } else {
        *codes.last().unwrap()
    };
    // Every joined stage has a public status, even when a resource failure or
    // shared last-stage control flow aborts the submitted reader. Publish the
    // complete ordered result before taking any of those early exits.
    state.borrow_mut().publish_pipeline_status(codes);
    if let Some(result) = results
        .iter()
        .find(|result| result.flow == Flow::SpawnFailed)
    {
        return *result;
    }
    if (count == 1 || share_last) && results.last().unwrap().flow != Flow::Normal {
        return *results.last().unwrap();
    }
    if results.iter().any(|result| result.flow == Flow::Resource) {
        return Outcome::status(crate::exec::RESOURCE_STATUS);
    }
    if pipeline.negated {
        code = i32::from(code == 0);
    }
    if context.cancel.is_cancelled() {
        code = 130;
    }
    Outcome::status(code)
}

#[inline(never)]
fn pipeline_children<'a>(
    count: usize,
    state: &'a SharedState,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<Vec<SharedState>, expand::Error>> {
    context.evaluation.frame(
        pipeline_children_body(count, state, context, work),
        |code| Err(code.into()),
    )
}

async fn pipeline_children_body(
    count: usize,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Vec<SharedState>, expand::Error> {
    let mut children = Vec::new();
    if count == 1 {
        return Ok(children);
    }
    work.admit_storage(
        count
            .checked_mul(std::mem::size_of::<SharedState>())
            .ok_or(2)?,
    )?;
    children.try_reserve_exact(count).map_err(|_| 2)?;
    let share_last = {
        let state = state.borrow();
        state.lastpipe && !state.monitor
    };
    for index in 0..count {
        children.push(if share_last && index + 1 == count {
            state.clone()
        } else {
            State::snapshot(state, &context.cancel, work)
                .await?
                .shared()
        });
    }
    Ok(children)
}

async fn pipeline_stage(
    command: Command,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    parent_scope: Scope,
    isolated: bool,
) -> Outcome {
    let result = execute(command, state, fds, context.clone()).await;
    if isolated {
        context.finish_scope(parent_scope).await;
    }
    result
}

async fn compound_command(
    compound: CompoundCommand,
    redirs: Vec<Redirect>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    // Without compound redirections, `exec` inside a branch or loop changes
    // the surrounding shell's bindings. A redirected compound restores its
    // caller's table when its body finishes, including after `exec`.
    let fds = if redirs.is_empty() {
        fds
    } else {
        let table = fds.borrow().clone();
        // Shadowing alone retains the incoming table until this body returns.
        // A redirected background loop must release its old capture writer
        // before running, even if the loop itself never finishes.
        drop(fds);
        Rc::new(RefCell::new(table))
    };
    let mut work = substitution_work(&context, &fds);
    let fds = match command_redirects(&redirs, &state, fds, &context, &mut work).await {
        Err(outcome) => return outcome,
        Ok(fds) => fds,
    };
    let context = context.compound_body();
    // Unredirected compounds share shell bindings so exec persists, but their
    // process-substitution descriptors still belong only to this command.
    let allocation = match context.evaluation.admit_execution(
        std::mem::size_of::<ProcessSubstitutionFds>() + 2 * std::mem::size_of::<usize>(),
    ) {
        Ok(allocation) => allocation,
        Err(code) => return Outcome::status(code),
    };
    let process_fds = Rc::new(ProcessSubstitutionFds {
        fds: fds.clone(),
        opened: Cell::new(0),
        _allocation: allocation,
    });
    // Other bodies must release the expansion reader's descriptor references.
    work.substitutions = matches!(
        compound,
        CompoundCommand::Arithmetic(_)
            | CompoundCommand::Case(_)
            | CompoundCommand::For(_)
            | CompoundCommand::Select(_)
            | CompoundCommand::ArithmeticFor(_)
            | CompoundCommand::Test(_)
    )
    .then(|| Substitutions {
        context: context.clone(),
        fds: fds.clone(),
        process_fds: Some(process_fds.clone()),
    });
    execute_compound_body(compound, state, fds, context, &mut work).await
}

#[inline(never)]
fn command_redirects<'a>(
    redirs: &'a [Redirect],
    state: &'a SharedState,
    fds: Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<Descriptors, Outcome>> {
    context.evaluation.frame(
        async move {
            let original_fds = fds.clone();
            match redirects(redirs, state, fds, context, work, None).await {
                Ok(fds) => Ok(fds),
                Err(error) => {
                    let mut outcome = expansion_failure(error, &original_fds, context).await;
                    // Setup failure is a command failure even when its compound
                    // body's statuses have their own errexit rules.
                    if outcome.flow == Flow::Normal
                        && outcome.code != 0
                        && !context.ignore_errexit
                        && state.borrow().errexit
                    {
                        outcome.flow = Flow::Abort;
                    }
                    Err(outcome)
                }
            }
        },
        |code| Err(Outcome::status(code)),
    )
}

#[inline(never)]
fn execute_compound_body<'a>(
    compound: CompoundCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a> {
    let evaluation = context.evaluation.clone();
    match compound {
        CompoundCommand::Arithmetic(source) => evaluation.frame(
            async move { arithmetic_command(&source, &state, &fds, &context, work).await },
            Outcome::status,
        ),
        CompoundCommand::BraceGroup(commands) => sequence(commands, state, fds, context),
        CompoundCommand::While(loop_) => evaluation.frame(
            while_command(loop_.condition, loop_.body, false, state, fds, context),
            Outcome::status,
        ),
        CompoundCommand::Test(expression) => evaluation.frame(
            async move { conditional::run(&expression, &state, &fds, &context, work).await },
            Outcome::status,
        ),
        CompoundCommand::If(if_) => control::run_if(if_, state, fds, context),
        CompoundCommand::Until(loop_) => evaluation.frame(
            while_command(loop_.condition, loop_.body, true, state, fds, context),
            Outcome::status,
        ),
        CompoundCommand::For(loop_) => control::run_for(loop_, state, fds, context, work),
        CompoundCommand::Select(loop_) => select::run(loop_, state, fds, context, work),
        CompoundCommand::ArithmeticFor(loop_) => {
            control::run_arithmetic_for(loop_, state, fds, context)
        }
        CompoundCommand::Case(case_) => {
            evaluation.frame(run_case(case_, state, fds, context, work), Outcome::status)
        }
        _ => futures::future::Either::Left(futures::future::ready(Outcome::status(2))),
    }
}

async fn while_command(
    condition: Vec<Command>,
    body: Vec<Command>,
    until: bool,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let context = context.loop_body();
    let condition_context = context.condition();
    let mut condition_cache = None;
    let mut body_cache = None;
    let mut condition_cache_attempted = false;
    let mut body_cache_attempted = false;
    let mut result = Outcome::status(0);
    let mut budget = Budget::default();
    loop {
        if let Err(outcome) = loop_checkpoint(&mut budget, &context).await {
            return outcome;
        }
        if !condition_cache_attempted {
            condition_cache_attempted = true;
            condition_cache = cache_loop_arithmetic(&condition, &condition_context).await;
        }
        let test = loop_sequence(
            &condition,
            &state,
            &fds,
            &condition_context,
            condition_cache.as_ref(),
        )
        .await;
        if test.flow == Flow::SpawnFailed {
            return test;
        }
        if context.cancel.is_cancelled() {
            return Outcome::status(130);
        }
        match control::loop_step(test, context.loop_depth) {
            control::LoopStep::Normal(test) => {
                if (test.code == 0) == until {
                    return result;
                }
            }
            control::LoopStep::Continue => continue,
            control::LoopStep::Stop(outcome) => return outcome,
        }
        if !body_cache_attempted {
            body_cache_attempted = true;
            body_cache = cache_loop_arithmetic(&body, &context).await;
        }
        let body_result = loop_sequence(&body, &state, &fds, &context, body_cache.as_ref()).await;
        match control::loop_step(body_result, context.loop_depth) {
            control::LoopStep::Normal(outcome) => result = outcome,
            control::LoopStep::Continue => result = Outcome::status(0),
            control::LoopStep::Stop(outcome) => return outcome,
        }
    }
}

fn loop_sequence<'a>(
    commands: &'a [Command],
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    cache: Option<&'a CachedArithmetic<'a>>,
) -> eval::Frame<'a> {
    if let [Command::Compound(CompoundCommand::Arithmetic(source), redirs)] = commands
        && redirs.is_empty()
    {
        return loop_arithmetic(source, state, fds, context, cache);
    }
    context.evaluation.frame(
        async move {
            // The prior iteration's copy is gone. Admit this retained AST
            // copy against fresh command storage, never elapsed loop work.
            let mut work = expansion_work(context);
            if let Err(error) = crate::ast_copy::admit(commands, &context.cancel, &mut work).await {
                return expansion_failure(error.into(), fds, context).await;
            }
            sequence(
                commands.to_vec(),
                state.clone(),
                fds.clone(),
                context.clone(),
            )
            .await
        },
        Outcome::status,
    )
}

struct CachedArithmetic<'a> {
    program: arithmetic::Program<'a>,
    _storage: crate::exec::StorageAllocation,
}

async fn cache_loop_arithmetic<'a>(
    commands: &'a [Command],
    context: &Context,
) -> Option<CachedArithmetic<'a>> {
    let [Command::Compound(CompoundCommand::Arithmetic(source), redirs)] = commands else {
        return None;
    };
    if !redirs.is_empty() || !arithmetic::Program::is_static(source) {
        return None;
    }
    let storage = context
        .evaluation
        .admit_storage(arithmetic::Program::retained_bytes(source))
        .ok()?;
    let mut work = expansion_work(context);
    let program = match arithmetic::Program::compile(source, &mut work, &context.cancel).await {
        Ok(program) => program,
        Err(_) => return None,
    };
    Some(CachedArithmetic {
        program,
        _storage: storage,
    })
}

fn loop_arithmetic<'a>(
    source: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &Context,
    cache: Option<&'a CachedArithmetic<'a>>,
) -> eval::Frame<'a> {
    if context.cancel.is_cancelled() {
        return futures::future::Either::Left(futures::future::ready(Outcome::status(130)));
    }
    let evaluation = match context.evaluation.descend() {
        Ok(scope) => scope,
        Err(code) => {
            return futures::future::Either::Left(futures::future::ready(Outcome::status(code)));
        }
    };
    let context = Context {
        evaluation: evaluation.clone(),
        ..context.compound_body()
    };
    // The retained loop already owns this typed source. Replay borrows it;
    // every evaluation still owns fresh Work and command-local descriptors.
    evaluation.frame(
        async move {
            yield_now().await;
            if context.cancel.is_cancelled() {
                return Outcome::status(130);
            }
            let table = fds.borrow().clone();
            let fds = Rc::new(RefCell::new(table));
            let mut work = substitution_work(&context, &fds);
            let error_trap = !context.ignore_errexit
                && state
                    .borrow()
                    .traps
                    .action(crate::state::traps::Event::Error)
                    .is_some();
            let result = match cache {
                Some(cache) => {
                    arithmetic_command_program(&cache.program, state, &fds, &context, &mut work)
                        .await
                }
                None => arithmetic_command(source, state, &fds, &context, &mut work).await,
            };
            let mut result = finish_command(state, result, false);
            if error_trap && result.flow == Flow::Normal && result.code != 0 {
                result = trap::run(
                    crate::state::traps::Event::Error,
                    result,
                    state.clone(),
                    fds.clone(),
                    context.clone(),
                )
                .await;
            }
            if result.flow == Flow::Normal
                && result.code != 0
                && state.borrow().errexit
                && !context.ignore_errexit
            {
                result.flow = Flow::Abort;
            }
            if context.cancel.is_cancelled() {
                return Outcome::status(130);
            }
            result
        },
        Outcome::status,
    )
}

async fn loop_checkpoint(budget: &mut Budget, context: &Context) -> Result<(), Outcome> {
    budget
        .checkpoint(&context.cancel)
        .await
        .map_err(|_| Outcome::status(130))
}

/// `case` expands its word as a scalar (no splitting or globbing) and each
/// pattern with quote protection, then matches through the bounded matcher.
async fn run_case(
    case_: CaseCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    work: &mut expand::Work,
) -> Outcome {
    let word = match case_word(&case_.word, &state, &context, work).await {
        Ok(word) => word,
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    let mut matched = false;
    let mut result = Outcome::status(0);
    let mut budget = Budget::default();
    for item in case_.cases {
        if let Err(outcome) = loop_checkpoint(&mut budget, &context).await {
            return outcome;
        }
        if !matched {
            let item_match = match case_item_matches(
                &item.patterns,
                &word,
                &state,
                &fds,
                &context,
                work,
                &mut budget,
            )
            .await
            {
                Ok(matched) => matched,
                Err(outcome) => return outcome,
            };
            if !item_match {
                continue;
            }
            matched = true;
        }
        result = sequence(item.commands, state.clone(), fds.clone(), context.clone()).await;
        if result.flow != Flow::Normal {
            return result;
        }
        match item.terminator {
            CaseTerminator::Break => return result,
            CaseTerminator::FallThrough => {}
            CaseTerminator::Continue => matched = false,
        }
    }
    result
}

#[inline(never)]
fn case_word<'a>(
    word: &'a Word,
    state: &'a SharedState,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<String, expand::Error>> {
    context.evaluation.frame(
        expand::word(
            word,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            context.limits().expansion_bytes,
            work,
        ),
        |code| Err(code.into()),
    )
}

#[inline(never)]
fn case_item_matches<'a>(
    patterns: &'a [Word],
    word: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
    budget: &'a mut Budget,
) -> eval::Frame<'a, Result<bool, Outcome>> {
    context.evaluation.frame(
        case_item_matches_body(patterns, word, state, fds, context, work, budget),
        |code| Err(Outcome::status(code)),
    )
}

async fn case_item_matches_body(
    patterns: &[Word],
    word: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
    budget: &mut Budget,
) -> Result<bool, Outcome> {
    for pattern in patterns {
        loop_checkpoint(budget, context).await?;
        let mut pattern = match expand::pattern(
            pattern,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            work,
        )
        .await
        {
            Ok(pattern) => pattern,
            Err(error) => return Err(expansion_failure(error.into(), fds, context).await),
        };
        match pattern.matches_full(word, work, &context.cancel).await {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) => return Err(expansion_failure(error.into(), fds, context).await),
        }
    }
    Ok(false)
}

async fn arithmetic_command(
    source: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Outcome {
    let value = crate::arithmetic::evaluate(
        source,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await;
    arithmetic_result(value, fds, context).await
}

async fn arithmetic_command_program(
    program: &arithmetic::Program<'_>,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut expand::Work,
) -> Outcome {
    let arithmetic_cancel = context.cancel.without_probe();
    let value = arithmetic::evaluate_program(
        program,
        state,
        &arithmetic_cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await;
    arithmetic_result(value, fds, context).await
}

async fn arithmetic_result(
    value: Result<i64, expand::Error>,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    match value {
        Ok(value) => Outcome::status(i32::from(value == 0)),
        Err(
            error @ expand::Error::Arithmetic {
                expansion: false, ..
            }
            | error @ expand::Error::Readonly {
                expansion: false, ..
            },
        ) => {
            let mut outcome = expansion_failure(error.into(), fds, context).await;
            outcome.flow = Flow::Normal;
            outcome
        }
        Err(error) => expansion_failure(error.into(), fds, context).await,
    }
}

async fn expansion_failure(error: CommandError, fds: &Descriptors, context: &Context) -> Outcome {
    let CommandError {
        error,
        stderr,
        heredoc_status,
    } = error;
    // External and unnamed commands expand heredocs in a command-local reader.
    // Shell builtins/functions and prefix RHS errors stay in the shell scope.
    let flow = if heredoc_status.is_some() {
        Flow::Normal
    } else if matches!(
        error,
        expand::Error::AssignmentDepth
            | expand::Error::BadArraySubscript { .. }
            | expand::Error::Arithmetic { .. }
            | expand::Error::Readonly { .. }
            | expand::Error::ShellBoundary {
                stage: expand::ShellBoundaryStage::Expansion,
                ..
            }
    ) {
        Flow::DiscardReadUnit
    } else {
        // Abort this submitted script, not the persistent interactive session.
        // Only the explicit exit builtin requests session shutdown.
        Flow::Abort
    };
    let (name, message, line, status) = match error {
        expand::Error::Status(code) => return Outcome::status(code),
        expand::Error::AssignmentDepth => return Outcome { code: 1, flow },
        expand::Error::SpecialAssignment { name, line } => {
            (name, "cannot assign in this way".to_owned(), line, 1)
        }
        expand::Error::BadArraySubscript { name, line } => {
            (name, "bad array subscript".to_owned(), line, 1)
        }
        expand::Error::Readonly { name, line, .. } => {
            (name, "readonly variable".to_owned(), line, 1)
        }
        expand::Error::Unbound { name, line } => (
            name,
            "unbound variable".to_owned(),
            line,
            heredoc_status.unwrap_or(context.parameter_error_status),
        ),
        expand::Error::ShellBoundary { stage, line } => (
            "arithmetic expression".to_owned(),
            "syntax error while looking for matching `)'".to_owned(),
            line,
            match stage {
                expand::ShellBoundaryStage::Word => 127,
                expand::ShellBoundaryStage::Expansion => 1,
            },
        ),
        expand::Error::Arithmetic { message, line, .. } => (
            "arithmetic expression".to_owned(),
            message.to_owned(),
            line,
            1,
        ),
        expand::Error::BadSubstitution { message, line } => {
            ("bad substitution".to_owned(), message.to_owned(), line, 1)
        }
        expand::Error::Parameter {
            name,
            message,
            line,
        } => (
            name,
            message,
            line,
            heredoc_status.unwrap_or(context.parameter_error_status),
        ),
        expand::Error::Indirect { name, unset, line } => (
            name,
            if unset {
                "invalid indirect expansion"
            } else {
                "invalid variable name"
            }
            .to_owned(),
            line,
            1,
        ),
    };
    // The expansion adapter reserves diagnostic space before owning these
    // strings. Check the complete spelling before format allocates its copy.
    let size = name.len().saturating_add(message.len()).saturating_add(96);
    if size > context.limits().expansion_bytes {
        return Outcome::status(2);
    }
    let diagnostic = match line {
        Some(line) => format!("/usr/bin/bash: line {line}: {name}: {message}\n"),
        None => format!("/usr/bin/bash: {name}: {message}\n"),
    };
    let stderr = match stderr {
        DiagnosticStderr::Inherited => fds.borrow().get(2),
        DiagnosticStderr::Redirected(stderr) => stderr,
    };
    if let Some(stderr) = stderr {
        let _ = stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await;
    }
    if context.cancel.is_cancelled() {
        return Outcome::status(130);
    }
    Outcome { code: status, flow }
}

async fn subshell(
    commands: Vec<Command>,
    redirs: Vec<Redirect>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut work = expansion_work(&context);
    let _task_allocation = match admit_task_metadata::<()>(&context, 1) {
        Ok(allocation) => allocation,
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    let child = match State::snapshot(&state, &context.cancel, &mut work).await {
        Ok(child) => child.shared(),
        Err(error) => return expansion_failure(error.into(), &fds, &context).await,
    };
    let parent_scope = context.scope.clone();
    // A subshell is an isolated Bash execution scope: a fatal fork failure
    // aborts this command without changing the foreground job's process group.
    // The outer reader still forwards its own cancellation into this token.
    let child_cancel = context.cancel.child();
    let child_context = Context {
        cancel: child_cancel.clone(),
        ..context.isolated()
    };
    let child_fds = Rc::new(RefCell::new(fds.borrow().clone()));
    drop(fds);
    let child = context.core.executor.spawn(async move {
        work.substitutions = Some(Substitutions {
            context: child_context.clone(),
            fds: child_fds.clone(),
            process_fds: None,
        });
        let result =
            match command_redirects(&redirs, &child, child_fds, &child_context, &mut work).await {
                Ok(fds) => {
                    work.substitutions.take();
                    let body_context = Context {
                        parameter_error_status: 1,
                        compound_child: false,
                        ..child_context.clone()
                    };
                    sequence(commands, child, fds, body_context).await
                }
                Err(outcome) => outcome,
            };
        child_context.finish_scope(parent_scope).await;
        result
    });
    let child_join = child.clone();
    let result = match context.cancel.run(child).await {
        Ok(result) => result,
        Err(_) => {
            child_cancel.cancel();
            let _ = child_join.await;
            Outcome::status(context.cancel_status())
        }
    };
    Outcome::status(result.code)
}

async fn list_command(
    list: CommandList,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    // `&` backgrounds the preceding AND/OR list, not the command after it.
    let mut first = *list.first;
    let mut links = Vec::new();
    let mut result;
    for (operator, next) in list.rest {
        if matches!(operator, ListOperator::And | ListOperator::Or) {
            links.push((operator, next));
            continue;
        }
        let command = and_or(first, std::mem::take(&mut links), list.span);
        result = if operator == ListOperator::Background {
            background(command, &state, &fds, &context).await
        } else {
            execute(command, state.clone(), fds.clone(), context.clone()).await
        };
        if result.flow != Flow::Normal || context.cancel.is_cancelled() {
            return result;
        }
        first = next;
    }
    // There are no separators left: evaluate AND/OR directly to avoid wrapping
    // the same AST into another list forever.
    result = execute(
        first,
        state.clone(),
        fds.clone(),
        if links.is_empty() {
            context.clone()
        } else {
            context.condition()
        },
    )
    .await;
    let count = links.len();
    for (index, (operator, next)) in links.into_iter().enumerate() {
        if result.flow != Flow::Normal || context.cancel.is_cancelled() {
            break;
        }
        if (operator == ListOperator::And && result.code == 0)
            || (operator == ListOperator::Or && result.code != 0)
        {
            result = execute(
                next,
                state.clone(),
                fds.clone(),
                if index + 1 == count {
                    context.clone()
                } else {
                    context.condition()
                },
            )
            .await;
        }
    }
    result
}
fn and_or(first: Command, rest: Vec<(ListOperator, Command)>, span: Span) -> Command {
    if rest.is_empty() {
        first
    } else {
        Command::List(CommandList {
            first: Box::new(first),
            rest,
            span,
        })
    }
}
#[inline(never)]
fn background<'a>(
    command: Command,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
) -> eval::Frame<'a> {
    context.evaluation.frame(
        background_body(command, state, fds, context),
        Outcome::status,
    )
}

async fn background_body(
    command: Command,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let result = launch_background(command, state, fds, context).await;
    let mut state = state.borrow_mut();
    state.publish_status(result.code);
    state.publish_pipeline_status(vec![result.code]);
    result
}

async fn launch_background(
    command: Command,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    context.core.reap_internal_jobs();
    if !context.core.has_job_capacity() {
        return Outcome::status(2);
    }
    let mut work = expansion_work(context);
    let child = match State::snapshot(state, &context.cancel, &mut work).await {
        Ok(child) => child.shared(),
        Err(error) => return expansion_failure(error.into(), fds, context).await,
    };
    let job = JobId(context.core.allocate_id());
    let identity = match async_identity(job, &context.cancel, &mut work).await {
        Ok(identity) => identity,
        Err(error) => return expansion_failure(error.into(), fds, context).await,
    };
    let limit = context.limits().expansion_bytes;
    let printed = command_string(
        &command,
        &Cell::new(limit),
        limit,
        Some(&context.parser_budget()),
    );
    let text = match printed {
        Ok(text) => text,
        Err(_) => {
            return Outcome::status(if context.cancel.is_cancelled() {
                context.cancel_status()
            } else {
                2
            });
        }
    };
    let storage = match context.evaluation.admit_storage(text.len()) {
        Ok(storage) => storage,
        Err(code) => return Outcome::status(code),
    };
    let label = Rc::new(JobLabel {
        text,
        _storage: storage,
    });
    let allocation = match admit_job(context) {
        Ok(allocation) => allocation,
        Err(error) => return expansion_failure(error.into(), fds, context).await,
    };
    // Snapshot checkpoints may have let another scope create async children.
    context.core.reap_completed_jobs();
    if context.core.jobs.borrow().len() >= context.limits().jobs {
        return Outcome::status(2);
    }
    let number = match context.core.allocate_job_number(&context.scope) {
        Ok(number) => number,
        Err(code) => return Outcome::status(code),
    };
    let group = context.core.host.allocate_background_group();
    let cancel = Cancel::new();
    let signal = Rc::new(Cell::new(None));
    let child_context = Context {
        core: context.core.clone(),
        source: context.source.clone(),
        reader: context.reader.clone(),
        lifetime: (cancel.clone(), signal.clone()),
        cancel: cancel.clone(),
        signal: signal.clone(),
        group,
        invocation_group: group,
        scope: Scope::new(context.core.allocate_id()),
        parameter_error_status: context.child_error_status(&command),
        compound_child: matches!(command, Command::Compound(..)),
        evaluation: context.evaluation.new_task(),
        loop_depth: 0,
        ignore_errexit: context.ignore_errexit,
        command_boundary: CommandBoundary::Ordinary,
    };
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    let parent_scope = context.scope.clone();
    let join = context.core.executor.spawn(async move {
        let mut processes = ProcessGroup::new(child_context.core.host.clone(), group)
            .with_signal(child_context.signal.clone());
        let result = execute(command, child, fds, child_context.clone()).await;
        child_context.finish_scope(parent_scope).await;
        child_context.finish_group(&mut processes, result).await
    });
    context.core.jobs.borrow_mut().insert(
        job,
        Job {
            label: Some(label),
            notified: false,
            owner: context.scope.clone(),
            kind: JobKind::Background(number),
            group,
            cancel,
            signal,
            join,
            _allocation: Some(allocation),
        },
    );
    state.borrow_mut().publish_async_identity(identity);
    Outcome::status(0)
}

fn admit_task_metadata<T>(
    context: &Context,
    count: usize,
) -> Result<crate::exec::Allocation, expand::Error> {
    let bytes = count
        .checked_mul(TASK_METADATA_BYTES + std::mem::size_of::<T>())
        .ok_or(2)?;
    context
        .evaluation
        .admit_execution(bytes)
        .map_err(Into::into)
}

fn admit_job(context: &Context) -> Result<crate::exec::Allocation, expand::Error> {
    // One conservative B-tree node plus fixed task/queue/cancellation metadata.
    let bytes = std::mem::size_of::<(JobId, Job)>()
        .checked_add(std::mem::size_of::<usize>())
        .and_then(|bytes| bytes.checked_mul(16))
        .and_then(|bytes| bytes.checked_add(TASK_METADATA_BYTES))
        .ok_or(2)?;
    context
        .evaluation
        .admit_execution(bytes)
        .map_err(Into::into)
}

async fn async_identity(
    id: JobId,
    cancel: &Cancel,
    work: &mut expand::Work,
) -> Result<String, expand::Error> {
    let bytes = id.0.checked_ilog10().unwrap_or(0) as usize + 1;
    work.admit_storage(bytes)?;
    for _ in 0..bytes {
        work.checkpoint(cancel).await?;
    }
    let mut identity = String::new();
    identity.try_reserve_exact(bytes).map_err(|_| 2)?;
    std::fmt::Write::write_fmt(&mut identity, format_args!("{}", id.0)).map_err(|_| 2)?;
    Ok(identity)
}

fn admission_status(error: expand::Error) -> i32 {
    match error {
        expand::Error::Status(code) => code,
        _ => 2,
    }
}
fn expansion_work(context: &Context) -> expand::Work {
    let limits = context.limits();
    expand::Work::new(
        limits
            .source_bytes
            .saturating_add(limits.expansion_bytes)
            .saturating_add(limits.arguments),
        limits.expansion_bytes,
        limits.arguments,
    )
    .with_frame_scope(context.evaluation.clone())
}
/// Expansion work that can run command substitutions with `fds` (the
/// descriptors in effect before the command's own redirections).
fn substitution_work(context: &Context, fds: &Descriptors) -> expand::Work {
    let mut work = expansion_work(context);
    work.substitutions = Some(Substitutions {
        context: context.clone(),
        fds: fds.clone(),
        process_fds: None,
    });
    work
}

/// Compound-local descriptor cleanup without retaining individual pipe ends.
struct ProcessSubstitutionFds {
    fds: Descriptors,
    opened: Cell<u64>,
    _allocation: crate::exec::Allocation,
}
impl Drop for ProcessSubstitutionFds {
    fn drop(&mut self) {
        let mut opened = self.opened.get();
        let mut fds = self.fds.borrow_mut();
        while opened != 0 {
            let fd = opened.trailing_zeros();
            opened &= opened - 1;
            // Bash closes the generated number even if exec replaced it;
            // deliberate duplicates at other descriptor numbers stay open.
            fds.remove(fd);
        }
    }
}

/// Runs `$(...)` bodies as subshell tasks. Expansion work carries one while it
/// expands a command's words; it is taken out before dispatch so its
/// descriptor reference cannot keep a pipe endpoint open during the command.
#[derive(Clone)]
pub(crate) struct Substitutions {
    context: Context,
    fds: Descriptors,
    process_fds: Option<Rc<ProcessSubstitutionFds>>,
}
impl Substitutions {
    pub(crate) fn filesystem(&self) -> Rc<dyn FileSystem> {
        self.context.core.fs.clone()
    }

    /// Start `commands` in an isolated copy of `state`, with stdout on a new
    /// pipe whose reader is returned. The body runs as its own executor task,
    /// so nested substitutions add no native or WASM stack depth.
    pub(crate) fn start(
        &self,
        commands: Vec<Command>,
        state: SharedState,
    ) -> Result<(io::Endpoint, SubstitutionTask), i32> {
        self.context.core.reap_internal_jobs();
        if !self.context.core.has_job_capacity() {
            return Err(2);
        }
        let allocation = admit_job(&self.context).map_err(admission_status)?;
        self.context.core.reap_completed_jobs();
        let (reader, writer) = self.context.fs().pipe().map_err(|error| error.status())?;
        let child = state;
        // Bash clears -e in command substitutions unless inherit_errexit is
        // enabled. Process substitutions and explicit subshells retain it.
        // The child already owns its state, including all shopt flags.
        {
            let mut state = child.borrow_mut();
            if !state.inherit_errexit {
                state.errexit = false;
            }
        }
        let mut table = self.fds.borrow().clone();
        table.insert(1, writer);
        let fds = Rc::new(RefCell::new(table));
        let cancel = Cancel::new();
        let group = self.context.core.host.allocate_background_group();
        let signal = Rc::new(Cell::new(None));
        let parent = self.context.cancel.clone();
        let parent_signal = self.context.signal.clone();
        let parent_scope = self.context.scope.clone();
        let context = Context {
            cancel: cancel.clone(),
            signal: signal.clone(),
            group,
            parameter_error_status: 1,
            compound_child: false,
            ..self.context.isolated()
        };
        let link = cancel.clone();
        let link_signal = signal.clone();
        let capture_complete = Cancel::new();
        let captured = capture_complete.clone();
        let (complete, completion) = futures::channel::oneshot::channel();
        let join = self.context.core.executor.spawn(async move {
            let mut processes = ProcessGroup::new(context.core.host.clone(), group)
                .with_signal(context.signal.clone());
            let body = async {
                let result = sequence(commands, child, fds, context.clone()).await;
                // Capturing waits for actual stdout EOF, not every background
                // job: redirected descendants may keep running after EOF.
                if context.cancel.run(captured.cancelled()).await.is_err() {
                    context.cleanup_jobs().await;
                }
                context.finish_scope(parent_scope).await;
                let code = if result.flow == Flow::SpawnFailed {
                    result.code
                } else if context.cancel.is_cancelled() {
                    context.cancel_status()
                } else {
                    result.code
                };
                // EOF releases capture, while this registered supervisor keeps
                // cleanup ownership of any host descendants still running.
                let _ = complete.send(code);
                context
                    .finish_group(&mut processes, Outcome { code, ..result })
                    .await
            };
            // The parent's cancellation reaches the body through its own
            // token; the body still unwinds normally and reports its status.
            let forward = async {
                parent.cancelled().await;
                if link_signal.get().is_none() {
                    link_signal.set(Some(parent_signal.get().unwrap_or(2)));
                }
                link.cancel();
                futures::future::pending::<()>().await
            };
            futures::pin_mut!(body, forward);
            match futures::future::select(body, forward).await {
                futures::future::Either::Left((code, _)) => code,
                futures::future::Either::Right(((), body)) => body.await,
            }
        });
        let core = &self.context.core;
        let id = JobId(core.allocate_id());
        core.jobs.borrow_mut().insert(
            id,
            Job {
                label: None,
                notified: false,
                owner: self.context.scope.clone(),
                kind: JobKind::Internal,
                group,
                cancel: cancel.clone(),
                signal: signal.clone(),
                join: join.clone(),
                _allocation: Some(allocation),
            },
        );
        Ok((
            reader,
            SubstitutionTask {
                cancel,
                capture_complete,
                join,
                completion,
                signal,
                parent_signal: self.context.signal.clone(),
                core: core.clone(),
                id,
                finished: false,
            },
        ))
    }
    /// Start `<(commands)` (`is_input`) or `>(commands)` as a job of this
    /// shell and open its end of the pipe in the command's descriptor table,
    /// at the highest free descriptor from 63 down, as bash does. Returns
    /// that descriptor; the caller expands it to `/dev/fd/N`. Simple commands
    /// own a copied table; compounds track generated numbers for scoped cleanup.
    pub(crate) fn process<'a>(
        &'a self,
        commands: Vec<Command>,
        is_input: bool,
        state: SharedState,
        parent_state: &'a SharedState,
        work: &'a mut expand::Work,
    ) -> eval::Frame<'a, Result<u32, i32>> {
        self.context.evaluation.frame(
            self.process_body(commands, is_input, state, parent_state, work),
            Err,
        )
    }

    async fn process_body(
        &self,
        commands: Vec<Command>,
        is_input: bool,
        state: SharedState,
        parent_state: &SharedState,
        work: &mut expand::Work,
    ) -> Result<u32, i32> {
        let fd = (3..=63u32)
            .rev()
            .find(|fd| self.fds.borrow().get(*fd).is_none())
            .ok_or(2)?;
        let core = &self.context.core;
        core.reap_internal_jobs();
        if !core.has_job_capacity() {
            return Err(2);
        }
        let job = JobId(core.allocate_id());
        let identity = async_identity(job, &self.context.cancel, work)
            .await
            .map_err(admission_status)?;
        let allocation = admit_job(&self.context).map_err(admission_status)?;
        core.reap_completed_jobs();
        if core.jobs.borrow().len() >= self.context.limits().jobs {
            return Err(2);
        }
        let (reader, writer) = self.context.fs().pipe().map_err(|error| error.status())?;
        let mut table = self.fds.borrow().clone();
        let parent_end = if is_input {
            table.insert(1, writer);
            reader
        } else {
            table.insert(0, reader);
            writer
        };
        let fds = Rc::new(RefCell::new(table));
        let child = state;
        let cancel = Cancel::new();
        let group = core.host.allocate_background_group();
        let signal = Rc::new(Cell::new(None));
        let context = Context {
            cancel: cancel.clone(),
            signal: signal.clone(),
            group,
            parameter_error_status: 1,
            compound_child: false,
            ..self.context.isolated()
        };
        let parent = self.context.cancel.clone();
        let parent_signal = self.context.signal.clone();
        let parent_scope = self.context.scope.clone();
        let link = cancel.clone();
        let link_signal = signal.clone();
        let join = core.executor.spawn(async move {
            let mut processes = ProcessGroup::new(context.core.host.clone(), group)
                .with_signal(context.signal.clone());
            let body = async {
                let result = sequence(commands, child, fds, context.clone()).await;
                let _ = context.wait_jobs(None, true).await;
                context.finish_scope(parent_scope).await;
                context.finish_group(&mut processes, result).await
            };
            let forward = async {
                parent.cancelled().await;
                if link_signal.get().is_none() {
                    link_signal.set(Some(parent_signal.get().unwrap_or(2)));
                }
                link.cancel();
                futures::future::pending::<()>().await
            };
            futures::pin_mut!(body, forward);
            match futures::future::select(body, forward).await {
                futures::future::Either::Left((code, _)) => code,
                futures::future::Either::Right(((), body)) => body.await,
            }
        });
        core.jobs.borrow_mut().insert(
            job,
            Job {
                label: None,
                notified: false,
                owner: self.context.scope.clone(),
                kind: JobKind::ProcessSubstitution,
                group,
                cancel,
                signal,
                join,
                _allocation: Some(allocation),
            },
        );
        self.fds.borrow_mut().insert(fd, parent_end);
        if let Some(process_fds) = &self.process_fds {
            process_fds
                .opened
                .set(process_fds.opened.get() | (1u64 << fd));
        }
        parent_state.borrow_mut().publish_async_identity(identity);
        Ok(fd)
    }
    /// Standard error of the shell running the substitution.
    pub(crate) fn stderr(&self) -> Option<io::Endpoint> {
        self.fds.borrow().get(2)
    }
    pub(crate) fn cancel(&self) -> &Cancel {
        &self.context.cancel
    }
}
/// Capture completion follows EOF. The registered join separately owns group
/// reaping; cancellation/errors drain it before releasing the capture.
pub(crate) struct SubstitutionTask {
    cancel: Cancel,
    capture_complete: Cancel,
    join: JoinHandle<i32>,
    completion: futures::channel::oneshot::Receiver<i32>,
    signal: Rc<Cell<Option<i32>>>,
    parent_signal: Rc<Cell<Option<i32>>>,
    core: Rc<Core>,
    id: JobId,
    finished: bool,
}
impl SubstitutionTask {
    pub(crate) fn cancel(&self) {
        if self.signal.get().is_none() {
            self.signal.set(Some(self.parent_signal.get().unwrap_or(2)));
        }
        self.cancel.cancel();
    }
    pub(crate) async fn finish(mut self) -> i32 {
        self.capture_complete.cancel();
        let code = (&mut self.completion).await.unwrap_or(130);
        if self.cancel.is_cancelled() {
            self.join.clone().await;
        }
        if self.join.is_finished() {
            self.core.jobs.borrow_mut().remove(&self.id);
        }
        self.finished = true;
        code
    }
}
impl Drop for SubstitutionTask {
    fn drop(&mut self) {
        if !self.finished {
            self.cancel();
        }
    }
}

/// Function words already retain raw spelling. For top-level declarations use
/// the unchanged lexer's raw-capture API on this command's bounded source span.
/// AST order supplies assignment/argument counts; operators stay lexer-owned.
async fn retain_declaration_syntax(
    simple: &mut SimpleCommand,
    source: &str,
    cancel: &Cancel,
) -> Result<(), i32> {
    if simple.name.raw.is_some() || !builtins::declaration_command(&simple.name) {
        return Ok(());
    }
    let source = source
        .get(simple.span.start.offset..simple.span.end.offset)
        .ok_or(2)?;
    let tokens = parse::declaration_tokens(source);
    let mut assignments = simple.assignments.len();
    let mut words = std::iter::once(&mut simple.name).chain(simple.args.iter_mut());
    let mut target = words.next();
    let mut redirect_operand = false;
    let mut budget = Budget::default();
    for token in tokens {
        budget.checkpoint(cancel).await.map_err(|_| 130)?;
        let Some(raw) = token.raw else {
            let spelling = &source[token.span.start.offset..token.span.end.offset];
            redirect_operand = spelling.ends_with(['<', '>'])
                || spelling.ends_with(">|")
                || spelling.ends_with(">&")
                || spelling.ends_with("<&");
            continue;
        };
        if redirect_operand {
            redirect_operand = false;
            continue;
        }
        if assignments > 0 {
            assignments -= 1;
            continue;
        }
        let word = target.take().ok_or(2)?;
        word.raw = Some(raw);
        target = words.next();
        if target.is_none() {
            return Ok(());
        }
    }
    Err(2)
}

struct PreparedCommand {
    line: Option<usize>,
    argv: Vec<String>,
    assigned: Vec<(String, String)>,
    fds: Descriptors,
    work: expand::Work,
}

async fn simple_command(
    simple: SimpleCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let line = simple.expansion_line;
    let original_fds = fds.clone();
    let prepared = match prepare_simple_command(simple, &state, fds, &context).await {
        Ok(prepared) => prepared,
        Err(error) => return expansion_failure(error.at_line(line), &original_fds, &context).await,
    };
    if prepared
        .argv
        .first()
        .is_some_and(|name| commands::handler(name) == Some(commands::Handler::Exec))
    {
        if prepared.argv.len() != 1 || !prepared.assigned.is_empty() {
            return Outcome::status(2);
        }
        *original_fds.borrow_mut() = prepared.fds.borrow().clone();
        return Outcome::status(0);
    }
    // Even a saved stderr can alias a pipe reader. Release all diagnostic-only
    // ownership before dispatch, so a child's close can deliver EPIPE promptly.
    let parent_stderr = match original_fds.borrow().get(2) {
        Some(stderr) => WeakStderr::Open(stderr.downgrade()),
        None => WeakStderr::Closed,
    };
    drop(original_fds);
    dispatch_simple_command(prepared, state, context, parent_stderr)
        .await
        .unwrap_or_else(Outcome::status)
}

#[inline(never)]
fn prepare_simple_command<'a>(
    simple: SimpleCommand,
    state: &'a SharedState,
    fds: Descriptors,
    context: &'a Context,
) -> eval::Frame<'a, Result<PreparedCommand, CommandError>> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        prepare_simple_command_body(simple, state, fds, context),
        |code| Err(code.into()),
    )
}

async fn prepare_simple_command_body(
    mut simple: SimpleCommand,
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
) -> Result<PreparedCommand, CommandError> {
    let line = simple.expansion_line;
    retain_declaration_syntax(&mut simple, &context.source, &context.cancel).await?;
    let assignment_count = simple.assignments.len();
    if assignment_count > context.limits().arguments {
        return Err(2.into());
    }
    let mut bytes = 0usize;
    let mut budget = Budget::default();
    // Process substitutions open descriptors for this command only.
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    let mut work = substitution_work(context, &fds);
    let mut argv = expand::fields(
        &simple.name,
        state,
        &context.cancel,
        expand::FieldContext::Argv,
        (
            context.limits().expansion_bytes,
            context.limits().arguments - assignment_count,
            context.limits().expansion_bytes,
        ),
        &mut work,
    )
    .await?;
    bytes += argv.iter().map(String::len).sum::<usize>();
    let declaration = builtins::declaration_command(&simple.name);
    for word in simple.args {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let remaining_bytes = context.limits().expansion_bytes.saturating_sub(bytes);
        let remaining_words = context
            .limits()
            .arguments
            .saturating_sub(assignment_count)
            .saturating_sub(argv.len());
        let fields = if declaration && builtins::assignment_operand(&word) {
            if remaining_words == 0 {
                return Err(2.into());
            }
            let value = expand::word(
                &word,
                state,
                &context.cancel,
                remaining_bytes,
                context.limits().expansion_bytes,
                &mut work,
            )
            .await?;
            work.consume_scalar_field();
            vec![value]
        } else {
            expand::fields(
                &word,
                state,
                &context.cancel,
                expand::FieldContext::Argv,
                (
                    remaining_bytes,
                    remaining_words,
                    context.limits().expansion_bytes,
                ),
                &mut work,
            )
            .await?
        };
        bytes += fields.iter().map(String::len).sum::<usize>();
        argv.extend(fields);
    }
    // Bash expands command words first. Assignment-only commands then assign
    // before redirects; named commands redirect before expanding prefix RHSs.
    if argv.is_empty() {
        assignments(
            simple.assignments,
            state,
            context,
            &mut bytes,
            &mut work,
            true,
            None,
        )
        .await?;
        let fds = redirects(&simple.redirects, state, fds, context, &mut work, Some(1)).await?;
        work.substitutions = None;
        return Ok(PreparedCommand {
            line,
            argv,
            assigned: Vec::new(),
            fds,
            work,
        });
    }
    let name = &argv[0];
    let shell_command = state.borrow().functions().contains_key(name)
        || commands::lookup(name).is_some_and(commands::Command::shell_heredoc_errors);
    let heredoc_status = (!shell_command).then_some(context.parameter_error_status);
    let fds = redirects(
        &simple.redirects,
        state,
        fds,
        context,
        &mut work,
        heredoc_status,
    )
    .await?;
    let function_prefix = state.borrow().functions().contains_key(name);
    let assigned = assignments(
        simple.assignments,
        state,
        context,
        &mut bytes,
        &mut work,
        false,
        function_prefix.then_some(&fds),
    )
    .await?;
    work.substitutions = None;
    Ok(PreparedCommand {
        line,
        argv,
        assigned,
        fds,
        work,
    })
}

async fn abort_diagnostic(
    fds: &Descriptors,
    context: &Context,
    message: &[u8],
    code: i32,
) -> Outcome {
    let error = fds.borrow().get(2);
    if let Some(error) = error {
        let _ = error.write_all(b"bash: ", &context.cancel).await;
        let _ = error.write_all(message, &context.cancel).await;
        let _ = error.write_all(b"\n", &context.cancel).await;
    }
    Outcome {
        code,
        flow: Flow::Abort,
    }
}

#[inline(never)]
fn dispatch_simple_command(
    prepared: PreparedCommand,
    state: SharedState,
    context: Context,
    parent_stderr: WeakStderr,
) -> eval::Frame<'static, Result<Outcome, i32>> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        dispatch_simple_command_body(prepared, state, context, parent_stderr),
        Err,
    )
}

async fn dispatch_simple_command_body(
    prepared: PreparedCommand,
    state: SharedState,
    context: Context,
    parent_stderr: WeakStderr,
) -> Result<Outcome, i32> {
    let PreparedCommand {
        line,
        argv,
        assigned,
        fds,
        mut work,
    } = prepared;
    let mut fields = argv.into_iter();
    let Some(mut name) = fields.next() else {
        // A command with no words left takes the status of the last command
        // substitution it ran (words, then redirects and assignments).
        return Ok(Outcome::status(work.substitution_status.unwrap_or(0)));
    };
    let mut bypass_functions = false;
    let mut default_path = false;
    let mut builtin_only = false;
    while matches!(
        commands::handler(&name),
        Some(commands::Handler::Command | commands::Handler::BuiltinWrapper)
    ) && (bypass_functions || !state.borrow().functions().contains_key(&name))
    {
        work.checkpoint(&context.cancel)
            .await
            .map_err(admission_status)?;
        builtin_only = commands::handler(&name) == Some(commands::Handler::BuiltinWrapper);
        let mut options = if builtin_only {
            builtin_wrapper::options(fields.as_slice(), line, &fds, &context).await?
        } else {
            command_builtin::options(fields.as_slice(), &fds, &context, &mut work).await?
        };
        default_path |= options.default_path;
        options.default_path = default_path;
        for _ in 0..options.operands {
            fields.next();
        }
        if options.query {
            let _frame = PrefixFrame::builtin(state.clone(), &assigned, &context.cancel, &mut work)
                .await
                .map_err(admission_status)?;
            return command_builtin::query(
                fields.as_slice(),
                &options,
                &state,
                &fds,
                &context,
                &mut work,
            )
            .await;
        }
        let Some(target) = fields.next() else {
            return Ok(Outcome::status(0));
        };
        name = target;
        bypass_functions = true;
    }
    let args: Vec<_> = fields.collect();
    // Ordinary function calls share shell state. Their temporary exported
    // bindings belong to call-local restore frames, not an isolated State.
    let function = if bypass_functions {
        None
    } else {
        state.borrow().functions().get(&name).cloned()
    };
    if let Some(body) = function {
        let funcnest = {
            let state = state.borrow();
            let target = state.scalar_target("FUNCNEST").ok().flatten();
            let prefix = assigned.iter().rev().find_map(|(name, value)| {
                (state.scalar_target(name).ok().flatten() == target && target.is_some())
                    .then_some(value.as_str())
            });
            prefix
                .or_else(|| state.scalar_parameter("FUNCNEST"))
                .and_then(|value| value.trim_matches([' ', '\t', '\n']).parse::<i64>().ok())
                .filter(|limit| *limit > 0)
                .and_then(|limit| usize::try_from(limit).ok())
                .unwrap_or(usize::MAX)
        };
        let limit = funcnest.min(context.limits().function_depth);
        if state.borrow().function_calls >= limit {
            let status = if funcnest <= context.limits().function_depth {
                1
            } else {
                2
            };
            return Ok(abort_diagnostic(
                &fds,
                &context,
                b"maximum function nesting level exceeded",
                status,
            )
            .await);
        }
        // Function syntax has a source-size budget independent of argv bytes.
        // Admit its execution copy before cloning even with a tiny argv ceiling.
        let source_bytes = context.limits().source_bytes;
        let mut copy_work = expand::Work::new(source_bytes, source_bytes, 0);
        if let Err(error) =
            crate::ast_copy::command(body.body.as_ref(), &context.cancel, &mut copy_work).await
        {
            return Ok(expansion_failure(error.into(), &fds, &context).await);
        }
        let copied_bytes = source_bytes - copy_work.storage_left();
        let call_storage = match context.evaluation.admit_execution(copied_bytes) {
            Ok(storage) => storage,
            Err(_) => {
                return Ok(abort_diagnostic(
                    &fds,
                    &context,
                    b"function live-memory limit exceeded",
                    2,
                )
                .await);
            }
        };
        for (name, value) in &assigned {
            let bytes = state
                .borrow()
                .declaration_storage(name, true)
                .map_err(admission_status)?;
            work.admit_storage(bytes).map_err(admission_status)?;
            State::admit_assignment(&state, name, value.len(), &context.cancel, &mut work)
                .await
                .map_err(admission_status)?;
        }
        let mut frame = match FunctionFrame::enter(state.clone(), args, limit) {
            Ok(frame) => frame,
            Err(_) => {
                return Ok(abort_diagnostic(
                    &fds,
                    &context,
                    b"function live-memory limit exceeded",
                    2,
                )
                .await);
            }
        };
        let trace_bytes = context
            .limits()
            .source_bytes
            .saturating_add(context.limits().expansion_bytes);
        let mut trace_work = expand::Work::new(trace_bytes, trace_bytes, 0);
        frame
            .trace(name, line.unwrap_or(1), &context.cancel, &mut trace_work)
            .await
            .map_err(admission_status)?;
        frame.prefixes(assigned)?;
        let context = Context {
            source: body.source.clone(),
            reader: body.reader.clone(),
            loop_depth: 0,
            command_boundary: CommandBoundary::FunctionBody,
            evaluation: context
                .evaluation
                .function_body()
                .with_retained(body.storage.clone()),
            ..context
        };
        // A boxed await still polls recursively. Join a separate task so both
        // polling and dropping one call stop at its handle, with unchanged depth.
        let task_allocation = Rc::new(
            admit_task_metadata::<JoinHandle<Outcome>>(&context, 1).map_err(admission_status)?,
        );
        let allocation = task_allocation.clone();
        let executor = context.core.executor.clone();
        let evaluation = context.evaluation.clone();
        let call = evaluation.frame(
            async move {
                let _frame = frame;
                let _call_storage = call_storage;
                let _allocation = allocation;
                let result = execute(
                    body.body.as_ref().clone(),
                    state.clone(),
                    fds.clone(),
                    context.clone(),
                )
                .await;
                trap::function_return(result, state, fds, context).await
            },
            Outcome::status,
        );
        let mut outcome = match call {
            futures::future::Either::Left(outcome) => outcome.await,
            futures::future::Either::Right(body) => executor.spawn(body).await,
        };
        drop(task_allocation);
        if outcome.flow == Flow::Return {
            outcome.flow = Flow::Normal;
        }
        return Ok(outcome);
    }
    let handler = commands::handler(&name);
    if handler == Some(commands::Handler::Let) {
        if !assigned.is_empty() {
            return Err(2);
        }
        return Ok(let_command(args, state, fds, context, work).await);
    }
    if handler == Some(commands::Handler::Eval) {
        if !assigned.is_empty() {
            return Err(2);
        }
        return Ok(eval::run(args, line, state, fds, context).await);
    }
    if handler == Some(commands::Handler::Source) {
        let _frame = PrefixFrame::builtin(state.clone(), &assigned, &context.cancel, &mut work)
            .await
            .map_err(admission_status)?;
        return Ok(source::run(&name, args, line, state, fds, context).await);
    }
    if handler == Some(commands::Handler::Type) {
        let _frame = PrefixFrame::builtin(state.clone(), &assigned, &context.cancel, &mut work)
            .await
            .map_err(admission_status)?;
        return type_builtin::run(&args, &state, &fds, &context, &mut work).await;
    }
    if let Some(commands::Handler::Builtin(builtin)) = handler {
        let _frame = PrefixFrame::builtin(state.clone(), &assigned, &context.cancel, &mut work)
            .await
            .map_err(admission_status)?;
        if builtin == commands::Builtin::Completion && name == "compgen" {
            work.substitutions = Some(Substitutions {
                context: context.clone(),
                fds: fds.clone(),
                process_fds: None,
            });
        }
        let bindings = fds.borrow().clone();
        return builtins::run(builtin, &name, args, state, bindings, context, &mut work).await;
    }
    if builtin_only {
        builtin_wrapper::missing(&name, line, &fds, &context).await?;
        return Ok(Outcome::status(1));
    }
    // A pipe named by an open descriptor exists but cannot be executed.
    if name.starts_with("/dev/fd/")
        && crate::io::descriptor_number(&name).is_some_and(|fd| fds.borrow().get(fd).is_some())
    {
        let diagnostic = format!("/usr/bin/bash: {name}: Permission denied\n");
        let stderr = fds.borrow().get(2);
        if let Some(stderr) = stderr {
            let _ = stderr
                .write_all(diagnostic.as_bytes(), &context.cancel)
                .await;
        }
        return Ok(Outcome::status(126));
    }
    let (executable, _executable_storage) = {
        let mut lookup = command_builtin::LookupWork::new(context.limits());
        // External prefix values already form the request environment. Lookup
        // reads its last PATH binding directly; installing a builtin frame here
        // would mutate shell state and double-charge exact argv boundaries.
        let path_override = assigned
            .iter()
            .rev()
            .find_map(|(key, value)| (key == "PATH").then_some(value.as_str()));
        match command_builtin::executable(
            &name,
            &state,
            default_path,
            path_override,
            &context,
            &mut lookup,
        )
        .await?
        {
            command_builtin::Resolution::Executable(path) => {
                // Keep the original path walk intact for the host. Lexically
                // removing file/../ before spawn could bypass ENOTDIR checks.
                path.into_parts()
            }
            command_builtin::Resolution::NonExecutable(path, reason) => {
                command_builtin::execution_failure(&fds, &context, &path.text, reason).await?;
                return Ok(Outcome::status(126));
            }
            command_builtin::Resolution::Missing => {
                let reason = if name.contains('/') {
                    b"No such file or directory".as_slice()
                } else {
                    b"command not found".as_slice()
                };
                command_builtin::execution_failure(&fds, &context, &name, reason).await?;
                return Ok(Outcome::status(127));
            }
        }
    };
    let (mut env, cwd) = {
        let s = state.borrow();
        (s.environment(), s.cwd.clone())
    };
    env.extend(assigned);
    let command = name.clone();
    let mut argv = vec![name];
    argv.extend(args);
    let pid = context.core.host.spawn(SpawnRequest {
        executable,
        argv,
        env,
        cwd,
        fds: fds.borrow().clone(),
        group: context.group,
        parent: None,
    });
    let pid = match pid {
        Ok(pid) => pid,
        Err(ProcessError::Runtime(errno @ (6 | 29 | 48))) => {
            return external_wait_failure(
                ProcessError::StartFailed(errno),
                &command,
                None,
                parent_stderr,
                &context,
            )
            .await;
        }
        Err(ProcessError::ProcessLimit) => {
            return external_wait_failure(
                ProcessError::StartFailed(6),
                &command,
                None,
                parent_stderr,
                &context,
            )
            .await;
        }
        Err(ProcessError::UnknownCommand(_) | ProcessError::Runtime(44)) => return Err(127),
        Err(ProcessError::Runtime(_)) => return Err(126),
        Err(_) => return Err(2),
    };
    // Keep only the diagnostic endpoint through startup, not through execution
    // or job teardown: a running producer can close output and await downstream EOF.
    let mut stderr = fds.borrow().get(2);
    drop(fds);
    let startup = context.cancel.run(context.core.host.wait_start(pid)).await;
    let failure = match startup {
        Ok(Err(error @ ProcessError::StartFailed(_))) => Some(
            external_wait_failure(error, &command, stderr.take(), parent_stderr, &context).await,
        ),
        Ok(Err(ProcessError::Runtime(11))) | Ok(Ok(())) | Err(_) => None,
        Ok(Err(_)) => {
            let _ = context.core.host.kill(pid, context.stop_signal());
            Some(Err(1))
        }
    };
    drop(stderr);
    if let Some(outcome) = failure {
        // Startup observation does not collect or await descriptor/FS cleanup.
        // Even a fork diagnostic that cancels this invocation must reap its child.
        match context.core.host.wait(pid).await {
            Ok(_) | Err(ProcessError::StartFailed(_)) => return outcome,
            Err(_) => return Err(1),
        }
    }
    match context.cancel.run(context.core.host.wait(pid)).await {
        Ok(Ok(status)) => Ok(Outcome::status(status)),
        Ok(Err(_)) => Err(1),
        Err(_) => {
            // Signal inherited members before waiting/reaping the direct child;
            // it may be the last live direct stage but not the last group member.
            if context.group != context.invocation_group || context.lifetime.0.is_cancelled() {
                let _ = context
                    .core
                    .host
                    .kill_group(context.group, context.stop_signal());
            }
            context
                .core
                .host
                .kill(pid, context.stop_signal())
                .map_err(|_| 1)?;
            context.core.host.wait(pid).await.map_err(|_| 1)?;
            Err(context.cancel_status())
        }
    }
}

async fn external_wait_failure(
    error: ProcessError,
    command: &str,
    stderr: Option<io::Endpoint>,
    parent_stderr: WeakStderr,
    context: &Context,
) -> Result<Outcome, i32> {
    let ProcessError::StartFailed(errno) = error else {
        return Err(1);
    };
    let fork = matches!(errno, 6 | 29 | 48);
    let operation = if fork { "fork" } else { command };
    // Fork errors use the caller's stderr, before command redirections. Only
    // that borrowed parent may need the shell fallback; closed stderr stays closed.
    let stderr = if fork {
        match parent_stderr {
            WeakStderr::Closed => None,
            WeakStderr::Open(stderr) => stderr
                .upgrade()
                .or_else(|| context.core.descriptors.borrow().get(2)),
        }
    } else {
        stderr
    };
    if let Some(stderr) = stderr {
        let diagnostic = format!("/usr/bin/bash: {operation}: {error}\n");
        let _ = stderr
            .write_all(diagnostic.as_bytes(), &context.cancel)
            .await;
    }
    if fork {
        // A failed fork abandons this reader, not just its pipeline stage.
        // Existing invocation cancellation owns peers and substitutions.
        context.cancel.cancel();
        return Ok(Outcome {
            code: 254,
            flow: Flow::SpawnFailed,
        });
    }
    Ok(Outcome::status(if errno == 44 { 127 } else { 126 }))
}

#[inline(never)]
fn let_command(
    args: Vec<String>,
    state: SharedState,
    fds: Descriptors,
    context: Context,
    mut work: expand::Work,
) -> eval::Frame<'static, Outcome> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(
        async move {
            if args.is_empty() {
                return arithmetic_command("()", &state, &fds, &context, &mut work).await;
            }
            let mut result = Outcome::status(0);
            for source in &args {
                let value = crate::arithmetic::evaluate_literal(
                    source,
                    &state,
                    &context.cancel,
                    context.limits().expansion_bytes,
                    &mut work,
                )
                .await;
                result = match value {
                    Ok(value) => Outcome::status(i32::from(value == 0)),
                    Err(error) => return literal_arithmetic_failure(error, &fds, &context).await,
                };
            }
            result
        },
        Outcome::status,
    )
}

async fn literal_arithmetic_failure(
    error: expand::Error,
    fds: &Descriptors,
    context: &Context,
) -> Outcome {
    let ordinary = matches!(
        error,
        expand::Error::Arithmetic {
            expansion: false,
            ..
        } | expand::Error::Readonly {
            expansion: false,
            ..
        }
    );
    let mut result = expansion_failure(error.into(), fds, context).await;
    if ordinary {
        result.flow = Flow::Normal;
    }
    result
}

async fn assignments(
    assignments: Vec<Assignment>,
    state: &SharedState,
    context: &Context,
    bytes: &mut usize,
    work: &mut expand::Work,
    commit: bool,
    function_diagnostics: Option<&Descriptors>,
) -> Result<Vec<(String, String)>, expand::Error> {
    if assignments.is_empty() {
        return Ok(Vec::new());
    }
    let mut completed = crate::state::AssignmentFrame::enter(state.clone())?;
    let result = assignments_body(
        assignments,
        state,
        context,
        bytes,
        work,
        (commit, function_diagnostics),
        &mut completed,
    )
    .await;
    if !matches!(
        result,
        Err(expand::Error::Status(
            2 | 130 | crate::exec::RESOURCE_STATUS
        ))
    ) {
        completed.keep();
    }
    result
}

async fn assignments_body(
    assignments: Vec<Assignment>,
    state: &SharedState,
    context: &Context,
    bytes: &mut usize,
    work: &mut expand::Work,
    mode: (bool, Option<&Descriptors>),
    completed: &mut crate::state::AssignmentFrame,
) -> Result<Vec<(String, String)>, expand::Error> {
    let (commit, function_diagnostics) = mode;
    if assignments.is_empty() {
        return Ok(Vec::new());
    }
    let mut frame = PrefixFrame::enter(state.clone());
    let mut names = Vec::new();
    let initial_bytes = *bytes;
    let mut budget = Budget::default();
    for assignment in assignments {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let indexed = assignment.index.is_some()
            || assignment.append
            || matches!(assignment.value, AssignmentValue::Array(_))
            || (commit
                && matches!(
                    state.borrow().binding(&assignment.name),
                    Some(crate::state::Binding::Indexed(_))
                ));
        if indexed && !commit {
            return Err(2.into());
        }
        if indexed {
            indexed::assign(&assignment, state, context, work, frame, bytes, completed).await?;
            frame = PrefixFrame::enter(state.clone());
            continue;
        }
        let AssignmentValue::Scalar(word) = assignment.value else {
            unreachable!()
        };
        let value = expand::assignment(
            &word,
            state,
            &context.cancel,
            context
                .limits()
                .expansion_bytes
                .saturating_sub(*bytes)
                .saturating_sub(assignment.name.len().saturating_add(1)),
            context.limits().expansion_bytes,
            work,
        )
        .await?;
        *bytes = bytes
            .saturating_add(assignment.name.len())
            .saturating_add(1)
            .saturating_add(value.len());
        if *bytes > context.limits().expansion_bytes {
            return Err(2.into());
        }
        expand::admit_assignment(state, &assignment.name, value.len(), &context.cancel, work)
            .await?;
        let storage = state
            .borrow()
            .binding(&assignment.name)
            .filter(|value| matches!(value, crate::state::Binding::Indexed(_)))
            .map_or(0, |value| {
                value
                    .storage_bytes()
                    .saturating_add(crate::state::Binding::node_bytes())
            });
        frame
            .reserve(&assignment.name, value.len().saturating_add(storage))
            .map_err(expand::Error::from)?;
        let retained = state
            .borrow()
            .binding(&assignment.name)
            .map_or(0, crate::state::Binding::storage_bytes);
        if commit {
            completed.reserve(&assignment.name, retained)?;
        }
        let value = if commit {
            state.borrow().case_value(&assignment.name, value)?
        } else {
            value
        };
        let assignment_name = assignment.name.clone();
        if let Err(name) = frame.set(assignment.name, value) {
            if let Some(fds) = function_diagnostics {
                let stderr = fds.borrow().get(2);
                if let Some(stderr) = stderr {
                    let _ = stderr.write_all(name.as_bytes(), &context.cancel).await;
                    let _ = stderr
                        .write_all(b": readonly variable\n", &context.cancel)
                        .await;
                }
                continue;
            }
            work.admit_storage(name.len().saturating_add(160))?;
            return Err(expand::Error::Readonly {
                name,
                line: None,
                expansion: true,
            });
        }
        names.push(assignment_name);
        if commit {
            frame.commit(Some(completed)).map_err(expand::Error::from)?;
            frame = PrefixFrame::enter(state.clone());
        }
    }
    if commit {
        return Ok(Vec::new());
    }
    let mut assigned = Vec::new();
    *bytes = initial_bytes;
    for name in names {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let state = state.borrow();
        let value = state.scalar_parameter(&name).ok_or(2)?;
        *bytes = bytes
            .saturating_add(name.len())
            .saturating_add(1)
            .saturating_add(value.len());
        if *bytes > context.limits().expansion_bytes {
            return Err(2.into());
        }
        if !commit {
            // PrefixFrame applied the assignment through its nameref. Preserve
            // that effective binding in the temporary environment, not the
            // source alias (which may itself be named PATH).
            let target = state.scalar_target(&name)?.ok_or(2)?;
            if target != name {
                work.admit_storage(target.len())?;
            }
            assigned.push((state.assignment_name(name)?, value.to_owned()));
        }
    }
    Ok(assigned)
}

async fn redirect_target(
    redirect: &Redirect,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
    reader_state: Option<&SharedState>,
) -> Result<String, expand::Error> {
    let reader = reader_state.cloned().unwrap_or_else(|| state.clone());
    expand::word(
        &redirect.target,
        &reader,
        &context.cancel,
        context.limits().expansion_bytes,
        context.limits().expansion_bytes,
        work,
    )
    .await
}

// Keep descriptor validation and diagnostic writes out of recursive poll frames.
#[inline(never)]
fn duplicate_descriptor<'a>(
    target: &'a str,
    line: Option<usize>,
    fds: &'a Descriptors,
    context: &'a Context,
    work: &'a mut expand::Work,
) -> eval::Frame<'a, Result<io::Endpoint, CommandError>> {
    context.evaluation.frame(
        async move {
            let mut source = Some(0u32);
            let mut first_nonzero = None;
            for (offset, byte) in target.bytes().enumerate() {
                work.checkpoint(&context.cancel).await?;
                if !byte.is_ascii_digit() {
                    return Err(2.into());
                }
                if byte != b'0' && first_nonzero.is_none() {
                    first_nonzero = Some(offset);
                }
                source = source
                    .and_then(|value| value.checked_mul(10))
                    .and_then(|value| value.checked_add(u32::from(byte - b'0')));
            }
            if target.is_empty() {
                return Err(2.into());
            }
            if let Some(endpoint) = source.and_then(|source| fds.borrow().get(source)) {
                return Ok(endpoint);
            }
            let stderr = fds.borrow().get(2);
            if let Some(stderr) = stderr {
                let source = &target.as_bytes()[first_nonzero.unwrap_or(target.len() - 1)..];
                // A bounded stack buffer handles the line number; the possibly
                // large target is borrowed and streamed without allocation.
                let mut digits = [0u8; std::mem::size_of::<usize>() * 3];
                let mut start = digits.len();
                let (label, separator): (&[u8], &[u8]) = if let Some(mut value) = line {
                    loop {
                        start -= 1;
                        digits[start] = b'0' + (value % 10) as u8;
                        value /= 10;
                        if value == 0 {
                            break;
                        }
                    }
                    (b"line ", b": ")
                } else {
                    (b"", b"")
                };
                let parts: [&[u8]; 6] = [
                    b"/usr/bin/bash: ",
                    label,
                    &digits[start..],
                    separator,
                    source,
                    b": Bad file descriptor\n",
                ];
                let bytes = parts
                    .iter()
                    .fold(0usize, |bytes, part| bytes.saturating_add(part.len()));
                if bytes > context.limits().expansion_bytes {
                    return Err(2.into());
                }
                for part in parts {
                    if stderr.write_all(part, &context.cancel).await.is_err() {
                        break;
                    }
                }
            }
            // A redirect error is not intrinsically fatal; the command's
            // existing errexit boundary decides whether execution continues.
            Err(if context.cancel.is_cancelled() {
                130.into()
            } else {
                1.into()
            })
        },
        |code| Err(code.into()),
    )
}

async fn redirects(
    redirs: &[Redirect],
    state: &SharedState,
    fds: Descriptors,
    context: &Context,
    work: &mut expand::Work,
    heredoc_status: Option<i32>,
) -> Result<Descriptors, CommandError> {
    if redirs.is_empty() {
        return Ok(fds);
    }
    let fds = Rc::new(RefCell::new(fds.borrow().clone()));
    // Target substitutions observe the redirections already applied, and
    // process substitutions insert their descriptors into this same table.
    if let Some(runner) = &mut work.substitutions {
        runner.fds = fds.clone();
    }
    let mut budget = Budget::default();
    // External and unnamed commands use one isolated reader shell for all
    // their here-documents. Each target sees the previous target's completed
    // assignments, while the snapshot remains detached from the caller.
    let mut reader_state: Option<SharedState> = None;
    for redirect in redirs {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        if redirect.fd_var.is_some() {
            return Err(2.into());
        }
        let reader_status = if matches!(
            redirect.kind,
            RedirectKind::HereDoc | RedirectKind::HereDocStrip
        ) {
            heredoc_status
        } else {
            None
        };
        let expands = redirect
            .target
            .parts
            .iter()
            .any(|part| !matches!(part, WordPart::Literal(_)));
        if reader_status.is_some() && expands && reader_state.is_none() {
            reader_state = Some(
                State::snapshot(state, &context.cancel, work)
                    .await
                    .map_err(|error| {
                        CommandError::redirect(
                            error.at_line(redirect.expansion_line),
                            fds.borrow().get(2),
                            reader_status,
                        )
                    })?
                    .shared(),
            );
        }
        let target_reader = reader_status.and(reader_state.as_ref());
        let target = redirect_target(redirect, state, context, work, target_reader)
            .await
            .map_err(|error| {
                CommandError::redirect(
                    error.at_line(redirect.expansion_line),
                    fds.borrow().get(2),
                    reader_status,
                )
            })?;
        let input = matches!(
            redirect.kind,
            RedirectKind::Input
                | RedirectKind::DupInput
                | RedirectKind::HereDoc
                | RedirectKind::HereDocStrip
                | RedirectKind::HereString
                | RedirectKind::ReadWrite
        );
        let fd = redirect.fd.unwrap_or(if input { 0 } else { 1 });
        let fd = u32::try_from(fd).map_err(|_| 2)?;
        match redirect.kind {
            RedirectKind::DupInput | RedirectKind::DupOutput => {
                if target == "-" {
                    fds.borrow_mut().remove(fd);
                } else {
                    let endpoint =
                        duplicate_descriptor(&target, redirect.expansion_line, &fds, context, work)
                            .await?;
                    fds.borrow_mut().insert(fd, endpoint);
                }
            }
            RedirectKind::HereDoc | RedirectKind::HereDocStrip | RedirectKind::HereString => {
                work.admit_storage(io::buffered_input_metadata_bytes())?;
                // The parser already removed `<<-` tabs; the body expanded
                // like a double-quoted word. A here-string gains a newline.
                let mut text = target;
                if redirect.kind == RedirectKind::HereString {
                    work.admit_storage(1)?;
                    text.try_reserve_exact(1).map_err(|_| 2)?;
                    text.push('\n');
                }
                fds.borrow_mut()
                    .insert(fd, io::Endpoint::bytes(text.into_bytes()));
            }
            RedirectKind::Input
            | RedirectKind::Output
            | RedirectKind::Clobber
            | RedirectKind::Append
            | RedirectKind::OutputBoth
            | RedirectKind::ReadWrite => {
                let path = absolute(&state.borrow().cwd, &target);
                let read_write = redirect.kind == RedirectKind::ReadWrite;
                let options = OpenOptions {
                    read: input,
                    write: !input || read_write,
                    create: !input || read_write,
                    truncate: matches!(
                        redirect.kind,
                        RedirectKind::Output | RedirectKind::Clobber | RedirectKind::OutputBoth
                    ),
                    append: redirect.kind == RedirectKind::Append,
                };
                let opening = io::open_path(&path, &fds.borrow(), &options)
                    .map_err(|error| error.status())?;
                let endpoint = context
                    .cancel
                    .run(opening.open(context.fs(), &options))
                    .await
                    .map_err(|_| 130)?
                    .map_err(|error| error.status())?;
                if redirect.kind == RedirectKind::OutputBoth {
                    fds.borrow_mut().insert(2, endpoint.clone());
                }
                fds.borrow_mut().insert(fd, endpoint);
            }
        }
    }
    Ok(fds)
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::{io::MemoryFs, process::InProcessHost};
    use futures::FutureExt;

    fn replay_context() -> (SharedState, Descriptors, Context) {
        let executor = Executor::new();
        let host = Rc::new(InProcessHost::new(executor.clone()));
        let group = host.allocate_group();
        let session = Session::new(
            executor,
            host,
            Rc::new(MemoryFs::new(4096)),
            Limits::default(),
        );
        let evaluation = crate::exec::Scope::new(
            session.core.limits.source_bytes,
            session.core.eval_storage.clone(),
            session.core.execution_storage.clone(),
        );
        let context = Context::root(
            session.core.clone(),
            "",
            evaluation,
            group,
            Cancel::new(),
            Rc::new(Cell::new(None)),
        );
        (session.state(), session.core.descriptors.clone(), context)
    }

    fn finish_replay(future: impl std::future::Future<Output = Outcome>) -> Outcome {
        futures::pin_mut!(future);
        for _ in 0..1000 {
            if let Some(outcome) = future.as_mut().now_or_never() {
                return outcome;
            }
        }
        panic!("arithmetic replay exceeded bounded polls");
    }

    #[test]
    fn counted_read_retains_and_refunds_its_buffer_on_pending_cancellation() {
        for option in [
            "-n2147483647",
            "-N2147483647",
            "-rn2147483647",
            "-rN2147483647",
        ] {
            check_pending_read_cancellation(option);
        }
    }

    fn check_pending_read_cancellation(option: &str) {
        let (state, _fds, context) = replay_context();
        let limit = context.limits().execution_bytes;
        let (reader, writer) = io::pipe();
        let mut fds = FdTable::default();
        fds.insert(0, reader);
        let mut work = expand::Work::new(1_000_000, 1_000_000, 16);
        let mut future = Box::pin(builtins::run(
            commands::Builtin::Read,
            "read",
            vec![option.into(), "value".into()],
            state.clone(),
            fds,
            context.clone(),
            &mut work,
        ));
        for _ in 0..1000 {
            assert!(future.as_mut().now_or_never().is_none());
        }
        assert!(
            state
                .borrow()
                .admit_temporary(limit - context.limits().line_bytes + 1)
                .is_err()
        );
        context.cancel.cancel();
        assert!(matches!(future.as_mut().now_or_never(), Some(Err(130))));
        drop(future);
        drop(state.borrow().admit_temporary(limit).unwrap());
        assert!(!state.borrow().bindings().contains_key("value"));
        drop(writer);
    }

    #[test]
    fn descriptor_diagnostics_stream_large_targets_without_storage_growth() {
        for (target, expected) in [
            ("8".repeat(8192), "8".repeat(8192)),
            (format!("{}9", "0".repeat(8192)), "9".to_owned()),
        ] {
            let (_state, fds, context) = replay_context();
            let (stderr, errors) = io::capture(16384);
            fds.borrow_mut().insert(2, stderr);
            let mut work = expand::Work::new(65536, 0, 16);
            let outcome = finish_replay(async {
                let error =
                    match duplicate_descriptor(&target, Some(2), &fds, &context, &mut work).await {
                        Ok(_) => panic!("descriptor must be closed"),
                        Err(error) => error,
                    };
                expansion_failure(error, &fds, &context).await
            });
            assert_eq!(outcome.code, 1);
            assert_eq!(outcome.flow, Flow::Normal);
            assert_eq!(
                errors.bytes(),
                format!("/usr/bin/bash: line 2: {expected}: Bad file descriptor\n").as_bytes()
            );
        }
    }

    #[test]
    fn descriptor_validation_observes_cancellation_during_long_numeric_targets() {
        let (_state, fds, mut context) = replay_context();
        let probes = Rc::new(Cell::new(0));
        let observed = probes.clone();
        context.cancel = Cancel::with_probe(Rc::new(move || {
            observed.set(observed.get() + 1);
            observed.get() >= 32
        }));
        let target = "0".repeat(8192);
        let mut work = expand::Work::new(65536, 0, 16);
        let outcome = finish_replay(async {
            let error =
                match duplicate_descriptor(&target, Some(1), &fds, &context, &mut work).await {
                    Ok(_) => panic!("cancelled validation must not return a descriptor"),
                    Err(error) => error,
                };
            expansion_failure(error, &fds, &context).await
        });
        assert_eq!(outcome.code, 130);
        assert_eq!(probes.get(), 32);
        assert!(context.cancel.is_cancelled());
    }

    #[test]
    fn terminal_integer_diagnostic_keeps_write_errors_and_streamed_prefix() {
        let (_state, _fds, context) = replay_context();
        let (reader, broken) = io::pipe();
        drop(reader);
        let (limited, errors) = io::capture(21);
        for (stderr, expected) in [
            (None, 0),
            (Some(io::pipe().0), 0),
            (Some(broken), 141),
            (Some(limited), 1),
        ] {
            let mut table = FdTable::default();
            if let Some(stderr) = stderr {
                table.insert(2, stderr);
            }
            let outcome = finish_replay(async {
                Outcome::status(
                    builtins::test::integer_diagnostic("test", "nope", &table, &context)
                        .await
                        .err()
                        .unwrap_or(0),
                )
            });
            assert_eq!(outcome.code, expected);
        }
        assert_eq!(errors.bytes(), b"/usr/bin/bash: test: ");
        context.cancel.cancel();
        assert_eq!(
            builtins::test::integer_diagnostic("test", "nope", &FdTable::default(), &context)
                .now_or_never(),
            Some(Err(130))
        );
    }

    #[test]
    fn terminal_integer_diagnostic_cancellation_releases_its_writer() {
        let (_state, _fds, context) = replay_context();
        let (reader, writer) = io::pipe();
        let mut table = FdTable::default();
        table.insert(2, writer);
        let operand = "x".repeat(2 * io::PIPE_CAPACITY);
        let mut diagnostic = Box::pin(builtins::test::integer_diagnostic(
            "test", &operand, &table, &context,
        ));
        for _ in 0..16 {
            assert!(diagnostic.as_mut().now_or_never().is_none());
        }
        context.cancel.cancel();
        let outcome = finish_replay(async { Outcome::status(diagnostic.await.unwrap_err()) });
        assert_eq!(outcome.code, 130);
        table.remove(2);
        let mut buffer = vec![0; io::PIPE_CAPACITY];
        assert_eq!(
            reader.read(&mut buffer).now_or_never(),
            Some(Ok(io::PIPE_CAPACITY))
        );
        assert!(buffer.starts_with(b"/usr/bin/bash: test: x"));
        assert_eq!(reader.read(&mut buffer).now_or_never(), Some(Ok(0)));
    }

    #[test]
    fn builtin_prefix_suspends_and_restores_the_dynamic_clock_hook() {
        let (state, _fds, context) = replay_context();
        assert!(state.borrow().dynamic_parameter("EPOCHREALTIME"));
        let assigned = [("EPOCHREALTIME".to_owned(), "prefix".to_owned())];
        let mut work = expand::Work::new(65536, 65536, 16);
        finish_replay(async {
            let frame = PrefixFrame::builtin(state.clone(), &assigned, &context.cancel, &mut work)
                .await
                .unwrap_or_else(|_| panic!("prefix storage must fit"));
            assert_eq!(state.borrow().parameter("EPOCHREALTIME"), "prefix");
            assert!(!state.borrow().dynamic_parameter("EPOCHREALTIME"));
            context.cancel.cancel();
            drop(frame);
            assert!(state.borrow().dynamic_parameter("EPOCHREALTIME"));
            assert!(!state.borrow().bindings().contains_key("EPOCHREALTIME"));
            Outcome::status(0)
        });
    }

    #[test]
    fn borrowed_arithmetic_replay_preserves_execution_depth_and_status() {
        for (depth, code) in [(255, 0), (256, 2)] {
            let (state, fds, mut context) = replay_context();
            state.borrow_mut().publish_status(13);
            state.borrow_mut().publish_pipeline_status(vec![9, 13]);
            for _ in 0..depth {
                context.evaluation = context.evaluation.descend().unwrap();
            }
            let commands = [Command::Compound(
                CompoundCommand::Arithmetic("n=7".into()),
                Vec::new(),
            )];
            let outcome = finish_replay(loop_sequence(&commands, &state, &fds, &context, None));
            assert_eq!(outcome.code, code);
            assert_eq!(outcome.flow, Flow::Normal);
            assert_eq!(state.borrow().bindings().contains_key("n"), code == 0);
            assert_eq!(state.borrow().status(), if code == 0 { 0 } else { 13 });
            assert_eq!(
                state.borrow().pipeline_status(),
                if code == 0 { vec![0] } else { vec![9, 13] }
            );
        }
    }

    #[test]
    fn borrowed_arithmetic_replay_admits_its_frame_and_releases_it_on_drop() {
        let (state, fds, context) = replay_context();
        let limit =
            usize::try_from(shell_parser::limits::ExecutionLimits::default().max_work_units)
                .unwrap();
        let allocation = context.evaluation.admit_execution(limit).unwrap();
        let commands = [Command::Compound(
            CompoundCommand::Arithmetic("n=7".into()),
            Vec::new(),
        )];
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            2
        );
        assert!(!state.borrow().bindings().contains_key("n"));
        drop(allocation);
        let replay = loop_sequence(&commands, &state, &fds, &context, None);
        assert!(context.evaluation.admit_execution(limit).is_err());
        drop(replay);
        drop(context.evaluation.admit_execution(limit).unwrap());
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            0
        );
        assert_eq!(state.borrow().bindings()["n"], "7");
        drop(context.evaluation.admit_execution(limit).unwrap());
    }

    #[test]
    fn borrowed_arithmetic_replay_keeps_compound_context_and_pre_cancel_checks() {
        let (state, fds, mut context) = replay_context();
        context.compound_child = true;
        let commands = [Command::Compound(
            CompoundCommand::Arithmetic("${missing:?required}".into()),
            Vec::new(),
        )];
        let outcome = finish_replay(loop_sequence(&commands, &state, &fds, &context, None));
        assert_eq!(outcome.code, 1);
        assert_eq!(outcome.flow, Flow::Abort);
        assert_eq!(context.parameter_error_status, 127);
        context.cancel.cancel();
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            130
        );
    }

    #[test]
    fn borrowed_arithmetic_replay_keeps_command_storage_admission() {
        let (state, fds, mut context) = replay_context();
        Rc::get_mut(&mut context.core)
            .unwrap()
            .limits
            .expansion_bytes = 0;
        let commands = [Command::Compound(
            CompoundCommand::Arithmetic("n=7".into()),
            Vec::new(),
        )];
        assert_eq!(
            finish_replay(loop_sequence(&commands, &state, &fds, &context, None)).code,
            2
        );
        assert!(!state.borrow().bindings().contains_key("n"));
        assert_eq!(state.borrow().pipeline_status(), vec![2]);
    }

    #[test]
    fn later_descendant_transfers_follow_already_forwarded_parent_handles() {
        let root = Scope::new(0);
        let outer = Scope::new(1);
        let middle = Scope::new(2);
        let inner = Scope::new(3);
        let captured_outer = outer.clone();
        let captured_middle = middle.clone();
        outer.forward_to(root);
        middle.forward_to(captured_outer);
        inner.forward_to(captured_middle);
        assert_eq!(inner.resolved_id(), 0);
    }

    #[test]
    fn successive_background_handoffs_do_not_retain_exited_ancestors() {
        let mut parent = Scope::new(0);
        for id in 1..1000 {
            let child = Scope::new(id);
            child.forward_to(parent);
            assert_eq!(child.0.parent.borrow().as_ref().unwrap().0.id, 0);
            parent = child;
        }
        assert_eq!(parent.resolved_id(), 0);
    }

    #[test]
    fn earlier_descendant_transfers_follow_later_ancestor_exits() {
        let root = Scope::new(0);
        let outer = Scope::new(1);
        let middle = Scope::new(2);
        let inner = Scope::new(3);
        inner.forward_to(middle.clone());
        middle.forward_to(outer.clone());
        assert_eq!(inner.resolved_id(), 1);
        outer.forward_to(root);
        assert_eq!(inner.resolved_id(), 0);
    }
}

#[cfg(test)]
mod residual_review_tests {
    use super::*;
    use crate::{
        io::{Capture, Endpoint, MemoryFs},
        process::{InProcessHost, ProcessId},
    };
    use futures::future::LocalBoxFuture;

    struct Host {
        inner: InProcessHost,
        executor: Executor,
        direct: RefCell<BTreeMap<GroupId, ProcessId>>,
        signals: RefCell<Vec<GroupId>>,
        abandoned: RefCell<Vec<GroupId>>,
        interrupt: Cell<bool>,
        fail_detach: Cell<bool>,
        cleanup_error: Cell<bool>,
        release: Cancel,
        signal_error: Cell<bool>,
        release_on_signals: RefCell<Option<(Vec<GroupId>, Cancel)>>,
    }
    impl ProcessHost for Host {
        fn allocate_group(&self) -> GroupId {
            self.inner.allocate_group()
        }
        fn allocate_background_group(&self) -> GroupId {
            self.inner.allocate_background_group()
        }
        fn interrupted(&self) -> bool {
            self.interrupt.replace(false)
        }
        fn access(
            &self,
            path: String,
            cwd: String,
        ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
            self.inner.access(path, cwd)
        }
        fn spawn(&self, request: SpawnRequest) -> Result<ProcessId, ProcessError> {
            let group = request.group;
            let direct = request.parent.is_none();
            let pid = self.inner.spawn(request)?;
            if direct {
                self.direct.borrow_mut().insert(group, pid);
            }
            Ok(pid)
        }
        fn wait_start(
            &self,
            pid: ProcessId,
        ) -> futures::future::LocalBoxFuture<'static, Result<(), ProcessError>> {
            self.inner.wait_start(pid)
        }
        fn wait(&self, pid: ProcessId) -> LocalBoxFuture<'static, Result<i32, ProcessError>> {
            self.inner.wait(pid)
        }
        fn kill(&self, pid: ProcessId, signal: i32) -> Result<(), ProcessError> {
            self.inner.kill(pid, signal)
        }
        fn wait_direct_group(
            &self,
            group: GroupId,
        ) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
            self.inner.wait_direct_group(group)
        }
        fn detach_group(&self, group: GroupId) -> JoinHandle<Result<(), ProcessError>> {
            if self.cleanup_error.get() {
                JoinHandle::ready(Err(ProcessError::Runtime(8)))
            } else if self.fail_detach.replace(false) {
                self.executor.spawn(async { Err(ProcessError::Runtime(8)) })
            } else {
                self.inner.detach_group(group)
            }
        }
        fn kill_group(&self, group: GroupId, signal: i32) -> Result<(), ProcessError> {
            self.signals.borrow_mut().push(group);
            if let Some((groups, release)) = &*self.release_on_signals.borrow()
                && groups
                    .iter()
                    .all(|group| self.signals.borrow().contains(group))
            {
                release.cancel();
            }
            self.inner.kill_group(group, signal)?;
            if self.signal_error.get() {
                Err(ProcessError::Runtime(8))
            } else {
                Ok(())
            }
        }
        fn wait_group(&self, group: GroupId) -> LocalBoxFuture<'static, Result<(), ProcessError>> {
            if self.cleanup_error.get() {
                futures::future::ready(Err(ProcessError::Runtime(8))).boxed_local()
            } else {
                self.inner.wait_group(group)
            }
        }
        fn abandon_group(&self, group: GroupId, signal: i32) {
            self.abandoned.borrow_mut().push(group);
            self.inner.abandon_group(group, signal);
        }
    }
    struct Harness {
        executor: Executor,
        host: Rc<Host>,
        session: Option<Session>,
        output: Capture,
    }
    impl Harness {
        fn new() -> Self {
            let executor = Executor::new();
            let host = Rc::new(Host {
                inner: InProcessHost::new(executor.clone()),
                executor: executor.clone(),
                direct: RefCell::new(BTreeMap::new()),
                signals: RefCell::new(Vec::new()),
                abandoned: RefCell::new(Vec::new()),
                interrupt: Cell::new(false),
                fail_detach: Cell::new(false),
                cleanup_error: Cell::new(false),
                release: Cancel::new(),
                signal_error: Cell::new(false),
                release_on_signals: RefCell::new(None),
            });
            let release = host.release.clone();
            host.inner.register("/home/guest/sleep", move |request, _| {
                let release = release.clone();
                async move {
                    release.cancelled().await;
                    drop(request);
                    23
                }
                .boxed_local()
            });
            let weak = Rc::downgrade(&host);
            host.inner
                .register("/home/guest/inherit", move |mut request, _| {
                    let host = weak.upgrade().unwrap();
                    async move {
                        request.parent = Some(host.direct.borrow()[&request.group]);
                        request.executable = "/home/guest/sleep".into();
                        request.argv = vec!["sleep".into()];
                        host.spawn(request).unwrap();
                        0
                    }
                    .boxed_local()
                });
            let session = Session::new(
                executor.clone(),
                host.clone(),
                Rc::new(MemoryFs::new(65536)),
                Limits::default(),
            );
            let (out, output) = io::capture(65536);
            let mut fds = FdTable::default();
            fds.insert(0, Endpoint::null());
            fds.insert(1, out);
            fds.insert(2, Endpoint::null());
            session.set_descriptors(fds).unwrap();
            Self {
                executor,
                host,
                session: Some(session),
                output,
            }
        }
        fn session(&self) -> &Session {
            self.session.as_ref().unwrap()
        }
        fn finish<T: Clone>(&self, join: JoinHandle<T>) -> T {
            for _ in 0..2000 {
                if join.is_finished() {
                    return join.now_or_never().unwrap();
                }
                self.executor.drive(64);
            }
            panic!("review control exceeded bounded executor turns");
        }
        fn run(&self, source: &str) -> i32 {
            self.finish(self.session().start(source).unwrap())
        }
        fn context(&self) -> Context {
            let core = self.session().core.clone();
            let cancel = Cancel::new();
            let signal = Rc::new(Cell::new(None));
            let group = self.host.allocate_group();
            let evaluation = crate::exec::Scope::new(
                core.limits.source_bytes,
                core.eval_storage.clone(),
                core.execution_storage.clone(),
            );
            Context::root(core, "", evaluation, group, cancel, signal)
        }

        fn shutdown(mut self) {
            let session = self.session.take().unwrap();
            self.finish(self.executor.spawn(async move { session.shutdown().await }));
            assert_eq!(self.host.inner.retained_count(), 0);
            assert_eq!(self.executor.drive(256).pending, 0);
        }
    }

    #[test]
    fn residual_review_successful_process_substitution_transfers_nested_residual() {
        let rig = Harness::new();
        let source = r#"consume() { while IFS= read -r line; do printf '%s\n' "$line"; done < "$1"; }; consume <(x=$(inherit >/dev/null); echo READY); wait "$!""#;
        assert_eq!(rig.run(source), 0);
        assert_eq!(rig.output.bytes(), b"READY\n");
        assert_eq!(
            rig.host.inner.active_count(),
            1,
            "success must leave inherited work alive"
        );
        assert!(rig.host.signals.borrow().is_empty());
        rig.shutdown();
    }
    #[test]
    fn residual_review_monitor_never_consumes_foreground_host_interrupt() {
        let rig = Harness::new();
        let context = rig.context();
        let gate = Cancel::new();
        let release = gate.clone();
        let cleanup = rig.executor.spawn(async move {
            gate.cancelled().await;
            Ok(())
        });
        let host = rig.host.clone();
        let lifetime = Cancel::with_probe(Rc::new(move || host.interrupted()));
        context.core.retain_residual(
            context.group,
            context.scope.clone(),
            cleanup,
            (lifetime, context.signal.clone()),
        );
        rig.host.interrupt.set(true);
        rig.executor.drive(256);
        let untouched = rig.host.interrupt.replace(false);
        release.cancel();
        rig.executor.drive(256);
        assert!(
            untouched,
            "a residual monitor must only observe explicit lifetime cancellation"
        );
        drop(context);
        rig.shutdown();
    }
    #[test]
    fn residual_review_explicit_process_substitution_wait_recycles_capacity() {
        let rig = Harness::new();
        assert_eq!(
            rig.run("for ((i=0; i<140; i++)); do : <(:) || exit $?; wait \"$!\" || exit $?; done; echo READY"),
            0
        );
        assert_eq!(rig.output.bytes(), b"READY\n");
        rig.shutdown();
    }
    #[test]
    fn residual_review_drop_retries_failed_descendant_cleanup() {
        let mut rig = Harness::new();
        rig.host.fail_detach.set(true);
        assert_eq!(rig.run("inherit"), 0);
        rig.executor.drive(256);
        assert_eq!(rig.host.inner.active_count(), 1);
        drop(rig.session.take().unwrap());
        rig.executor.drive(256);
        assert_eq!(
            rig.host.inner.retained_count(),
            0,
            "Drop must transfer confirmed reaping, not only signal"
        );
        assert!(!rig.host.abandoned.borrow().is_empty());
        assert_eq!(rig.executor.drive(256).pending, 0);
    }
    #[test]
    fn residual_review_scope_cleanup_signals_all_groups_before_waiting() {
        let rig = Harness::new();
        let context = rig.context();
        let groups = vec![rig.host.allocate_group(), rig.host.allocate_group()];
        let gate = Cancel::new();
        *rig.host.release_on_signals.borrow_mut() = Some((groups.clone(), gate.clone()));
        for group in groups {
            let gate = gate.clone();
            let cleanup = rig.executor.spawn(async move {
                gate.cancelled().await;
                Ok(())
            });
            context.core.retain_residual(
                group,
                context.scope.clone(),
                cleanup,
                context.lifetime.clone(),
            );
        }
        rig.finish(
            rig.executor
                .spawn(async move { context.cleanup_jobs().await }),
        );
        rig.shutdown();
    }
    #[test]
    fn residual_review_scope_and_shutdown_signal_residuals_before_shell_task_joins() {
        for shutdown in [false, true] {
            let mut rig = Harness::new();
            let context = rig.context();
            let gate = Cancel::new();
            *rig.host.release_on_signals.borrow_mut() = Some((vec![context.group], gate.clone()));
            let release = gate.clone();
            let cleanup = rig.executor.spawn(async move {
                release.cancelled().await;
                Ok(())
            });
            context.core.retain_residual(
                context.group,
                context.scope.clone(),
                cleanup,
                context.lifetime.clone(),
            );
            let join = rig.executor.spawn(async move {
                gate.cancelled().await;
                130
            });
            context.core.jobs.borrow_mut().insert(
                JobId(context.core.allocate_id()),
                Job {
                    label: None,
                    notified: false,
                    owner: context.scope.clone(),
                    kind: JobKind::Internal,
                    group: rig.host.allocate_group(),
                    cancel: Cancel::new(),
                    signal: Rc::new(Cell::new(None)),
                    join,
                    _allocation: None,
                },
            );
            if shutdown {
                let session = rig.session.take().unwrap();
                rig.finish(rig.executor.spawn(async move { session.shutdown().await }));
                drop(context);
                assert_eq!(rig.executor.drive(256).pending, 0);
            } else {
                rig.finish(
                    rig.executor
                        .spawn(async move { context.cleanup_jobs().await }),
                );
                rig.shutdown();
            }
        }
    }
    #[test]
    fn residual_review_signal_error_does_not_retain_successfully_reaped_groups() {
        let rig = Harness::new();
        let context = rig.context();
        let gate = Cancel::new();
        *rig.host.release_on_signals.borrow_mut() = Some((vec![context.group], gate.clone()));
        rig.host.signal_error.set(true);
        let cleanup = rig.executor.spawn(async move {
            gate.cancelled().await;
            Ok(())
        });
        context.core.retain_residual(
            context.group,
            context.scope.clone(),
            cleanup,
            context.lifetime.clone(),
        );
        context.cancel.cancel();
        rig.executor.drive(256);
        assert_eq!(
            context.core.residuals.borrow()[&context.group]
                .cleanup
                .clone()
                .now_or_never(),
            Some(Ok(()))
        );
        rig.host.signal_error.set(false);
        let next = rig.host.allocate_group();
        let cleanup = rig.executor.spawn(async { Ok(()) });
        context.core.retain_residual(
            next,
            context.scope.clone(),
            cleanup,
            (Cancel::new(), context.signal.clone()),
        );
        assert!(!context.core.residuals.borrow().contains_key(&context.group));
        drop(context);
        rig.shutdown();
    }
    #[test]
    fn residual_review_internal_background_transfer_discards_job_label() {
        let rig = Harness::new();
        assert_eq!(rig.run("(sleep &)"), 0);
        assert!(
            rig.session()
                .core
                .jobs
                .borrow()
                .values()
                .any(|job| job.kind == JobKind::Internal && !job.join.is_finished())
        );
        assert!(
            rig.session()
                .core
                .jobs
                .borrow()
                .values()
                .filter(|job| job.kind == JobKind::Internal)
                .all(|job| job.label.is_none())
        );
        rig.shutdown();
    }
    #[test]
    fn residual_review_ready_builtin_completion_enqueues_no_cleanup_tasks() {
        let rig = Harness::new();
        for _ in 0..140 {
            let command = rig.session().start(":").unwrap();
            // Include the normal interpreter stage, but stop at foreground
            // completion before any extra cleanup task can run.
            let mut polls = 0;
            let turn = loop {
                let turn = rig.executor.drive(1);
                polls += turn.polls;
                assert!(
                    polls <= 4,
                    "builtin exceeded its normal foreground task bound"
                );
                if command.is_finished() {
                    break turn;
                }
            };
            assert_eq!(command.now_or_never(), Some(0));
            assert_eq!(
                turn.pending, 0,
                "builtin completion must not enqueue a cleanup monitor"
            );
            assert!(!turn.runnable);
            assert!(rig.session().core.residuals.borrow().is_empty());
        }
        rig.shutdown();
    }
    #[test]
    fn residual_review_ready_failed_cleanup_keeps_ownership_without_a_monitor() {
        let rig = Harness::new();
        rig.host.cleanup_error.set(true);
        let context = rig.context();
        context.core.retain_residual(
            context.group,
            context.scope.clone(),
            JoinHandle::ready(Err(ProcessError::Runtime(8))),
            context.lifetime.clone(),
        );
        assert_eq!(rig.executor.drive(64).polls, 0);
        assert_eq!(
            context.core.residuals.borrow()[&context.group]
                .cleanup
                .clone()
                .now_or_never(),
            Some(Err(ProcessError::Runtime(8)))
        );
        let complete = rig.host.allocate_group();
        context.core.retain_residual(
            complete,
            context.scope.clone(),
            JoinHandle::ready(Ok(())),
            context.lifetime.clone(),
        );
        assert_eq!(rig.executor.drive(64).polls, 0);
        assert_eq!(context.core.residuals.borrow().len(), 1);
        let retry = context.clone();
        rig.finish(
            rig.executor
                .spawn(async move { retry.cleanup_jobs().await }),
        );
        assert_eq!(
            context.core.residuals.borrow().len(),
            1,
            "failed scope retry must preserve ownership"
        );
        assert_eq!(rig.executor.drive(256).pending, 0);
        rig.host.cleanup_error.set(false);
        context.core.retain_residual(
            rig.host.allocate_group(),
            context.scope.clone(),
            JoinHandle::ready(Ok(())),
            context.lifetime.clone(),
        );
        assert!(
            context.core.residuals.borrow().is_empty(),
            "a healed failed retry must release ownership"
        );
        drop(context);
        rig.shutdown();
    }
    #[test]
    fn residual_review_failed_scope_cleanup_retries_before_cancellation_returns() {
        let rig = Harness::new();
        rig.host.fail_detach.set(true);
        let command = rig
            .session()
            .start("(x=$(inherit >/dev/null); sleep)")
            .unwrap();
        let mut ready = false;
        for _ in 0..2000 {
            rig.executor.drive(1);
            if rig.host.inner.active_count() == 2
                && rig
                    .session()
                    .core
                    .residuals
                    .borrow()
                    .values()
                    .any(|residual| {
                        residual.cleanup.is_finished()
                            && matches!(residual.cleanup.clone().now_or_never(), Some(Err(_)))
                    })
            {
                ready = true;
                break;
            }
        }
        assert!(
            ready,
            "isolated scope must own both the failed residual and blocked shell command"
        );
        rig.session().interrupt();
        assert_eq!(rig.finish(command), 130);
        assert_eq!(
            rig.host.inner.retained_count(),
            0,
            "scope exit must confirm reaping after a failed observer"
        );
        assert!(rig.session().core.residuals.borrow().is_empty());
        rig.shutdown();
    }
    #[test]
    fn residual_review_healed_errors_do_not_accumulate_core_ownership() {
        let rig = Harness::new();
        rig.host.release.cancel();
        for _ in 0..4097 {
            rig.host.fail_detach.set(true);
            assert_eq!(rig.run("inherit"), 0);
            rig.executor.drive(256);
            assert!(
                rig.session().core.residuals.borrow().len() <= 1,
                "healed ownership must be retired at the next completion checkpoint"
            );
            assert!(rig.host.inner.retained_count() <= 1);
        }
        assert_eq!(rig.run(":"), 0);
        assert!(rig.session().core.residuals.borrow().is_empty());
        assert_eq!(rig.host.inner.retained_count(), 0);
        assert!(
            rig.host.signals.borrow().is_empty(),
            "natural retries must not signal"
        );
        rig.shutdown();
    }
    #[test]
    fn residual_review_pending_error_retry_keeps_original_lifetime_cancellation() {
        let rig = Harness::new();
        let context = rig.context();
        rig.host
            .spawn(SpawnRequest {
                executable: "/home/guest/inherit".into(),
                argv: vec!["inherit".into()],
                env: BTreeMap::new(),
                cwd: "/".into(),
                fds: rig.session().core.descriptors.borrow().clone(),
                group: context.group,
                parent: None,
            })
            .unwrap();
        rig.executor.drive(256);
        rig.host.fail_detach.set(true);
        let cleanup = rig.host.detach_group(context.group);
        rig.executor.drive(256);
        context.core.retain_residual(
            context.group,
            context.scope.clone(),
            cleanup,
            context.lifetime.clone(),
        );
        let next = rig.host.allocate_group();
        context.core.retain_residual(
            next,
            context.scope.clone(),
            JoinHandle::ready(Ok(())),
            (Cancel::new(), Rc::new(Cell::new(None))),
        );
        assert!(
            !context.core.residuals.borrow()[&context.group]
                .cleanup
                .is_finished(),
            "a pending retry must replace the failed observer"
        );
        context.cancel.cancel();
        rig.executor.drive(256);
        assert_eq!(rig.host.inner.retained_count(), 0);
        assert!(rig.host.signals.borrow().contains(&context.group));
        drop(context);
        rig.shutdown();
    }
    #[test]
    fn residual_review_jobs_with_no_output_accepts_closed_stdout() {
        let rig = Harness::new();
        assert_eq!(rig.run("jobs >&-"), 0);
        assert_eq!(rig.run("false & p=$!; wait \"$p\"; jobs >&-"), 0);
        rig.shutdown();
    }
}

#[cfg(test)]
mod function_measurements {
    use super::*;

    #[test]
    fn function_memory_background_calls_share_pool_with_next_session_start_and_refund() {
        let ex = Executor::new();
        let host = crate::process::InProcessHost::new(ex.clone());
        let release = Cancel::new();
        let gate = release.clone();
        host.register("/home/guest/park", move |_, cancel| {
            let gate = gate.clone();
            async move {
                if cancel.run(gate.cancelled()).await.is_ok() {
                    0
                } else {
                    130
                }
            }
            .boxed_local()
        });
        let limit = 256 * 1024;
        let session = Session::new(
            ex.clone(),
            Rc::new(host.clone()),
            Rc::new(io::MemoryFs::new(1024)),
            Limits {
                execution_bytes: limit,
                ..Limits::default()
            },
        );
        let finish = |job: JoinHandle<i32>| {
            for _ in 0..100_000 {
                ex.drive(64);
                if job.is_finished() {
                    break;
                }
            }
            job.now_or_never()
                .expect("bounded submitted command completes")
        };
        assert_eq!(
            finish(
                session
                    .start("hold() { local x=held; park; }; hold &")
                    .unwrap()
            ),
            0
        );
        for _ in 0..10_000 {
            ex.drive(64);
            if host.active_count() == 1 {
                break;
            }
        }
        assert_eq!(host.active_count(), 1);
        let held = session.core.execution_storage.observation().0;
        assert!(held > 0 && held < limit);
        // Use an exact independent live ticket to leave room for command
        // dispatch but not an AST copy. It represents other concurrent frames.
        let pressure = session
            .core
            .execution_storage
            .admit(limit - held - 64 * 1024)
            .unwrap();
        let source = format!(
            "large() {{ local x='{}'; }}; large; echo bad",
            "x".repeat(96 * 1024)
        );
        assert_eq!(finish(session.start(&source).unwrap()), 2);
        assert_eq!(
            host.active_count(),
            1,
            "foreground admission must not cancel the background frame"
        );
        drop(pressure);
        assert_eq!(session.core.execution_storage.observation().0, held);
        assert_eq!(
            finish(
                session
                    .start("small() { local x=small; :; }; small; unset -f small")
                    .unwrap()
            ),
            0
        );
        assert_eq!(session.core.execution_storage.observation().0, held);
        release.cancel();
        assert_eq!(finish(session.start("wait; unset -f hold").unwrap()), 0);
        assert_eq!(ex.drive(64).pending, 0);
        assert_eq!(host.active_count(), 0);
        assert_eq!(host.retained_count(), 0);
        assert_eq!(session.core.execution_storage.observation().0, 0);
    }

    fn finish_review(ex: &Executor, job: JoinHandle<i32>) -> i32 {
        for _ in 0..100_000 {
            ex.drive(64);
            if job.is_finished() {
                break;
            }
        }
        job.now_or_never()
            .expect("bounded review control completes")
    }

    #[test]
    fn review_shift_refunds_dropped_strings_but_keeps_vector_allocation() {
        let ex = Executor::new();
        let host = crate::process::InProcessHost::new(ex.clone());
        let session = Session::new(
            ex.clone(),
            Rc::new(host),
            Rc::new(io::MemoryFs::new(1024)),
            Limits::default(),
        );
        assert_eq!(
            finish_review(
                &ex,
                session
                    .start(&format!(
                        "set -- '{}' '{}' c",
                        "a".repeat(4096),
                        "b".repeat(2048)
                    ))
                    .unwrap()
            ),
            0
        );
        let before = session.core.execution_storage.observation().0;
        let capacity = session.state.borrow().positional().capacity();
        let vector_bytes = capacity * std::mem::size_of::<String>();
        let strings: Vec<_> = session
            .state
            .borrow()
            .positional()
            .iter()
            .map(String::capacity)
            .collect();
        assert_eq!(before, vector_bytes + strings.iter().sum::<usize>());
        for (command, status) in [("shift 4", 1), ("shift bad", 2)] {
            assert_eq!(finish_review(&ex, session.start(command).unwrap()), status);
            assert_eq!(session.core.execution_storage.observation().0, before);
            assert_eq!(session.state.borrow().positional().len(), 3);
        }
        for (command, released) in [
            ("shift", strings[0]),
            ("shift 1", strings[1]),
            ("shift 0", 0),
            ("shift", strings[2]),
        ] {
            let before = session.core.execution_storage.observation().0;
            assert_eq!(finish_review(&ex, session.start(command).unwrap()), 0);
            assert_eq!(
                session.core.execution_storage.observation().0,
                before - released,
                "{command} only refunds dropped string capacities"
            );
            assert_eq!(session.state.borrow().positional().capacity(), capacity);
        }
        assert_eq!(session.core.execution_storage.observation().0, vector_bytes);
        assert_eq!(finish_review(&ex, session.start("set --").unwrap()), 0);
        // set's argv vector may have spare capacity after removing '--'. Keep
        // the actual empty vector allocation charged until replaced/dropped.
        assert_eq!(
            session.core.execution_storage.observation().0,
            session.state.borrow().positional().capacity() * std::mem::size_of::<String>()
        );
    }

    #[test]
    fn review_shift_releases_memory_for_nested_call_and_later_session_start() {
        let ex = Executor::new();
        let host = crate::process::InProcessHost::new(ex.clone());
        let session = Session::new(
            ex.clone(),
            Rc::new(host),
            Rc::new(io::MemoryFs::new(1024)),
            Limits {
                execution_bytes: 160 * 1024,
                ..Limits::default()
            },
        );
        session
            .state
            .borrow_mut()
            .assign_parameter("payload".into(), "x".repeat(64 * 1024))
            .unwrap();
        assert_eq!(finish_review(&ex, session.start("seen=0; g() { local x=$payload; seen=$((seen+1)); }; f() { shift; g; }; f \"$payload\"").unwrap()), 0);
        assert_eq!(session.state.borrow().bindings()["seen"], "1");
        assert!(session.state.borrow().positional().is_empty());
        let source_bytes = session.state.borrow().functions()["f"]
            .source
            .retained()
            .unwrap()
            .bytes();
        assert_eq!(session.core.execution_storage.observation().0, source_bytes);
        assert_eq!(
            finish_review(&ex, session.start("f \"$payload\"").unwrap()),
            0
        );
        assert_eq!(session.state.borrow().bindings()["seen"], "2");
        assert_eq!(session.core.execution_storage.observation().0, source_bytes);
        assert_eq!(
            finish_review(&ex, session.start("unset -f f g").unwrap()),
            0
        );
        assert_eq!(session.core.execution_storage.observation().0, 0);
        assert_eq!(ex.drive(64).pending, 0);
    }

    #[test]
    fn review_resource_pipeline_publishes_stage_codes_before_unwinding_and_recovers() {
        for (lastpipe, failed_first, negated) in [
            (false, false, false),
            (false, true, false),
            (true, false, false),
            (true, true, false),
            (false, false, true),
            (false, true, true),
            (true, false, true),
            (true, true, true),
        ] {
            let ex = Executor::new();
            let host = crate::process::InProcessHost::new(ex.clone());
            let limit = 256 * 1024;
            let session = Session::new(
                ex.clone(),
                Rc::new(host.clone()),
                Rc::new(io::MemoryFs::new(1024)),
                Limits {
                    execution_bytes: limit,
                    ..Limits::default()
                },
            );
            let budget = session.core.execution_storage.clone();
            let pressure = Rc::new(RefCell::new(None));
            let retained = pressure.clone();
            host.register("/home/guest/consume", move |_, _| {
                // Other live work takes the free pool after both stages have
                // launched, forcing the simple set stage's admission to fail.
                let remaining = limit - budget.observation().0;
                *retained.borrow_mut() = Some(budget.admit(remaining - 2048).unwrap());
                async { 7 }.boxed_local()
            });
            session.state.borrow_mut().lastpipe = lastpipe;
            session
                .state
                .borrow_mut()
                .publish_pipeline_status(vec![91, 92]);
            let stage = format!("set -- '{}'", "x".repeat(32 * 1024));
            let source = if failed_first {
                format!("{stage} | consume; continued=yes")
            } else {
                format!("consume | {stage}; continued=yes")
            };
            let source = if negated {
                format!("! {source}")
            } else {
                source
            };
            assert_eq!(finish_review(&ex, session.start(&source).unwrap()), 2);
            assert_eq!(session.state.borrow().status(), 2);
            assert!(pressure.borrow().is_some());
            assert_eq!(
                session.state.borrow().pipeline_status(),
                if failed_first { vec![2, 7] } else { vec![7, 2] },
                "lastpipe={lastpipe}, failed_first={failed_first}"
            );
            assert!(!session.state.borrow().bindings().contains_key("continued"));
            pressure.borrow_mut().take();
            assert_eq!(
                finish_review(&ex, session.start("recovered=yes").unwrap()),
                0
            );
            assert_eq!(session.state.borrow().bindings()["recovered"], "yes");
            assert_eq!(session.state.borrow().pipeline_status(), [0]);
            assert_eq!(session.core.execution_storage.observation().0, 0);
            assert_eq!(host.active_count(), 0);
            assert_eq!(host.retained_count(), 0);
            assert_eq!(ex.drive(64).pending, 0);
        }
    }

    #[test]
    fn review_live_execution_diagnostics_do_not_invent_function_context() {
        for (assignment_only, nested) in
            [(false, false), (true, false), (false, true), (true, true)]
        {
            let ex = Executor::new();
            let host = crate::process::InProcessHost::new(ex.clone());
            let limit = 256 * 1024;
            let session = Session::new(
                ex.clone(),
                Rc::new(host.clone()),
                Rc::new(io::MemoryFs::new(1024)),
                Limits {
                    execution_bytes: limit,
                    ..Limits::default()
                },
            );
            let (error, errors) = io::capture(4096);
            let mut fds = FdTable::default();
            fds.insert(1, io::Endpoint::null());
            fds.insert(2, error);
            session.set_descriptors(fds).unwrap();
            session
                .state
                .borrow_mut()
                .assign_parameter("payload".into(), "x".repeat(64 * 1024))
                .unwrap();
            let pressure = Rc::new(RefCell::new(None));
            let retained = pressure.clone();
            let budget = session.core.execution_storage.clone();
            host.register("/home/guest/consume", move |_, _| {
                let remaining = limit - budget.observation().0;
                *retained.borrow_mut() = Some(budget.admit(remaining - 32 * 1024).unwrap());
                async { 0 }.boxed_local()
            });
            let command = if assignment_only {
                "x=$payload"
            } else {
                "set -- \"$payload\""
            };
            let source = if nested {
                format!(
                    "f() {{ local saved=inner; consume; {command}; continued=yes; }}; f; continued=yes"
                )
            } else {
                format!("consume; {command}; continued=yes")
            };
            assert_eq!(
                finish_review(&ex, session.start(&source).unwrap()),
                2,
                "assignment={assignment_only}, nested={nested}"
            );
            let diagnostic = String::from_utf8(errors.bytes()).unwrap();
            assert!(
                diagnostic.contains("live-execution memory limit exceeded"),
                "{diagnostic}"
            );
            assert!(!diagnostic.contains("function"), "{diagnostic}");
            assert!(!session.state.borrow().bindings().contains_key("continued"));
            pressure.borrow_mut().take();
            assert_eq!(
                finish_review(&ex, session.start("recovered=yes; unset -f f").unwrap()),
                0
            );
            assert!(!session.state.borrow().bindings().contains_key("saved"));
            assert_eq!(session.core.execution_storage.observation().0, 0);
            assert_eq!(host.retained_count(), 0);
            assert_eq!(ex.drive(64).pending, 0);
        }
    }

    #[test]
    fn function_tasks_measure_512_real_calls_without_growing_poll_or_drop_stacks() {
        for increment in ["n=$((n+1))", "eval 'n=$((n+1))'"] {
            let mut first = None;
            for goal in [1, 32, 128, 512] {
                let ex = Executor::new();
                let host = crate::process::InProcessHost::new(ex.clone());
                let session = Session::new(
                    ex.clone(),
                    Rc::new(host),
                    Rc::new(io::MemoryFs::new(1024)),
                    Limits::default(),
                );
                let source = format!(
                    "n=0; seen=0; unwound=0; leaf=0; f() {{ local d=$1; {increment}; seen=$((seen+1)); case $n in {goal}) leaf=$n;; *) f child;; esac; unwound=$((unwound+1)); }}; f root"
                );
                crate::executor::observation::reset_stack_observation();
                let job = session.start(&source).unwrap();
                for _ in 0..100_000 {
                    ex.drive(64);
                    if job.is_finished() {
                        break;
                    }
                }
                assert_eq!(job.now_or_never(), Some(0));
                assert_eq!(ex.drive(64).pending, 0);
                let state = session.state.borrow();
                for name in ["n", "seen", "unwound", "leaf"] {
                    assert_eq!(state.bindings()[name], goal.to_string(), "{name}");
                }
                assert!(!state.bindings().contains_key("d"));
                assert!(state.positional().is_empty());
                let sample = crate::executor::observation::stack_observation();
                let (live, peak) = session.core.execution_storage.observation();
                let reader_bytes = state.functions()["f"].source.retained().unwrap().bytes();
                assert_eq!(
                    live, reader_bytes,
                    "only the stored definition's reader survives"
                );
                drop(state);
                assert_eq!(finish_review(&ex, session.start("unset -f f").unwrap()), 0);
                assert_eq!(session.core.execution_storage.observation().0, 0);
                assert_eq!(sample.calls, goal);
                assert!(sample.poll_bytes > 0 && sample.drop_bytes > 0);
                println!(
                    "functions target={} increment={increment:?} calls={goal} poll_stack_bytes={} drop_stack_bytes={} peak_live_bytes={peak}",
                    std::env::consts::ARCH,
                    sample.poll_bytes,
                    sample.drop_bytes
                );
                let baseline: crate::executor::observation::StackObservation =
                    *first.get_or_insert(sample);
                assert!(
                    sample.poll_bytes <= baseline.poll_bytes + 16 * 1024,
                    "polling must not grow per function call"
                );
                assert!(
                    sample.drop_bytes <= baseline.drop_bytes + 16 * 1024,
                    "dropping must not grow per function call"
                );
            }
        }
    }
}
