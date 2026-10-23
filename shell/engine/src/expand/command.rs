//! Command substitution, original to this engine. The body runs as a subshell
//! task (see `interpreter::Substitutions`); its stdout streams through a pipe
//! straight into the expansion. Only a count of trailing newlines is held back,
//! so no copy of the whole output exists beyond the expansion's own fields.
use super::{Error, Expansion, Protection};
use crate::state::{SharedState, State};
use shell_parser::parser::Command;

/// Bytes read per pipe turn, plus the same again for the decoded text that is
/// emitted per flush. Both are temporary and charged to storage while live.
const CHUNK: usize = 4096;
/// A UTF-8 sequence split across reads carries at most three bytes over.
const CARRY: usize = 3;
const NULL_WARNING: &str =
    "/usr/bin/bash: warning: command substitution: ignored null byte in input\n";

struct CaptureBuffer {
    bytes: Vec<u8>,
    text: String,
    carried: usize,
    newlines: usize,
    warned: bool,
}
impl CaptureBuffer {
    fn new() -> Result<Self, Error> {
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(CHUNK + CARRY).map_err(|_| 2)?;
        bytes.resize(CHUNK + CARRY, 0);
        let mut text = String::new();
        text.try_reserve_exact(CHUNK).map_err(|_| 2)?;
        Ok(Self {
            bytes,
            text,
            carried: 0,
            newlines: 0,
            warned: false,
        })
    }
}

