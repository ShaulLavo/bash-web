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

    fn same(&self, other: &Self) -> bool {
        self.enabled == other.enabled && self.aliases.same(&other.aliases)
    }
}

pub(super) struct Reader {
    commands: IntoIter<Command>,
    ends: IntoIter<usize>,
    starts: IntoIter<(usize, usize)>,
    failure: Option<ParseFailure>,
    aliases: AliasOptions,
    budget: ExecutionBudget,
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
            aliases,
            budget,
        }
    }

    fn refresh(
        &mut self,
        state: &SharedState,
        context: &Context,
        previous_line: usize,
    ) -> Result<(), ()> {
        let Some(&(offset, line)) = self.starts.as_slice().first() else {
            return Ok(());
        };
        // Definitions cannot alter another command in the same parsed read unit.
        if line <= previous_line {
            return Ok(());
        }
        let aliases = AliasOptions::snapshot(state);
        if self.aliases.same(&aliases) {
            return Ok(());
        }
        let position = Position {
            offset,
            line,
            column: 1,
        };
        let (script, failure) = parse::reader(
            &context.source,
            context.limits().source_bytes,
            &self.budget,
            aliases.options(),
            position,
        )
        .map_err(|_| ())?;
        *self = Self::new(script, failure, aliases, self.budget.clone());
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
        if reader.refresh(&state, &context, previous_line).is_err() {
            return Outcome::status(if context.cancel.probe_now() { 130 } else { 2 });
        }
        let Some(command) = reader.commands.next() else {
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
