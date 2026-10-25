//! Original `time` reserved word: run one pipeline, then report its elapsed
//! real time on the shell's standard error in Bash's TIMEFORMAT notation.
use super::*;
use crate::exec::Error;
use std::{
    borrow::Cow,
    fmt::Write as _,
    iter::Peekable,
    str::Chars,
    time::{Duration, Instant},
};

/// Bash's default reports without their CPU lines. The runtime has no CPU
/// accounting, so `%U`, `%S` and `%P` are rejected rather than reported as zero.
const DEFAULT_FORMAT: &str = "\nreal\t%3lR";
const POSIX_FORMAT: &str = "real %2R";
/// No directive produces more than this many bytes per format byte.
const REPORT_BYTES_PER_FORMAT_BYTE: usize = 16;

#[inline(never)]
pub(super) fn run(
    time: TimeCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static> {
    let evaluation = context.evaluation.clone();
    evaluation.frame(time_body(time, state, fds, context), Outcome::status)
}

async fn time_body(
    time: TimeCommand,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    let (posix, command) = flatten(time);
    let started = Instant::now();
    let result = match command {
        Some(command) => execute(command, state.clone(), fds.clone(), context.clone()).await,
        None => Outcome::status(0),
    };
    let elapsed = started.elapsed();
    // The report is printed even when the pipeline exits, returns or breaks,
    // and its own failure never replaces the pipeline's outcome.
    let _ = report(posix, elapsed, &state, &fds, &context).await;
    result
}

/// Bash keeps one timing bit per pipeline, so `time time -p cmd` reports once.
fn flatten(mut time: TimeCommand) -> (bool, Option<Command>) {
    let mut posix = time.posix_format;
    loop {
        let Some(command) = time.command.take() else {
            return (posix, None);
        };
        if !nested_time(&command) {
            return (posix, Some(*command));
        }
        if let Command::Compound(CompoundCommand::Time(inner), _) = *command {
            time = *inner;
            posix |= time.posix_format;
        }
    }
}

/// A nested `time` without redirections of its own merges into the outer one.
fn nested_time(command: &Command) -> bool {
    matches!(command, Command::Compound(CompoundCommand::Time(_), redirects) if redirects.is_empty())
}

async fn report(
    posix: bool,
    elapsed: Duration,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
) -> Result<(), Error> {
    let mut work = expansion_work(context);
    let format = if posix {
        Some(Cow::Borrowed(POSIX_FORMAT))
    } else {
        configured_format(state, context, &mut work).await?
    };
    let Some(format) = format.filter(|format| !format.is_empty()) else {
        return Ok(());
    };
    let text = render(&format, elapsed, context, &mut work).await?;
    let Some(error) = fds.borrow().get(2) else {
        return Ok(());
    };
    error
        .write_all(text.as_bytes(), &context.cancel)
        .await
        .map_err(|error| Error::Status(error.status()))
}

/// TIMEFORMAT's value, or the default report when it is unset.
async fn configured_format(
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Option<Cow<'static, str>>, Error> {
    State::admit_scalar_access(state, "TIMEFORMAT", &context.cancel, work).await?;
    let Some(bytes) = state.borrow().scalar_parameter("TIMEFORMAT").map(str::len) else {
        return Ok(Some(Cow::Borrowed(DEFAULT_FORMAT)));
    };
    work.admit_storage(bytes)?;
    Ok(state
        .borrow()
        .scalar_parameter("TIMEFORMAT")
        .map(|format| Cow::Owned(format.to_owned())))
}

/// Bash's `print_formatted_time`, including an admitted diagnostic for a
/// directive Bash rejects or this runtime cannot report.
async fn render(
    format: &str,
    elapsed: Duration,
    context: &Context,
    work: &mut expand::Work,
) -> Result<String, Error> {
    let bytes = format
        .len()
        .saturating_mul(REPORT_BYTES_PER_FORMAT_BYTE)
        .saturating_add(1);
    work.admit_storage(bytes)?;
    let mut text = String::with_capacity(bytes);
    let mut chars = format.chars().peekable();
    while let Some(ch) = chars.next() {
        work.checkpoint(&context.cancel).await?;
        if ch != '%' || chars.peek().is_none() {
            text.push(ch);
            continue;
        }
        if let Err(problem) = directive(&mut chars, elapsed, &mut text) {
            drop(text);
            work.release_storage(bytes);
            return problem.render(work);
        }
    }
    text.push('\n');
    Ok(text)
}

/// One directive after `%`: `%%`, or `%[precision][l]` followed by `R` or `E`.
fn directive(
    chars: &mut Peekable<Chars<'_>>,
    elapsed: Duration,
    text: &mut String,
) -> Result<(), DirectiveProblem> {
    if chars.next_if_eq(&'%').is_some() {
        text.push('%');
        return Ok(());
    }
    let precision = chars
        .next_if(char::is_ascii_digit)
        .and_then(|digit| digit.to_digit(10))
        .map_or(3, |digit| digit.min(6));
    let long = chars.next_if_eq(&'l').is_some();
    match chars.next() {
        Some('R' | 'E') => {
            seconds(text, elapsed, precision, long);
            Ok(())
        }
        Some(cpu @ ('U' | 'S' | 'P')) => Err(DirectiveProblem {
            character: Some(cpu),
            message: "CPU time is unavailable",
        }),
        character => Err(DirectiveProblem {
            character,
            message: "invalid format character",
        }),
    }
}

struct DirectiveProblem {
    character: Option<char>,
    message: &'static str,
}

impl DirectiveProblem {
    fn render(self, work: &mut expand::Work) -> Result<String, Error> {
        const PREFIX: &str = "/usr/bin/bash: TIMEFORMAT: `";
        const SEPARATOR: &str = "': ";
        let bytes = PREFIX.len()
            + self.character.map_or(0, char::len_utf8)
            + SEPARATOR.len()
            + self.message.len()
            + 1;
        work.admit_storage(bytes)?;
        let mut text = String::with_capacity(bytes);
        text.push_str(PREFIX);
        if let Some(character) = self.character {
            text.push(character);
        }
        text.push_str(SEPARATOR);
        text.push_str(self.message);
        text.push('\n');
        Ok(text)
    }
}

/// Bash's `mkfmt`: whole seconds (minutes first when long), then `precision`
/// truncated fraction digits.
fn seconds(text: &mut String, elapsed: Duration, precision: u32, long: bool) {
    let mut whole = elapsed.as_secs();
    if long {
        let _ = write!(text, "{}m", whole / 60);
        whole %= 60;
    }
    let _ = write!(text, "{whole}");
    if precision > 0 {
        let fraction = elapsed.subsec_micros() / 10u32.pow(6 - precision);
        let _ = write!(text, ".{fraction:0width$}", width = precision as usize);
    }
    if long {
        text.push('s');
    }
}

#[cfg(test)]
mod tests;