impl Expansion<'_> {
    pub(super) async fn command_substitution(
        &mut self,
        commands: &[Command],
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        let protection = Protection::expansion(scalar || quoted, state);
        let keeps_empty = scalar || quoted;
        // A quoted substitution is a field even when its output is empty.
        self.segment("", protection, keeps_empty).await?;
        let scratch = CHUNK + CARRY + CHUNK;
        self.work.admit_storage(scratch)?;
        let result = self.capture(commands, state, protection, keeps_empty).await;
        self.work.release_storage(scratch);
        let code = result?;
        self.work.substitution_status = Some(code);
        // Bash updates `$?` as soon as each substitution finishes.
        state.borrow_mut().publish_status(code);
        Ok(())
    }

    async fn capture(
        &mut self,
        commands: &[Command],
        state: &SharedState,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<i32, Error> {
        let runner = self.work.substitutions.clone().ok_or(2)?;
        let mut buffer = CaptureBuffer::new()?;
        crate::ast_copy::admit(commands, self.cancel, self.work).await?;
        let child = State::snapshot(state, self.cancel, self.work)
            .await?
            .shared();
        let (reader, task) = runner.start(commands.to_vec(), child)?;
        let result = self
            .read_capture(
                &reader,
                &runner,
                &mut buffer,
                protection,
                keeps_empty,
                false,
            )
            .await;
        drop(reader);
        if result.is_err() {
            task.cancel();
        }
        // Errors retain ownership until host children and nested jobs unwind.
        let code = task.finish().await;
        result?;
        Ok(code)
    }

    pub(super) async fn file_substitution(
        &mut self,
        commands: &[Command],
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        let [Command::Simple(simple)] = commands else {
            return Err(2.into());
        };
        let [redirect] = simple.redirects.as_slice() else {
            return Err(2.into());
        };
        let protection = Protection::expansion(scalar || quoted, state);
        let keeps_empty = scalar || quoted;
        self.segment("", protection, keeps_empty).await?;
        let scratch = CHUNK + CARRY + CHUNK;
        self.work.admit_storage(scratch)?;
        let result = self
            .capture_file(redirect, state, protection, keeps_empty)
            .await;
        self.work.release_storage(scratch);
        let code = result?;
        self.work.substitution_status = Some(code);
        state.borrow_mut().publish_status(code);
        Ok(())
    }

    async fn capture_file(
        &mut self,
        redirect: &shell_parser::parser::Redirect,
        state: &SharedState,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<i32, Error> {
        let runner = self.work.substitutions.clone().ok_or(2)?;
        let remaining = self.work.fields_remaining;
        let targets = super::fields_admitted(
            &redirect.target,
            state,
            self.cancel,
            self.max_raw,
            self.elements_remaining,
            self.max_raw,
            self.work,
        )
        .await;
        self.work.fields_remaining = remaining;
        self.ifs = None;
        self.ifs_changed = true;
        let mut targets = targets?;
        if targets.len() != 1 {
            runner
                .file_substitution_error(
                    redirect.expansion_line,
                    redirect.target.raw.as_deref().unwrap_or("redirect"),
                    "ambiguous redirect",
                )
                .await?;
            return Ok(1);
        }
        let target = targets.pop().ok_or(2)?;
        let Some(reader) = runner
            .open_substitution_file(&target, redirect.expansion_line, state, self.work)
            .await?
        else {
            return Ok(1);
        };
        let mut buffer = CaptureBuffer::new()?;
        self.read_capture(&reader, &runner, &mut buffer, protection, keeps_empty, true)
            .await?;
        Ok(0)
    }

    async fn read_capture(
        &mut self,
        reader: &crate::io::Endpoint,
        runner: &crate::interpreter::Substitutions,
        buffer: &mut CaptureBuffer,
        protection: Protection,
        keeps_empty: bool,
        file: bool,
    ) -> Result<(), Error> {
        loop {
            let read = reader
                .read_cancelled(
                    &mut buffer.bytes[buffer.carried..buffer.carried + CHUNK],
                    self.cancel,
                )
                .await;
            let count = match read {
                Ok(count) => count,
                Err(crate::io::IoError::Cancelled) => return Err(130.into()),
                Err(_) if file => break,
                Err(_) => return Err(2.into()),
            };
            if count == 0 {
                break;
            }
            self.work.checkpoint(self.cancel).await?;
            self.decode_capture(buffer, count, runner, protection, keeps_empty)
                .await?;
        }
        if buffer.carried != 0 {
            return Err(2.into());
        }
        Ok(())
    }

    async fn decode_capture(
        &mut self,
        buffer: &mut CaptureBuffer,
        count: usize,
        runner: &crate::interpreter::Substitutions,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        let total = buffer.carried + count;
        let (valid, rest) = match std::str::from_utf8(&buffer.bytes[..total]) {
            Ok(_) => (total, 0),
            Err(error) if error.error_len().is_some() => return Err(2.into()),
            Err(error) => (error.valid_up_to(), total - error.valid_up_to()),
        };
        let decoded = std::str::from_utf8(&buffer.bytes[..valid]).map_err(|_| 2)?;
        for ch in decoded.chars() {
            self.work.checkpoint(self.cancel).await?;
            if ch == '\0' {
                self.capture_null(&mut buffer.warned, runner).await?;
                continue;
            }
            if ch == '\n' {
                buffer.newlines = buffer.newlines.checked_add(1).ok_or(2)?;
                continue;
            }
            self.capture_character(
                ch,
                &mut buffer.text,
                &mut buffer.newlines,
                protection,
                keeps_empty,
            )
            .await?;
        }
        self.flush(&mut buffer.text, protection, keeps_empty)
            .await?;
        buffer.bytes.copy_within(valid..total, 0);
        buffer.carried = rest;
        Ok(())
    }

    async fn capture_null(
        &mut self,
        warned: &mut bool,
        runner: &crate::interpreter::Substitutions,
    ) -> Result<(), Error> {
        if !*warned {
            *warned = true;
            self.warn_null(runner).await?;
        }
        Ok(())
    }

    async fn capture_character(
        &mut self,
        ch: char,
        text: &mut String,
        newlines: &mut usize,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        while *newlines > 0 {
            self.work.checkpoint(self.cancel).await?;
            if text.len() + 1 > CHUNK {
                self.flush(text, protection, keeps_empty).await?;
            }
            text.push('\n');
            *newlines -= 1;
        }
        if text.len() + ch.len_utf8() > CHUNK {
            self.flush(text, protection, keeps_empty).await?;
        }
        text.push(ch);
        Ok(())
    }

    async fn flush(
        &mut self,
        text: &mut String,
        protection: Protection,
        keeps_empty: bool,
    ) -> Result<(), Error> {
        if text.is_empty() {
            return Ok(());
        }
        self.segment(text, protection, keeps_empty).await?;
        text.clear();
        Ok(())
    }

    async fn warn_null(&mut self, runner: &crate::interpreter::Substitutions) -> Result<(), Error> {
        if let Some(stderr) = runner.stderr() {
            let _ = stderr
                .write_all(NULL_WARNING.as_bytes(), runner.cancel())
                .await;
        }
        if self.cancel.is_cancelled() {
            return Err(130.into());
        }
        Ok(())
    }

    /// A non-arithmetic `$((...))` span whose text is not a valid command:
    /// Bash parses it only now, in the substitution's child, which reports the
    /// syntax error and exits 2. The expansion itself is empty.
    pub(super) async fn unparsed_substitution(
        &mut self,
        source: &str,
        error: &str,
        state: &SharedState,
        quoted: bool,
        scalar: bool,
    ) -> Result<(), Error> {
        let runner = self.work.substitutions.clone().ok_or(2)?;
        let size = source.len().saturating_add(error.len()).saturating_add(128);
        self.work.admit_storage(size)?;
        let message = format!(
            "/usr/bin/bash: command substitution: {error}\n/usr/bin/bash: command substitution: `{source}'\n"
        );
        if let Some(stderr) = runner.stderr() {
            let _ = stderr.write_all(message.as_bytes(), runner.cancel()).await;
        }
        drop(message);
        self.work.release_storage(size);
        if self.cancel.is_cancelled() {
            return Err(130.into());
        }
        self.work.substitution_status = Some(2);
        state.borrow_mut().publish_status(2);
        self.segment(
            "",
            Protection::expansion(scalar || quoted, state),
            scalar || quoted,
        )
        .await
    }
}
