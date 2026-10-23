//! Original prompt decoding. Runtime-dependent escapes require available shell facts.
use super::{Captured, Error, Expansion, Segments, admit_vec_slot, operand};
use crate::state::{SharedState, State};

impl Expansion<'_> {
    pub(super) async fn prompt(
        &mut self,
        value: &str,
        state: &SharedState,
        depth: usize,
    ) -> Result<String, Error> {
        if depth >= operand::MAX_DEPTH {
            return Err(2.into());
        }
        let expand = state.borrow().promptvars;
        let decoded = self.decode_prompt(value, state, expand).await?;
        if !expand {
            return Ok(decoded);
        }
        let capacity = self.raw_remaining;
        let mut child = Expansion {
            segments: Segments {
                account_storage: true,
                ..Segments::default()
            },
            captured: Some(Captured {
                value: String::new(),
                max_bytes: capacity,
            }),
            pattern: None,
            replacement: None,
            pattern_context: false,
            pattern_snapshots: true,
            admit_frames: true,
            ifs: None,
            ifs_changed: false,
            work: self.work,
            cancel: self.cancel,
            max_raw: capacity,
            raw_remaining: capacity,
            elements_remaining: self.elements_remaining,
        };
        let mut scanner = operand::Scanner::prompt(&decoded);
        while let Some(piece) = scanner.next(child.work, child.cancel).await? {
            child
                .operand_piece(piece, state, true, true, depth + 1)
                .await?;
        }
        let changed = child.ifs_changed;
        let result = child.captured.take().ok_or(2)?.value;
        drop(child);
        self.ifs_changed |= changed;
        if changed {
            self.ifs = None;
        }
        Ok(result)
    }

    async fn decode_prompt(
        &mut self,
        value: &str,
        state: &SharedState,
        expand: bool,
    ) -> Result<String, Error> {
        let mut out = Vec::new();
        let mut chars = value.chars().peekable();
        while let Some(ch) = chars.next() {
            self.work.checkpoint(self.cancel).await?;
            if ch != '\\' || chars.peek().is_none() {
                self.prompt_text(&mut out, ch.encode_utf8(&mut [0; 4]))
                    .await?;
                continue;
            }
            let code = chars.next().ok_or(2)?;
            self.prompt_escape(code, &mut chars, state, expand, &mut out)
                .await?;
        }
        String::from_utf8(out).map_err(|_| 2.into())
    }

    async fn prompt_escape(
        &mut self,
        code: char,
        chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
        state: &SharedState,
        expand: bool,
        out: &mut Vec<u8>,
    ) -> Result<(), Error> {
        match code {
            'a' => self.prompt_literal(out, "\x07", expand).await,
            'e' => self.prompt_literal(out, "\x1b", expand).await,
            'n' => self.prompt_literal(out, "\n", expand).await,
            'r' => self.prompt_literal(out, "\r", expand).await,
            '\\' => self.prompt_text(out, "\\").await,
            '[' | ']' => Ok(()),
            '0'..='7' => self.prompt_octal(code, chars, out).await,
            'w' | 'W' => {
                let path = self.prompt_directory(state, code == 'W').await?;
                self.prompt_literal(out, &path, expand).await
            }
            'D' if chars.peek() == Some(&'{') => self.prompt_date_literal(chars, out).await,
            's' => {
                let name = self.prompt_shell_name(state)?;
                self.prompt_literal(out, &name, expand).await
            }
            'u' | 'h' | 'H' | '$' => self.prompt_identity(code, state, expand, out).await,
            'd' | 't' | 'T' | '@' | 'A' | 'j' | 'l' | '!' | '#' | 'v' | 'V' => Err(2.into()),
            _ => {
                self.prompt_text(out, "\\").await?;
                self.prompt_text(out, code.encode_utf8(&mut [0; 4])).await
            }
        }
    }

    fn prompt_shell_name(&mut self, state: &SharedState) -> Result<String, Error> {
        let state = state.borrow();
        let name = state
            .shell_name
            .rsplit('/')
            .next()
            .unwrap_or(&state.shell_name);
        self.work.admit_storage(name.len())?;
        Ok(name.to_owned())
    }

    async fn prompt_literal(
        &mut self,
        out: &mut Vec<u8>,
        text: &str,
        expand: bool,
    ) -> Result<(), Error> {
        for ch in text.chars() {
            if expand && matches!(ch, '\\' | '$' | '`' | '"') {
                self.prompt_text(out, "\\").await?;
            }
            self.prompt_text(out, ch.encode_utf8(&mut [0; 4])).await?;
        }
        Ok(())
    }

    async fn prompt_text(&mut self, out: &mut Vec<u8>, text: &str) -> Result<(), Error> {
        self.prompt_bytes(out, text.as_bytes()).await
    }

    async fn prompt_bytes(&mut self, out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), Error> {
        self.work.checkpoint(self.cancel).await?;
        if bytes.len() > self.raw_remaining.saturating_sub(out.len()) {
            return Err(2.into());
        }
        for byte in bytes {
            admit_vec_slot(out, self.work)?;
            out.push(*byte);
        }
        Ok(())
    }

    async fn prompt_octal(
        &mut self,
        first: char,
        chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
        out: &mut Vec<u8>,
    ) -> Result<(), Error> {
        if chars
            .clone()
            .take(2)
            .filter(|ch| matches!(ch, '0'..='7'))
            .count()
            != 2
        {
            self.prompt_text(out, "\\").await?;
            return self.prompt_text(out, first.encode_utf8(&mut [0; 4])).await;
        }
        let mut value = first as u32 - '0' as u32;
        for _ in 0..2 {
            value = value * 8 + chars.next().ok_or(2)? as u32 - '0' as u32;
        }
        let byte = value as u8;
        if byte == 0 {
            return Ok(());
        }
        self.prompt_bytes(out, &[byte]).await
    }

    async fn prompt_date_literal(
        &mut self,
        chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
        out: &mut Vec<u8>,
    ) -> Result<(), Error> {
        chars.next();
        let start = out.len();
        for ch in chars.by_ref() {
            if ch == '}' {
                break;
            }
            if ch == '%' {
                return Err(2.into());
            }
            self.prompt_text(out, ch.encode_utf8(&mut [0; 4])).await?;
        }
        if out.len() == start {
            return Err(2.into());
        }
        Ok(())
    }

    async fn prompt_identity(
        &mut self,
        code: char,
        state: &SharedState,
        expand: bool,
        out: &mut Vec<u8>,
    ) -> Result<(), Error> {
        let name = match code {
            'u' => "USER",
            'h' | 'H' => "HOSTNAME",
            _ => "EUID",
        };
        State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        let value = {
            let s = state.borrow();
            let value = s
                .scalar_parameter(name)
                .filter(|value| !value.is_empty())
                .ok_or(2)?;
            let value = match code {
                'h' => value.split('.').next().unwrap_or(value),
                '$' if value.parse::<u32>().map_err(|_| 2)? == 0 => "#",
                '$' => "$",
                _ => value,
            };
            self.work.admit_storage(value.len())?;
            value.to_owned()
        };
        self.prompt_literal(out, &value, expand).await
    }

    async fn prompt_directory(
        &mut self,
        state: &SharedState,
        basename: bool,
    ) -> Result<String, Error> {
        for name in ["HOME", "PROMPT_DIRTRIM"] {
            State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        }
        let s = state.borrow();
        let path = s.cwd.as_str();
        let home = s
            .scalar_parameter("HOME")
            .filter(|home| !home.is_empty() && *home != "/");
        let tail = home
            .and_then(|home| path.strip_prefix(home))
            .filter(|tail| tail.is_empty() || tail.starts_with('/'));
        let mut directory = String::new();
        self.work.admit_storage(path.len().saturating_add(5))?;
        if basename {
            directory.push_str(if tail == Some("") {
                "~"
            } else {
                path.rsplit('/')
                    .next()
                    .filter(|part| !part.is_empty())
                    .unwrap_or(path)
            });
            return Ok(directory);
        }
        if tail.is_some() {
            directory.push('~');
        }
        let tail = tail.unwrap_or(path);
        let count = s
            .scalar_parameter("PROMPT_DIRTRIM")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(0);
        let cut = (count > 0).then(|| {
            tail.rmatch_indices('/')
                .nth(count.saturating_sub(1))
                .filter(|(index, _)| *index > 0)
        });
        if let Some(Some((index, _))) = cut {
            directory.push_str(if directory.is_empty() { "..." } else { "/..." });
            directory.push_str(&tail[index..]);
            return Ok(directory);
        }
        directory.push_str(tail);
        Ok(directory)
    }
}
