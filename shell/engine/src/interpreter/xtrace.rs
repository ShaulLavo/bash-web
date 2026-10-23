use super::{Context, Descriptors, substitution_work};
use crate::{exec::ResultFuture, executor::Budget, expand, io::Endpoint, state::SharedState};
use futures::future::{Either, ready};

#[derive(Clone, Copy, Default)]
pub(super) struct Trace {
    depth: usize,
    prompt: bool,
}
impl Trace {
    pub(super) fn nested(self) -> Self {
        Self {
            depth: self.depth.saturating_add(1),
            ..self
        }
    }
}

fn frame<'a, F: std::future::Future<Output = Result<(), expand::Error>> + 'a>(
    state: &SharedState,
    context: &Context,
    run: impl FnOnce() -> F,
) -> ResultFuture<'a, ()> {
    if !state.borrow().xtrace || context.trace.prompt {
        return Either::Left(ready(Ok(())));
    }
    context.evaluation.frame(run(), |code| Err(code.into()))
}

pub(super) fn command<'a>(
    argv: &'a [String],
    assigned: &'a [(String, String)],
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
) -> ResultFuture<'a, ()> {
    if argv.is_empty() {
        return Either::Left(ready(Ok(())));
    }
    frame(state, context, || async move {
        for (name, value) in assigned {
            assignment(name, value, state, fds, context).await?;
        }
        let Some(mut writer) = Writer::start(state, fds, context).await? else {
            return Ok(());
        };
        let mut separator: &[u8] = b"";
        for arg in argv {
            writer.write(separator).await?;
            writer.word(arg).await?;
            separator = b" ";
        }
        writer.finish().await.map_err(Into::into)
    })
}

pub(crate) async fn builtin_assignment(
    name: &str,
    value: &str,
    state: &SharedState,
    fds: &crate::io::FdTable,
    context: &Context,
) -> Result<(), i32> {
    if !state.borrow().xtrace || context.trace.prompt {
        return Ok(());
    }
    let descriptors = std::rc::Rc::new(std::cell::RefCell::new(fds.clone()));
    assignment(name, value, state, &descriptors, context)
        .await
        .map_err(super::admission_status)
}

pub(super) fn assignment<'a>(
    name: &'a str,
    value: &'a str,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
) -> ResultFuture<'a, ()> {
    frame(state, context, || async move {
        let Some(mut writer) = Writer::start(state, fds, context).await? else {
            return Ok(());
        };
        writer.write(name.as_bytes()).await?;
        writer.write(b"=").await?;
        if !value.is_empty() {
            writer.word(value).await?;
        }
        writer.finish().await?;
        Ok(())
    })
}

struct Writer<'a> {
    endpoint: Endpoint,
    context: &'a Context,
    budget: Budget,
    buffer: [u8; 512],
    used: usize,
}
impl<'a> Writer<'a> {
    async fn start(
        state: &SharedState,
        fds: &Descriptors,
        context: &'a Context,
    ) -> Result<Option<Self>, expand::Error> {
        let endpoint = fds.borrow().get(2);
        let mut prompt_context = context.clone();
        prompt_context.trace.prompt = true;
        let mut work = substitution_work(&prompt_context, fds);
        let raw = {
            let state = state.borrow();
            let value = state.parameter("PS4");
            work.admit_storage(value.len())?;
            value.into_owned()
        };
        let prefix = match expand::scalar_text(
            expand::ScalarSyntax::Prompt,
            &raw,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            &mut work,
        )
        .await
        {
            Ok(prefix) => prefix,
            Err(error @ (expand::Error::Status(_) | expand::Error::Abort(_))) => return Err(error),
            Err(error) => {
                prompt_context.parameter_error_status = 1;
                let failure = super::expansion_failure(error.into(), fds, &prompt_context).await;
                if state.borrow().errexit && failure.flow == super::Flow::Abort {
                    return Err(expand::Error::Abort(failure.code));
                }
                raw
            }
        };
        let Some(endpoint) = endpoint else {
            return Ok(None);
        };
        let mut writer = Self {
            endpoint,
            context,
            budget: Budget::default(),
            buffer: [0; 512],
            used: 0,
        };
        if let Some(first) = prefix.chars().next() {
            for _ in 0..context.trace.depth {
                writer
                    .write(first.encode_utf8(&mut [0; 4]).as_bytes())
                    .await?;
            }
        }
        writer.write(prefix.as_bytes()).await?;
        Ok(Some(writer))
    }
    async fn write(&mut self, mut bytes: &[u8]) -> Result<(), i32> {
        while !bytes.is_empty() {
            self.budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| 130)?;
            let count = bytes.len().min(self.buffer.len() - self.used);
            self.buffer[self.used..self.used + count].copy_from_slice(&bytes[..count]);
            self.used += count;
            bytes = &bytes[count..];
            if self.used == self.buffer.len() {
                self.flush().await?;
            }
        }
        Ok(())
    }
    async fn flush(&mut self) -> Result<(), i32> {
        let result = self
            .endpoint
            .write_all(&self.buffer[..self.used], &self.context.cancel)
            .await;
        self.used = 0;
        match result {
            Err(crate::io::IoError::Cancelled) => Err(130),
            _ => Ok(()),
        }
    }
    async fn finish(mut self) -> Result<(), i32> {
        self.write(b"\n").await?;
        self.flush().await
    }
    async fn word(&mut self, value: &str) -> Result<(), i32> {
        if value.is_empty() {
            return self.write(b"''").await;
        }
        if value == "'" {
            return self.write(b"\\'").await;
        }
        let mut quoted = value.starts_with(['#', '~']) || value.contains("=~");
        let mut ansi = false;
        for ch in value.chars() {
            self.budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| 130)?;
            ansi |= ch.is_control();
            quoted |= ch.is_whitespace() || "'\"\\|&;()<>$`*?[]{}!".contains(ch);
        }
        if ansi {
            return self.ansi_word(value).await;
        }
        if !quoted {
            return self.write(value.as_bytes()).await;
        }
        self.write(b"'").await?;
        for piece in value.split_inclusive('\'') {
            let plain = piece.strip_suffix('\'').unwrap_or(piece);
            self.write(plain.as_bytes()).await?;
            if piece.ends_with('\'') {
                self.write(b"'\\''").await?;
            }
        }
        self.write(b"'").await
    }
    async fn ansi_word(&mut self, value: &str) -> Result<(), i32> {
        self.write(b"$'").await?;
        for ch in value.chars() {
            self.ansi_character(ch).await?;
        }
        self.write(b"'").await
    }
    async fn ansi_character(&mut self, ch: char) -> Result<(), i32> {
        let escaped: Option<&[u8]> = match ch {
            '\n' => Some(b"\\n"),
            '\t' => Some(b"\\t"),
            '\r' => Some(b"\\r"),
            '\x07' => Some(b"\\a"),
            '\x08' => Some(b"\\b"),
            '\x0b' => Some(b"\\v"),
            '\x0c' => Some(b"\\f"),
            '\x1b' => Some(b"\\E"),
            '\\' => Some(b"\\\\"),
            '\'' => Some(b"\\'"),
            _ => None,
        };
        if let Some(escaped) = escaped {
            return self.write(escaped).await;
        }
        if ch.is_ascii_control() {
            let byte = ch as u8;
            return self
                .write(&[
                    b'\\',
                    b'0' + (byte >> 6),
                    b'0' + ((byte >> 3) & 7),
                    b'0' + (byte & 7),
                ])
                .await;
        }
        self.write(ch.encode_utf8(&mut [0; 4]).as_bytes()).await
    }
}
