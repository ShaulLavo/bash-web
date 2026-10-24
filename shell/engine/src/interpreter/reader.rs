use super::{Context, Descriptors, Flow, Outcome, abort_diagnostic, execute, parse_failure};
use crate::{
    parse::{self, ParseFailure, ParsedScript},
    state::{Aliases, SharedState},
};
use shell_parser::{
    limits::ExecutionBudget,
    parser::{Command, ParseOptions, Position},
};
use std::vec::IntoIter;

pub(super) struct AliasOptions {
    aliases: Aliases,
    enabled: bool,
}

impl AliasOptions {
    pub(super) fn snapshot(state: &SharedState) -> Self {
        let state = state.borrow();
        Self {
            aliases: if state.expand_aliases {
                state.aliases()
            } else {
                Aliases::default()
            },
            enabled: state.expand_aliases,
        }
    }

    pub(super) fn options(&self) -> ParseOptions {
        ParseOptions {
            aliases: self.aliases.parser_values(),
            extglob: true,
        }
    }

    fn revision(&self) -> Option<u64> {
        self.enabled.then_some(self.aliases.revision())
    }
}

pub(super) struct Reader {
    commands: IntoIter<Command>,
    ends: IntoIter<usize>,
    starts: IntoIter<(usize, usize)>,
    failure: Option<ParseFailure>,
    aliases: Option<u64>,
    budget: ExecutionBudget,
    next_position: Option<Position>,
}

impl Reader {
    pub(super) fn new(
        script: ParsedScript,
        failure: Option<ParseFailure>,
        aliases: AliasOptions,
        budget: ExecutionBudget,
    ) -> Self {
        Self {
            commands: script.commands.into_iter(),
            ends: script.command_end_lines.into_iter(),
            starts: script.command_starts.into_iter(),
            failure,
            aliases: aliases.revision(),
            budget,
            next_position: None,
        }
    }

    fn refresh(
        &mut self,
        state: &SharedState,
        context: &Context,
        previous_line: usize,
    ) -> Result<(), String> {
        let aliases = AliasOptions::snapshot(state);
        let changed = self.aliases != aliases.revision();
        let restart = self.starts.as_slice().first().and_then(|&(offset, line)| {
            // Definitions cannot alter another command in the same read unit.
            (changed && line > previous_line).then_some(Position {
                offset,
                line,
                column: 1,
            })
        });
        let position = restart.or_else(|| {
            self.commands
                .as_slice()
                .is_empty()
                .then_some(self.next_position)
                .flatten()
        });
        let Some(position) = position else {
            return Ok(());
        };
        let (script, failure, next) = parse::read_unit(
            &context.source,
            context.limits().source_bytes,
            &self.budget,
            aliases.options(),
            position,
        )?;
        *self = Self::new(script, failure, aliases, self.budget.clone());
        self.next_position = next;
        Ok(())
    }
}

pub(super) async fn run(
    mut reader: Reader,
    name: &str,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let mut result = Outcome::status(0);
    let mut discarded_line = 0;
    let mut previous_line = 0;
    loop {
        if let Err(error) = reader.refresh(&state, &context, previous_line) {
            if context.cancel.probe_now() {
                return Outcome::status(130);
            }
            let outcome = abort_diagnostic(&fds, &context, error.as_bytes(), 2).await;
            return Outcome::status(outcome.code);
        }
        let Some(command) = reader.commands.next() else {
            if reader.next_position.is_some() {
                continue;
            }
            break;
        };
        let end_line = reader.ends.next().unwrap_or(previous_line);
        reader.starts.next();
        if end_line <= discarded_line {
            continue;
        }
        previous_line = end_line;
        result = execute(command, state.clone(), fds.clone(), context.clone()).await;
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
        if result.flow == Flow::DiscardReadUnit {
            discarded_line = end_line;
            continue;
        }
        if result.flow != Flow::Normal {
            return result;
        }
    }
    if let Some(failure) = reader.failure {
        result = parse_failure(failure, name, &fds, &context).await;
        if name == "eval" && result.code == 2 && result.flow == Flow::Exit {
            result.flow = Flow::Normal;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use crate::{
        executor::Executor,
        interpreter::{Limits, Session},
        io::MemoryFs,
        process::InProcessHost,
    };
    use futures::FutureExt;
    use std::rc::Rc;

    fn session(limits: Limits) -> (Executor, Session) {
        let executor = Executor::new();
        let shell = Session::new(
            executor.clone(),
            Rc::new(InProcessHost::new(executor.clone())),
            Rc::new(MemoryFs::new(4096)),
            limits,
        );
        (executor, shell)
    }

    fn finish(executor: &Executor, job: crate::executor::JoinHandle<i32>) {
        executor.drive(4096);
        assert_eq!(job.now_or_never(), Some(0));
    }

    #[test]
    fn alias_readers_do_not_retain_tables_between_read_units() {
        let (executor, shell) = session(Limits::default());
        shell
            .state()
            .borrow_mut()
            .update_alias("anchor", Some("unchanged"))
            .unwrap();
        let value = shell.state().borrow().aliases().values().unwrap()["anchor"].as_ptr();
        let job = shell
            .start("shopt -s expand_aliases\nalias first=:\nalias second=:\n")
            .unwrap();
        finish(&executor, job);
        assert_eq!(
            shell.state().borrow().aliases().values().unwrap()["anchor"].as_ptr(),
            value
        );
    }
    #[test]
    fn alias_update_cost_observation_does_not_create_a_snapshot() {
        let (executor, shell) = session(Limits {
            source_bytes: 1024,
            expansion_bytes: 1024,
            arguments: 32,
            ..Limits::default()
        });
        shell
            .state()
            .borrow_mut()
            .update_alias("anchor", Some(&"x".repeat(5000)))
            .unwrap();
        let job = shell.start("alias next=:\n").unwrap();
        finish(&executor, job);
        assert_eq!(
            shell.state().borrow().aliases().values().unwrap()["next"],
            ":"
        );
    }

    #[test]
    fn cancelling_a_real_alias_snapshot_copy_never_publishes_the_update() {
        let (executor, shell) = session(Limits::default());
        let state = shell.state();
        state
            .borrow_mut()
            .update_alias("anchor", Some(&"x".repeat(50_000)))
            .unwrap();
        let snapshot = state.borrow().aliases();
        let job = shell.start("ready=1; alias new=:\necho BAD\n").unwrap();
        for _ in 0..128 {
            executor.drive(1);
            if state.borrow().bindings().get("ready").is_some() {
                break;
            }
        }
        assert!(state.borrow().bindings().get("ready").is_some());
        executor.drive(8);
        assert!(
            !job.is_finished(),
            "the real copy must yield before publication"
        );
        assert!(
            state.try_borrow_mut().is_ok(),
            "no source borrow crosses a yield"
        );
        shell.interrupt();
        executor.drive(4096);
        assert_eq!(job.now_or_never(), Some(130));
        assert_eq!(state.borrow().aliases().revision(), snapshot.revision());
        assert!(
            !state
                .borrow()
                .aliases()
                .values()
                .unwrap()
                .contains_key("new")
        );
        assert_eq!(snapshot.values().unwrap()["anchor"].len(), 50_000);
    }
}
