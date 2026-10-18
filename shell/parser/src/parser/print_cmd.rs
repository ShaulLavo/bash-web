//! Function body printer for `type` and `declare -f`.
//!
//! Important decision: a port of bash's `print_cmd.c` layout rules
//! (4-space indent, `;` + newline between commands, `if`/`elif` printed as
//! nested `else if`, deferred here-document bodies, `was_heredoc` quirks)
//! over bashkit's AST. Words print as written (`Word::raw`, recorded by the
//! parser inside function definitions); a word without source text falls
//! back to a reconstruction from its parts. Output never uses `Debug`
//! (TM-INF-022).

use super::ast::*;
use super::raw::heredoc_eof_from_raw;
use crate::error::{Error, Result};
use crate::limits::ExecutionBudget;
use std::cell::{Cell, RefCell};
use std::fmt::Write as _;
use std::rc::Rc;

const INDENT_AMOUNT: usize = 4;

/// Bash's text for `type NAME` / `declare -f NAME`: `name () \n{ \n...\n}`.
pub fn function_string(name: &str, body: &Command) -> String {
    let mut p = Printer::default();
    if is_reserved_word(name) {
        p.out.push_str("function ");
    }
    p.out.push_str(name);
    p.out.push_str(" () \n");
    p.inside_function_def += 1;
    p.out.push_str("{ \n");
    p.indentation += INDENT_AMOUNT;
    let func_redirects = p.print_function_body(body);
    p.print_deferred_if_any("");
    p.indentation -= INDENT_AMOUNT;
    p.inside_function_def -= 1;
    p.close_function(func_redirects);
    p.out.into_string()
}

fn is_reserved_word(name: &str) -> bool {
    matches!(
        name,
        "if" | "then"
            | "else"
            | "elif"
            | "fi"
            | "case"
            | "esac"
            | "for"
            | "select"
            | "while"
            | "until"
            | "do"
            | "done"
            | "in"
            | "function"
            | "time"
            | "{"
            | "}"
            | "!"
            | "[["
            | "]]"
            | "coproc"
    )
}

#[derive(Clone, Copy, PartialEq)]
enum Conn {
    Semi,
    Amp,
    And,
    Or,
    Pipe,
}

/// A here-document whose body prints after the current line.
struct HereDoc {
    body: String,
    eof: String,
    prepaid: bool,
}

struct PrintQuota<'a> {
    fuel: &'a Cell<usize>,
    max_fuel: usize,
    execution_budget: Option<&'a ExecutionBudget>,
    failure: RefCell<Option<Error>>,
}

impl<'a> PrintQuota<'a> {
    fn charge(&self, bytes: usize) -> bool {
        if self.failure.borrow().is_some() {
            return false;
        }
        if let Some(budget) = self.execution_budget
            && let Err(error) = budget.consume_work(u64::try_from(bytes).unwrap_or(u64::MAX))
        {
            *self.failure.borrow_mut() = Some(error.into());
            return false;
        }
        if self.fuel.get() < bytes {
            *self.failure.borrow_mut() = Some(
                crate::limits::LimitExceeded::ParserFuel {
                    used: self.max_fuel,
                    limit: self.max_fuel,
                }
                .into(),
            );
            return false;
        }
        self.fuel.set(self.fuel.get() - bytes);
        true
    }

    fn failure(&self) -> Option<Error> {
        self.failure.borrow_mut().take()
    }
}

struct Output<'a> {
    text: String,
    quota: Option<Rc<PrintQuota<'a>>>,
}

impl<'a> Default for Output<'a> {
    fn default() -> Self {
        Self {
            text: String::new(),
            quota: None,
        }
    }
}

impl<'a> Output<'a> {
    fn bounded(quota: Rc<PrintQuota<'a>>) -> Self {
        Self {
            text: String::new(),
            quota: Some(quota),
        }
    }

    fn push(&mut self, ch: char) {
        if self
            .quota
            .as_ref()
            .is_none_or(|quota| quota.charge(ch.len_utf8()))
        {
            self.text.push(ch);
        }
    }

    fn push_str(&mut self, text: &str) {
        if self
            .quota
            .as_ref()
            .is_none_or(|quota| quota.charge(text.len()))
        {
            self.text.push_str(text);
        }
    }

    fn chars(&self) -> std::str::Chars<'_> {
        self.text.chars()
    }

    fn into_string(self) -> String {
        self.text
    }
}

impl std::fmt::Write for Output<'_> {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        if self
            .quota
            .as_ref()
            .is_some_and(|quota| !quota.charge(text.len()))
        {
            return Err(std::fmt::Error);
        }
        self.text.push_str(text);
        Ok(())
    }
}

struct Printer<'a> {
    out: Output<'a>,
    indentation: usize,
    skip_this_indent: usize,
    was_heredoc: bool,
    printing_connection: usize,
    inside_function_def: usize,
    deferred: Vec<HereDoc>,
    /// Printing a command substitution body (bash's `printing_comsub`):
    /// a `case` keeps its first clause on the `case ... in` line.
    printing_comsub: bool,
}

impl<'a> Printer<'a> {
    fn with_quota(quota: Rc<PrintQuota<'a>>) -> Self {
        Self {
            out: Output::bounded(quota),
            ..Self::default()
        }
    }

    fn quota(&self) -> Option<Rc<PrintQuota<'a>>> {
        self.out.quota.clone()
    }

    fn finish(self) -> Result<String> {
        if let Some(quota) = &self.out.quota
            && let Some(error) = quota.failure()
        {
            return Err(error);
        }
        Ok(self.out.into_string())
    }

    fn failed(&self) -> bool {
        self.out
            .quota
            .as_ref()
            .is_some_and(|quota| quota.failure.borrow().is_some())
    }
}

impl<'a> Printer<'a> {
    fn preflight(&self, bytes: usize) -> bool {
        self.out.quota.as_ref().is_none_or(|quota| {
            if !quota.charge(0) {
                return false;
            }
            if quota.fuel.get() >= bytes {
                true
            } else {
                let _ = quota.charge(bytes);
                false
            }
        })
    }

    fn print_word(&mut self, word: &Word) {
        if self.quota().is_none() {
            let text = self.word_text(word);
            self.out.push_str(&text);
            return;
        }
        let _ = self.stream_word(word);
    }

    fn stream_word(&mut self, word: &Word) -> std::fmt::Result {
        if let Some(raw) = &word.raw {
            return self.stream_normalized_raw(raw);
        }
        let mut quoted_literals = word.quoted;
        if quoted_literals {
            for part in &word.parts {
                if !self.out.quota.as_ref().unwrap().charge(1) {
                    return Err(std::fmt::Error);
                }
                if !matches!(part, WordPart::Literal(_)) {
                    quoted_literals = false;
                    break;
                }
            }
        }
        if quoted_literals {
            self.out.write_char('\'')?;
            for part in &word.parts {
                let WordPart::Literal(text) = part else {
                    unreachable!()
                };
                for ch in text.chars() {
                    if ch == '\'' {
                        self.out.write_str("'\\''")?;
                    } else {
                        self.out.write_char(ch)?;
                    }
                }
            }
            self.out.write_char('\'')
        } else {
            self.stream_parts(word)
        }
    }

    fn stream_commands(&mut self, commands: &[Command]) -> std::fmt::Result {
        // A substitution has fresh layout state, but writes into the same sink.
        let mut child = Self::default();
        std::mem::swap(&mut child.out, &mut self.out);
        child.print_list(commands);
        child.print_deferred_if_any("");
        std::mem::swap(&mut child.out, &mut self.out);
        if self.failed() {
            Err(std::fmt::Error)
        } else {
            Ok(())
        }
    }

    fn stream_normalized_raw(&mut self, raw: &str) -> std::fmt::Result {
        let mut in_single = false;
        let mut in_double = false;
        let mut i = 0;
        while let Some(ch) = raw[i..].chars().next() {
            if self.failed() {
                return Err(std::fmt::Error);
            }
            i += ch.len_utf8();
            match ch {
                '\'' if !in_double => {
                    in_single = !in_single;
                    self.out.write_char(ch)?;
                }
                '"' if !in_single => {
                    in_double = !in_double;
                    self.out.write_char(ch)?;
                }
                '$' if !in_single && !in_double && raw[i..].starts_with('\'') => {
                    // The existing ANSI decoder allocates. Admit its source a
                    // character at a time before it sees a bounded slice.
                    let body_start = i + 1;
                    let mut end = body_start;
                    let mut escaped = false;
                    while let Some(next) = raw[end..].chars().next() {
                        let bytes = next.len_utf8();
                        if !self.out.quota.as_ref().unwrap().charge(bytes) {
                            return Err(std::fmt::Error);
                        }
                        end += bytes;
                        if next == '\'' && !escaped {
                            break;
                        }
                        escaped = next == '\\' && !escaped;
                    }
                    match super::lexer::Lexer::decode_ansi_c_body(&raw[body_start..end]) {
                        Some((text, used)) => {
                            self.out.write_char('\'')?;
                            if !self.preflight(text.len()) {
                                return Err(std::fmt::Error);
                            }
                            for piece in text.split_inclusive('\'') {
                                if let Some(before) = piece.strip_suffix('\'') {
                                    self.out.write_str(before)?;
                                    self.out.write_str("'\\''")?;
                                } else {
                                    self.out.write_str(piece)?;
                                }
                            }
                            self.out.write_char('\'')?;
                            i = body_start + used;
                        }
                        None => self.out.write_char(ch)?,
                    }
                }
                '$' if !in_single && !in_double && raw[i..].starts_with('"') => {
                    if !self.out.quota.as_ref().unwrap().charge(1) {
                        return Err(std::fmt::Error);
                    }
                }
                '\\' if !in_single => {
                    if raw[i..].starts_with('\n') {
                        if !self.out.quota.as_ref().unwrap().charge(2) {
                            return Err(std::fmt::Error);
                        }
                        i += 1;
                    } else {
                        self.out.write_char(ch)?;
                        if let Some(next) = raw[i..].chars().next() {
                            self.out.write_char(next)?;
                            i += next.len_utf8();
                        }
                    }
                }
                _ => self.out.write_char(ch)?,
            }
        }
        Ok(())
    }

    fn stream_parts(&mut self, word: &Word) -> std::fmt::Result {
        for part in &word.parts {
            if !self.out.quota.as_ref().unwrap().charge(1) {
                return Err(std::fmt::Error);
            }
            match part {
                WordPart::Literal(s) => write!(self.out, "{}", s)?,
                WordPart::Variable(name) => write!(self.out, "${}", name)?,
                WordPart::BadSubstitution(text) => write!(self.out, "{}", text)?,
                // Printed as shell text (re-parsed by alias expansion);
                // never `Debug` (TM-INF-022).
                WordPart::CommandSubstitution(cmd) => {
                    self.out.write_str("$(")?;
                    self.stream_commands(cmd)?;
                    self.out.write_char(')')?;
                }
                WordPart::UnparsedCommandSubstitution { source, .. } => {
                    write!(self.out, "$({})", source)?
                }
                WordPart::ArithmeticExpansion(expr) => write!(self.out, "$(({}))", expr)?,
                WordPart::ParameterExpansion {
                    name,
                    operator,
                    operand,
                    colon_variant,
                } => match operator {
                    ParameterOp::UseDefault => {
                        let c = if *colon_variant { ":" } else { "" };
                        write!(self.out, "${{{}{}-{}}}", name, c, operand)?
                    }
                    ParameterOp::AssignDefault => {
                        let c = if *colon_variant { ":" } else { "" };
                        write!(self.out, "${{{}{}={}}}", name, c, operand)?
                    }
                    ParameterOp::UseReplacement => {
                        let c = if *colon_variant { ":" } else { "" };
                        write!(self.out, "${{{}{}+{}}}", name, c, operand)?
                    }
                    ParameterOp::Error => {
                        let c = if *colon_variant { ":" } else { "" };
                        write!(self.out, "${{{}{}?{}}}", name, c, operand)?
                    }
                    ParameterOp::RemovePrefixShort => {
                        write!(self.out, "${{{}#{}}}", name, operand)?
                    }
                    ParameterOp::RemovePrefixLong => {
                        write!(self.out, "${{{}##{}}}", name, operand)?
                    }
                    ParameterOp::RemoveSuffixShort => {
                        write!(self.out, "${{{}%{}}}", name, operand)?
                    }
                    ParameterOp::RemoveSuffixLong => {
                        write!(self.out, "${{{}%%{}}}", name, operand)?
                    }
                    ParameterOp::ReplaceFirst {
                        pattern,
                        replacement,
                    } => write!(self.out, "${{{}/{}/{}}}", name, pattern, replacement)?,
                    ParameterOp::ReplaceAll {
                        pattern,
                        replacement,
                    } => write!(self.out, "${{{}///{}/{}}}", name, pattern, replacement)?,
                    ParameterOp::UpperFirst => write!(self.out, "${{{}^{}}}", name, operand)?,
                    ParameterOp::UpperAll => write!(self.out, "${{{}^^{}}}", name, operand)?,
                    ParameterOp::LowerFirst => write!(self.out, "${{{},{}}}", name, operand)?,
                    ParameterOp::LowerAll => write!(self.out, "${{{},,{}}}", name, operand)?,
                    ParameterOp::ToggleFirst => write!(self.out, "${{{}~{}}}", name, operand)?,
                    ParameterOp::ToggleAll => write!(self.out, "${{{}~~{}}}", name, operand)?,
                },
                WordPart::Length(name) => write!(self.out, "${{#{}}}", name)?,
                WordPart::ArrayAccess { name, index } => {
                    write!(self.out, "${{{}[{}]}}", name, index)?
                }
                WordPart::ArrayLength(name) => write!(self.out, "${{#{}[@]}}", name)?,
                WordPart::ArrayIndices { name, star } => write!(
                    self.out,
                    "${{!{}[{}]}}",
                    name,
                    if *star { '*' } else { '@' }
                )?,
                WordPart::Substring {
                    name,
                    offset,
                    length,
                } => {
                    if let Some(len) = length {
                        write!(self.out, "${{{}:{}:{}}}", name, offset, len)?
                    } else {
                        write!(self.out, "${{{}:{}}}", name, offset)?
                    }
                }
                WordPart::IndirectExpansion {
                    name,
                    operator,
                    operand,
                    colon_variant,
                } => {
                    if let Some(op) = operator {
                        let c = if *colon_variant { ":" } else { "" };
                        let op_char = match op {
                            ParameterOp::UseDefault => "-",
                            ParameterOp::AssignDefault => "=",
                            ParameterOp::UseReplacement => "+",
                            ParameterOp::Error => "?",
                            _ => "",
                        };
                        write!(self.out, "${{!{}{}{}{}}}", name, c, op_char, operand)?
                    } else {
                        write!(self.out, "${{!{}}}", name)?
                    }
                }
                WordPart::IndirectSuffix { name, suffix } => {
                    write!(self.out, "${{!{name}{suffix}}}")?
                }
                WordPart::PrefixMatch { prefix, star } => write!(
                    self.out,
                    "${{!{}{}}}",
                    prefix,
                    if *star { '*' } else { '@' }
                )?,
                WordPart::UnparsedProcessSubstitution { source, is_input } => write!(
                    self.out,
                    "{}({})",
                    if *is_input { "<" } else { ">" },
                    source
                )?,
                WordPart::ProcessSubstitution { commands, is_input } => {
                    self.out.write_str(if *is_input { "<(" } else { ">(" })?;
                    self.stream_commands(commands)?;
                    self.out.write_char(')')?;
                }
                WordPart::Transformation { name, operator } => {
                    write!(self.out, "${{{}@{}}}", name, operator)?
                }
                WordPart::CompoundAssignment {
                    name,
                    append,
                    elements,
                } => {
                    let op = if *append { "+=" } else { "=" };
                    write!(self.out, "{}{}(", name, op)?;
                    for (i, element) in elements.iter().enumerate() {
                        if i > 0 {
                            write!(self.out, " ")?;
                        }
                        self.stream_parts(element)?;
                    }
                    write!(self.out, ")")?
                }
            }
        }
        Ok(())
    }

    fn print_words(&mut self, words: &[Word], separator: &str) {
        for (index, word) in words.iter().enumerate() {
            if index != 0 {
                self.out.push_str(separator);
            }
            self.print_word(word);
            if self.failed() {
                return;
            }
        }
    }

    fn print_assignment(&mut self, assignment: &Assignment) {
        self.out.push_str(&assignment.name);
        if let Some(index) = &assignment.index {
            self.out.push('[');
            self.out.push_str(index);
            self.out.push(']');
        }
        self.out
            .push_str(if assignment.append { "+=" } else { "=" });
        match &assignment.value {
            AssignmentValue::Scalar(word) => self.print_word(word),
            AssignmentValue::Array(elements) => {
                self.out.push('(');
                self.print_words(elements, " ");
                self.out.push(')');
            }
        }
    }

    fn print_simple_bounded(&mut self, sc: &SimpleCommand) {
        let mut has_word = false;
        for assignment in &sc.assignments {
            if self.failed() {
                return;
            }
            if has_word {
                self.out.push(' ');
            }
            self.print_assignment(assignment);
            has_word = true;
        }
        let mut name = Self::with_quota(self.quota().unwrap());
        let _ = name.stream_word(&sc.name);
        if name.failed() {
            return;
        }
        let name = name.out.into_string();
        if !(name.is_empty() && sc.name.raw.is_none()) {
            if has_word {
                self.out.push(' ');
            }
            if self.failed() {
                return;
            }
            self.out.text.push_str(&name);
            has_word = true;
        }
        for word in &sc.args {
            if self.failed() {
                return;
            }
            if has_word {
                self.out.push(' ');
            }
            self.print_word(word);
            has_word = true;
        }
        if !sc.redirects.is_empty() {
            if has_word {
                self.out.push(' ');
            }
            self.print_redirection_list(sc.redirects.as_slice());
        }
    }

    fn print_redirections_bounded(&mut self, redirects: &[Redirect]) {
        let mut heredocs = Vec::new();
        self.was_heredoc = false;
        for (index, redirect) in redirects.iter().enumerate() {
            if index != 0 {
                self.out.push(' ');
            }
            if matches!(
                redirect.kind,
                RedirectKind::HereDoc | RedirectKind::HereDocStrip
            ) {
                let delim = redirect.heredoc_delim.as_deref().unwrap_or_default();
                let mut delimiter = Self::with_quota(self.quota().unwrap());
                let _ = delimiter.stream_normalized_raw(delim);
                if delimiter.failed() {
                    return;
                }
                let normalized_delim = delimiter.out.into_string();
                self.print_redirector(redirect, 0);
                self.out
                    .push_str(if redirect.kind == RedirectKind::HereDocStrip {
                        "<<-"
                    } else {
                        "<<"
                    });
                if self.failed() {
                    return;
                }
                self.out.text.push_str(&normalized_delim);
                // The delimiter is already admitted, so quote removal cannot
                // allocate more text than that bounded source.
                let eof = if normalized_delim.starts_with('\'') {
                    heredoc_eof_from_raw(&normalized_delim).0
                } else {
                    normalized_delim
                };
                if !self.out.quota.as_ref().unwrap().charge(eof.len()) {
                    return;
                }
                let body = if let Some(raw) = redirect.target.raw.as_deref() {
                    if !self.out.quota.as_ref().unwrap().charge(raw.len()) {
                        return;
                    }
                    raw.to_owned()
                } else {
                    let mut child = Self::with_quota(self.quota().unwrap());
                    let _ = child.stream_word(&redirect.target);
                    if child.failed() {
                        return;
                    }
                    child.out.into_string()
                };
                heredocs.push(HereDoc {
                    body,
                    eof,
                    prepaid: true,
                });
            } else {
                self.print_redirect_bounded(redirect);
            }
        }
        if heredocs.is_empty() {
            return;
        }
        if self.printing_connection > 0 {
            self.deferred.extend(heredocs);
        } else {
            self.print_heredoc_bodies(&heredocs);
        }
    }

    fn print_redirector(&mut self, redirect: &Redirect, default_fd: i32) {
        if let Some(var) = &redirect.fd_var {
            let _ = write!(self.out, "{{{var}}}");
        } else if let Some(fd) = redirect.fd
            && fd != default_fd
        {
            let _ = write!(self.out, "{fd}");
        }
    }

    fn print_redirect_bounded(&mut self, redirect: &Redirect) {
        let default_fd = if matches!(
            redirect.kind,
            RedirectKind::Input
                | RedirectKind::HereString
                | RedirectKind::ReadWrite
                | RedirectKind::DupInput
        ) {
            0
        } else {
            1
        };
        if redirect.kind == RedirectKind::OutputBoth {
            self.out.push_str("&> ");
            self.print_word(&redirect.target);
            return;
        }
        if redirect.kind == RedirectKind::DupOutput {
            let mut target = Self::with_quota(self.quota().unwrap());
            let _ = target.stream_word(&redirect.target);
            if target.failed() {
                return;
            }
            let target = target.out.into_string();
            let default_fd = redirect.fd_var.is_none() && redirect.fd.is_none_or(|fd| fd == 1);
            let word_target = !target.starts_with(['-', '$'])
                && !target.chars().next().is_some_and(|ch| ch.is_ascii_digit());
            if default_fd && word_target {
                self.out.push_str("&> ");
            } else {
                self.print_redirector(redirect, 1);
                self.out.push_str(">&");
            }
            if !self.failed() {
                self.out.text.push_str(&target);
            }
            return;
        }
        let suffix = match redirect.kind {
            RedirectKind::Output => "> ",
            RedirectKind::Clobber => ">| ",
            RedirectKind::Append => ">> ",
            RedirectKind::Input => "< ",
            RedirectKind::HereString => "<<< ",
            RedirectKind::ReadWrite => "<> ",
            RedirectKind::DupInput => "<&",
            RedirectKind::DupOutput => ">&",
            RedirectKind::HereDoc | RedirectKind::HereDocStrip | RedirectKind::OutputBoth => return,
        };
        self.print_redirector(redirect, default_fd);
        self.out.push_str(suffix);
        self.print_word(&redirect.target);
    }
}

impl<'a> Default for Printer<'a> {
    fn default() -> Self {
        Self {
            out: Output::default(),
            indentation: 0,
            skip_this_indent: 0,
            was_heredoc: false,
            printing_connection: 0,
            inside_function_def: 0,
            deferred: Vec::new(),
            printing_comsub: false,
        }
    }
}

impl<'a> Printer<'a> {
    fn indent(&mut self, n: usize) {
        for _ in 0..n {
            self.out.push(' ');
        }
    }

    /// `newline (s)`: newline, indent, then `s`.
    fn newline(&mut self, s: &str) {
        self.out.push('\n');
        self.indent(self.indentation);
        self.out.push_str(s);
    }

    /// `semicolon ()`: a `;` unless the text already ends a line or a job.
    fn semicolon(&mut self) {
        if matches!(self.out.chars().last(), Some('&' | '\n')) {
            return;
        }
        self.out.push(';');
    }

    /// Prints a function body; returns the redirections of a `{ }` body,
    /// which print after its closing brace.
    fn print_function_body<'cmd>(&mut self, body: &'cmd Command) -> &'cmd [Redirect] {
        match body {
            Command::Compound(CompoundCommand::BraceGroup(cmds), redirects) => {
                self.print_list(cmds);
                redirects
            }
            other => {
                self.make(Some(other));
                &[]
            }
        }
    }

    fn close_function(&mut self, func_redirects: &[Redirect]) {
        if func_redirects.is_empty() {
            self.newline("}");
        } else {
            self.newline("} ");
            self.print_redirection_list(func_redirects);
        }
    }

    fn print_deferred_if_any(&mut self, cstring: &str) {
        if !self.deferred.is_empty() {
            self.print_deferred_heredocs(cstring);
        }
    }

    fn print_deferred_heredocs(&mut self, cstring: &str) {
        let prints_cstring = !cstring.is_empty() && cstring != ";";
        if prints_cstring {
            self.out.push_str(cstring);
        }
        if !self.deferred.is_empty() {
            let docs = std::mem::take(&mut self.deferred);
            self.print_heredoc_bodies(&docs);
            if prints_cstring {
                self.out.push(' ');
            }
            self.was_heredoc = true;
        }
    }

    fn print_heredoc_bodies(&mut self, docs: &[HereDoc]) {
        self.out.push('\n');
        for doc in docs {
            if self.failed() {
                return;
            }
            if doc.prepaid {
                self.out.text.push_str(&doc.body);
                self.out.text.push_str(&doc.eof);
            } else {
                self.out.push_str(&doc.body);
                self.out.push_str(&doc.eof);
            }
            self.out.push('\n');
        }
    }

    /// A command sequence (`;`/newline separated).
    fn print_list(&mut self, cmds: &[Command]) {
        if self.failed() {
            return;
        }
        match cmds {
            [] => self.make(None),
            [only] => self.make(Some(only)),
            [first, rest @ ..] => {
                self.make_connection(first, rest.iter().map(|c| (Conn::Semi, Some(c))));
            }
        }
    }

    /// `make_command_string_internal`.
    fn make(&mut self, cmd: Option<&Command>) {
        if self.failed() {
            return;
        }
        let Some(cmd) = cmd else {
            return;
        };
        if self
            .out
            .quota
            .as_ref()
            .is_some_and(|quota| !quota.charge(1))
        {
            return;
        }
        if self.skip_this_indent > 0 {
            self.skip_this_indent -= 1;
        } else {
            self.indent(self.indentation);
        }
        match cmd {
            Command::Simple(sc) => self.print_simple(sc),
            Command::Pipeline(p) => {
                if p.negated {
                    self.out.push_str("! ");
                }
                match p.commands.as_slice() {
                    [] => {}
                    [only] => {
                        self.skip_this_indent += 1;
                        self.make(Some(only));
                    }
                    [first, rest @ ..] => {
                        self.connection_body(first, rest.iter().map(|c| (Conn::Pipe, Some(c))));
                    }
                }
            }
            Command::List(list) => {
                let rest = list.rest.iter().map(|(op, c)| {
                    let conn = match op {
                        ListOperator::And => Conn::And,
                        ListOperator::Or => Conn::Or,
                        ListOperator::Semicolon => Conn::Semi,
                        ListOperator::Background => Conn::Amp,
                    };
                    let second = if is_empty_placeholder(c) {
                        None
                    } else {
                        Some(c)
                    };
                    (conn, second)
                });
                self.connection_body(&list.first, rest);
            }
            Command::Compound(cc, redirects) => {
                self.print_compound(cc);
                if !redirects.is_empty() {
                    self.out.push(' ');
                    self.print_redirection_list(redirects);
                }
            }
            Command::Function(f) => self.print_function_def(f),
        }
    }

    /// A connection chain, as an indented command of its own.
    fn make_connection<'cmd>(
        &mut self,
        first: &Command,
        rest: impl IntoIterator<Item = (Conn, Option<&'cmd Command>)>,
    ) {
        if self.skip_this_indent > 0 {
            self.skip_this_indent -= 1;
        } else {
            self.indent(self.indentation);
        }
        self.connection_body(first, rest);
    }

    /// The `cm_connection` case, flattened over a left-associative chain:
    /// each link ends like bash's nested connection (deferred heredocs).
    fn connection_body<'cmd>(
        &mut self,
        first: &Command,
        rest: impl IntoIterator<Item = (Conn, Option<&'cmd Command>)>,
    ) {
        if self.failed() {
            return;
        }
        self.skip_this_indent += 1;
        self.printing_connection += 1;
        self.make(Some(first));
        for (conn, second) in rest {
            if self.failed() {
                return;
            }
            match conn {
                Conn::Amp | Conn::Pipe => {
                    let s = if conn == Conn::Amp { " &" } else { " |" };
                    self.print_deferred_heredocs(s);
                    if conn != Conn::Amp || second.is_some() {
                        self.out.push(' ');
                        self.skip_this_indent += 1;
                    }
                }
                Conn::And | Conn::Or => {
                    let s = if conn == Conn::And { " && " } else { " || " };
                    self.print_deferred_heredocs(s);
                    if second.is_some() {
                        self.skip_this_indent += 1;
                    }
                }
                Conn::Semi => {
                    if self.deferred.is_empty() {
                        if !self.was_heredoc {
                            self.out.push(';');
                        } else {
                            self.was_heredoc = false;
                        }
                    } else {
                        let s = if self.inside_function_def > 0 {
                            ""
                        } else {
                            ";"
                        };
                        self.print_deferred_heredocs(s);
                    }
                    if self.inside_function_def > 0 {
                        self.out.push('\n');
                    } else {
                        self.out.push(' ');
                        if second.is_some() {
                            self.skip_this_indent += 1;
                        }
                    }
                }
            }
            self.make(second);
            self.print_deferred_if_any("");
        }
        self.printing_connection -= 1;
    }

    fn word_text(&self, word: &Word) -> String {
        match &word.raw {
            Some(raw) => normalize_raw_word(raw),
            None => self.reconstruct_word(word),
        }
    }

    fn reconstruct_word(&self, word: &Word) -> String {
        let mut text = String::new();
        for part in &word.parts {
            match part {
                WordPart::Literal(value) => text.push_str(value),
                WordPart::CommandSubstitution(commands) => {
                    text.push_str("$(");
                    text.push_str(&self.inline_commands(commands));
                    text.push(')');
                }
                WordPart::ProcessSubstitution { commands, is_input } => {
                    text.push_str(if *is_input { "<(" } else { ">(" });
                    text.push_str(&self.inline_commands(commands));
                    text.push(')');
                }
                other => {
                    let single = Word {
                        parts: vec![other.clone()],
                        quoted: false,
                        has_unquoted_glob: false,
                        part_quoted: Vec::new(),
                        raw: None,
                    };
                    text.push_str(&single.to_string());
                }
            }
        }
        if word.quoted
            && word
                .parts
                .iter()
                .all(|part| matches!(part, WordPart::Literal(_)))
        {
            return super::raw::single_quote(&text);
        }
        text
    }

    fn inline_commands(&self, commands: &[Command]) -> String {
        let mut printer = match self.quota() {
            Some(quota) => Self::with_quota(quota),
            None => Self::default(),
        };
        printer.print_list(commands);
        printer.print_deferred_if_any("");
        printer.out.into_string()
    }

    fn assignment_text(&self, assignment: &Assignment) -> String {
        let mut text = assignment.name.clone();
        if let Some(index) = &assignment.index {
            text.push('[');
            text.push_str(index);
            text.push(']');
        }
        text.push_str(if assignment.append { "+=" } else { "=" });
        match &assignment.value {
            AssignmentValue::Scalar(word) => text.push_str(&self.word_text(word)),
            AssignmentValue::Array(elements) => {
                let values: Vec<String> = elements
                    .iter()
                    .map(|word| self.word_text(word))
                    .collect();
                text.push('(');
                text.push_str(&values.join(" "));
                text.push(')');
            }
        }
        text
    }

    fn redirection_text(&self, redirect: &Redirect) -> String {
        let target = self.word_text(&redirect.target);
        match redirect.kind {
            RedirectKind::Output => format!("{}> {target}", redirector(redirect, 1)),
            RedirectKind::Clobber => format!("{}>| {target}", redirector(redirect, 1)),
            RedirectKind::Append => format!("{}>> {target}", redirector(redirect, 1)),
            RedirectKind::Input => format!("{}< {target}", redirector(redirect, 0)),
            RedirectKind::HereString => format!("{}<<< {target}", redirector(redirect, 0)),
            RedirectKind::ReadWrite => format!("{}<> {target}", redirector(redirect, 0)),
            RedirectKind::OutputBoth => format!("&> {target}"),
            RedirectKind::DupOutput => {
                let fd_is_default = redirect.fd_var.is_none()
                    && redirect.fd.is_none_or(|fd| fd == 1);
                let word_target = !target.starts_with(|c: char| c == '-' || c.is_ascii_digit())
                    && !target.starts_with('$');
                if fd_is_default && word_target {
                    format!("&> {target}")
                } else {
                    format!("{}>&{target}", redirector(redirect, 1))
                }
            }
            RedirectKind::DupInput => format!("{}<&{target}", redirector(redirect, 0)),
            RedirectKind::HereDoc | RedirectKind::HereDocStrip => String::new(),
        }
    }

    fn print_simple(&mut self, sc: &SimpleCommand) {
        if self.quota().is_some() {
            self.print_simple_bounded(sc);
            return;
        }
        let mut words: Vec<String> = Vec::new();
        for a in &sc.assignments {
            words.push(self.assignment_text(a));
        }
        let name = self.word_text(&sc.name);
        if !(name.is_empty() && sc.name.raw.is_none()) {
            words.push(name);
        }
        words.extend(sc.args.iter().map(|word| self.word_text(word)));
        self.out.push_str(&words.join(" "));
        if !sc.redirects.is_empty() {
            if !words.is_empty() {
                self.out.push(' ');
            }
            self.print_redirection_list(&sc.redirects);
        }
    }

    fn print_redirection_list(&mut self, redirects: &[Redirect]) {
        if self.quota().is_some() {
            self.print_redirections_bounded(redirects);
            return;
        }
        let mut heredocs = Vec::new();
        self.was_heredoc = false;
        for (i, r) in redirects.iter().enumerate() {
            if i > 0 {
                self.out.push(' ');
            }
            if matches!(r.kind, RedirectKind::HereDoc | RedirectKind::HereDocStrip) {
                let delim = normalize_raw_word(r.heredoc_delim.as_deref().unwrap_or_default());
                self.out.push_str(&redirector(r, 0));
                self.out.push_str(if r.kind == RedirectKind::HereDocStrip {
                    "<<-"
                } else {
                    "<<"
                });
                self.out.push_str(&delim);
                let eof = if delim.starts_with('\'') {
                    heredoc_eof_from_raw(&delim).0
                } else {
                    delim
                };
                heredocs.push(HereDoc {
                    body: r
                        .target
                        .raw
                        .clone()
                        .unwrap_or_else(|| self.reconstruct_word(&r.target)),
                    eof,
                    prepaid: false,
                });
            } else {
                let text = self.redirection_text(r);
                self.out.push_str(&text);
            }
        }
        if heredocs.is_empty() {
            return;
        }
        if self.printing_connection > 0 {
            self.deferred.extend(heredocs);
        } else {
            self.print_heredoc_bodies(&heredocs);
        }
    }

    fn print_compound(&mut self, cc: &CompoundCommand) {
        match cc {
            CompoundCommand::If(c) => self.print_if(
                &c.condition,
                &c.then_branch,
                &c.elif_branches,
                c.else_branch.as_deref(),
            ),
            CompoundCommand::For(f) => {
                self.out.push_str("for ");
                self.out.push_str(&f.variable);
                self.out.push_str(" in ");
                match &f.words {
                    Some(words) => {
                        self.print_words(words, " ");
                    }
                    None => self.out.push_str("\"$@\""),
                }
                self.loop_body_after_head(&f.body);
            }
            CompoundCommand::Select(f) => {
                self.out.push_str("select ");
                self.out.push_str(&f.variable);
                self.out.push_str(" in ");
                self.print_words(&f.words, " ");
                self.loop_body_after_head(&f.body);
            }
            CompoundCommand::ArithmeticFor(f) => {
                self.out.push_str("for ((");
                let parts = f
                    .raw
                    .as_ref()
                    .map(|raw| [&raw[0], &raw[1], &raw[2]])
                    .unwrap_or([&f.init, &f.condition, &f.step]);
                for (index, part) in parts.into_iter().enumerate() {
                    if index > 0 {
                        self.out.push_str("; ");
                    }
                    let trimmed = part.trim_start();
                    self.out.push_str(if trimmed.trim().is_empty() {
                        "1"
                    } else {
                        trimmed
                    });
                }
                self.out.push_str("))");
                self.newline("do\n");
                self.indentation += INDENT_AMOUNT;
                self.print_list(&f.body);
                self.print_deferred_if_any("");
                self.semicolon();
                self.indentation -= INDENT_AMOUNT;
                self.newline("done");
            }
            CompoundCommand::While(w) => self.print_until_or_while("while", &w.condition, &w.body),
            CompoundCommand::Until(w) => self.print_until_or_while("until", &w.condition, &w.body),
            CompoundCommand::Case(c) => {
                self.out.push_str("case ");
                self.print_word(&c.word);
                self.out.push_str(" in ");
                self.indentation += INDENT_AMOUNT;
                for (index, item) in c.cases.iter().enumerate() {
                    if !(self.printing_comsub && index == 0) {
                        self.newline("");
                    }
                    if self.failed() {
                        return;
                    }
                    self.print_words(&item.patterns, " | ");
                    self.out.push_str(")\n");
                    self.indentation += INDENT_AMOUNT;
                    self.print_list(&item.commands);
                    self.indentation -= INDENT_AMOUNT;
                    self.print_deferred_if_any("");
                    self.newline(match item.terminator {
                        CaseTerminator::Break => ";;",
                        CaseTerminator::FallThrough => ";&",
                        CaseTerminator::Continue => ";;&",
                    });
                }
                self.indentation -= INDENT_AMOUNT;
                self.newline("esac");
            }
            CompoundCommand::Subshell(cmds) => {
                self.out.push_str("( ");
                self.skip_this_indent += 1;
                self.print_list(cmds);
                self.print_deferred_if_any("");
                self.out.push_str(" )");
            }
            CompoundCommand::BraceGroup(cmds) => {
                self.out.push_str("{ ");
                if self.inside_function_def == 0 {
                    self.skip_this_indent += 1;
                } else {
                    self.out.push('\n');
                    self.indentation += INDENT_AMOUNT;
                }
                self.print_list(cmds);
                self.print_deferred_if_any("");
                if self.inside_function_def > 0 {
                    self.out.push('\n');
                    self.indentation -= INDENT_AMOUNT;
                    self.indent(self.indentation);
                } else {
                    self.semicolon();
                    self.out.push(' ');
                }
                self.out.push('}');
            }
            CompoundCommand::Arithmetic(expr) => {
                self.out.push_str("((");
                self.out.push_str(expr);
                self.out.push_str("))");
            }
            CompoundCommand::Time(t) => {
                self.out.push_str("time");
                if t.posix_format {
                    self.out.push_str(" -p");
                }
                if let Some(cmd) = &t.command {
                    self.out.push(' ');
                    self.skip_this_indent += 1;
                    self.make(Some(cmd));
                }
            }
            CompoundCommand::Test(expression) => {
                self.out.push_str("[[ ");
                self.conditional_expression(expression);
                self.out.push_str(" ]]");
            }
            CompoundCommand::Coproc(c) => {
                self.out.push_str("coproc ");
                self.out.push_str(&c.name);
                self.out.push(' ');
                self.skip_this_indent += 1;
                self.make(Some(&c.body));
            }
        }
    }

    fn conditional_expression(&mut self, expression: &TestExpr) {
        match expression {
            TestExpr::Word(word) => {
                self.out.push_str("-n ");
                self.print_word(word);
            }
            TestExpr::Unary { operator, operand } => {
                self.out.push_str(operator);
                self.out.push(' ');
                self.print_word(operand);
            }
            TestExpr::Binary {
                left,
                operator,
                right,
            } => {
                self.print_word(left);
                self.out.push(' ');
                self.out.push_str(operator);
                self.out.push(' ');
                self.print_word(right);
            }
            TestExpr::Not(child) => {
                self.out.push_str("! ");
                self.conditional_expression(child);
            }
            TestExpr::Group(child) => {
                self.out.push_str("( ");
                self.conditional_expression(child);
                self.out.push_str(" )");
            }
            TestExpr::And(children) | TestExpr::Or(children) => {
                let separator = if matches!(expression, TestExpr::And(_)) {
                    " && "
                } else {
                    " || "
                };
                for (index, child) in children.iter().enumerate() {
                    if index != 0 {
                        self.out.push_str(separator);
                    }
                    self.conditional_expression(child);
                }
            }
        }
    }

    fn loop_body_after_head(&mut self, body: &[Command]) {
        self.out.push(';');
        self.newline("do\n");
        self.indentation += INDENT_AMOUNT;
        self.print_list(body);
        self.print_deferred_if_any("");
        self.semicolon();
        self.indentation -= INDENT_AMOUNT;
        self.newline("done");
    }

    fn print_until_or_while(&mut self, which: &str, test: &[Command], body: &[Command]) {
        self.out.push_str(which);
        self.out.push(' ');
        self.skip_this_indent += 1;
        self.print_list(test);
        self.print_deferred_if_any("");
        self.semicolon();
        self.out.push_str(" do\n");
        self.indentation += INDENT_AMOUNT;
        self.print_list(body);
        self.print_deferred_if_any("");
        self.indentation -= INDENT_AMOUNT;
        self.semicolon();
        self.newline("done");
    }

    /// `if`; bash stores `elif` as a nested `if` in the `else` branch.
    fn print_if(
        &mut self,
        test: &[Command],
        then: &[Command],
        elifs: &[(Vec<Command>, Vec<Command>)],
        else_branch: Option<&[Command]>,
    ) {
        if self.failed() {
            return;
        }
        self.print_if_clause(test, then);
        for (etest, ethen) in elifs {
            if self.failed() {
                return;
            }
            self.semicolon();
            self.newline("else\n");
            self.indentation += INDENT_AMOUNT;
            self.indent(self.indentation);
            self.print_if_clause(etest, ethen);
        }
        if self.failed() {
            return;
        }
        if let Some(else_cmds) = else_branch {
            self.semicolon();
            self.newline("else\n");
            self.indentation += INDENT_AMOUNT;
            self.print_list(else_cmds);
            self.print_deferred_if_any("");
            self.indentation -= INDENT_AMOUNT;
        }
        for level in (0..=elifs.len()).rev() {
            self.semicolon();
            self.newline("fi");
            if level > 0 {
                self.indentation -= INDENT_AMOUNT;
            }
        }
    }

    fn print_if_clause(&mut self, test: &[Command], then: &[Command]) {
        self.out.push_str("if ");
        self.skip_this_indent += 1;
        self.print_list(test);
        self.semicolon();
        self.out.push_str(" then\n");
        self.indentation += INDENT_AMOUNT;
        self.print_list(then);
        self.print_deferred_if_any("");
        self.indentation -= INDENT_AMOUNT;
    }

    /// Nested `function name () { ... }` inside a body.
    fn print_function_def(&mut self, f: &FunctionDef) {
        self.out.push_str("function ");
        self.out.push_str(&f.name);
        self.out.push_str(" () \n");
        self.indent(self.indentation);
        self.out.push_str("{ \n");
        self.inside_function_def += 1;
        self.indentation += INDENT_AMOUNT;
        let func_redirects = self.print_function_body(&f.body);
        self.print_deferred_if_any("");
        self.indentation -= INDENT_AMOUNT;
        self.inside_function_def -= 1;
        self.close_function(func_redirects);
    }
}

/// The `cmd &` placeholder the parser appends after a trailing `&`.
fn is_empty_placeholder(cmd: &Command) -> bool {
    matches!(cmd, Command::Simple(sc)
        if sc.assignments.is_empty()
            && sc.args.is_empty()
            && sc.redirects.is_empty()
            && sc.name.raw.is_none()
            && sc.name.parts.iter().all(|p| matches!(p, WordPart::Literal(s) if s.is_empty())))
}

/// One clause of `for ((...))`: leading blanks dropped, empty means `1`.
fn arith_for_part(p: &str) -> String {
    let t = p.trim_start();
    if t.trim().is_empty() {
        "1".to_string()
    } else {
        t.to_string()
    }
}

fn redirector(r: &Redirect, default_fd: i32) -> String {
    if let Some(var) = &r.fd_var {
        return format!("{{{var}}}");
    }
    match r.fd {
        Some(fd) if fd != default_fd => fd.to_string(),
        _ => String::new(),
    }
}

fn redirection_text(r: &Redirect) -> String {
    let target = word_text(&r.target);
    match r.kind {
        RedirectKind::Output => format!("{}> {target}", redirector(r, 1)),
        RedirectKind::Clobber => format!("{}>| {target}", redirector(r, 1)),
        RedirectKind::Append => format!("{}>> {target}", redirector(r, 1)),
        RedirectKind::Input => format!("{}< {target}", redirector(r, 0)),
        RedirectKind::HereString => format!("{}<<< {target}", redirector(r, 0)),
        RedirectKind::ReadWrite => format!("{}<> {target}", redirector(r, 0)),
        RedirectKind::OutputBoth => format!("&> {target}"),
        RedirectKind::DupOutput => {
            let fd_is_default = r.fd_var.is_none() && r.fd.is_none_or(|fd| fd == 1);
            let word_target = !target.starts_with(|c: char| c == '-' || c.is_ascii_digit())
                && !target.starts_with('$');
            if fd_is_default && word_target {
                format!("&> {target}")
            } else {
                format!("{}>&{target}", redirector(r, 1))
            }
        }
        RedirectKind::DupInput => format!("{}<&{target}", redirector(r, 0)),
        RedirectKind::HereDoc | RedirectKind::HereDocStrip => String::new(),
    }
}

fn assignment_text(a: &Assignment) -> String {
    let mut s = a.name.clone();
    if let Some(idx) = &a.index {
        s.push('[');
        s.push_str(idx);
        s.push(']');
    }
    s.push_str(if a.append { "+=" } else { "=" });
    match &a.value {
        AssignmentValue::Scalar(w) => s.push_str(&word_text(w)),
        AssignmentValue::Array(elems) => {
            let e: Vec<String> = elems.iter().map(word_text).collect();
            s.push('(');
            s.push_str(&e.join(" "));
            s.push(')');
        }
    }
    s
}

/// A word as written: its source text without line continuations, or a
/// reconstruction when the parser did not record the source.
pub(crate) fn word_text(w: &Word) -> String {
    match &w.raw {
        Some(raw) => normalize_raw_word(raw),
        None => reconstruct_word(w),
    }
}

/// Source text the way bash prints it back: backslash-newline is dropped
/// outside single quotes, `$'...'` becomes the single-quoted text it decodes
/// to (`$'it\'s'` prints `'it'\''s'`) and `$"..."` prints as `"..."`.
/// Inside double quotes both stay as written.
fn normalize_raw_word(raw: &str) -> String {
    if !raw.contains("\\\n") && !raw.contains("$'") && !raw.contains("$\"") {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while let Some(c) = raw[i..].chars().next() {
        i += c.len_utf8();
        match c {
            '\'' if !in_double => {
                in_single = !in_single;
                out.push(c);
            }
            '"' if !in_single => {
                in_double = !in_double;
                out.push(c);
            }
            '$' if !in_single && !in_double && raw[i..].starts_with('\'') => {
                match super::lexer::Lexer::decode_ansi_c_body(&raw[i + 1..]) {
                    Some((text, used)) => {
                        out.push_str(&super::raw::single_quote(&text));
                        i += 1 + used;
                    }
                    None => out.push(c),
                }
            }
            '$' if !in_single && !in_double && raw[i..].starts_with('"') => {}
            '\\' if !in_single => {
                if raw[i..].starts_with('\n') {
                    i += 1;
                } else {
                    out.push(c);
                    if let Some(n) = raw[i..].chars().next() {
                        out.push(n);
                        i += n.len_utf8();
                    }
                }
            }
            _ => out.push(c),
        }
    }
    out
}

fn reconstruct_word(w: &Word) -> String {
    let mut s = String::new();
    for part in &w.parts {
        match part {
            WordPart::Literal(t) => s.push_str(t),
            WordPart::CommandSubstitution(cmds) => {
                s.push_str("$(");
                s.push_str(&inline_commands(cmds));
                s.push(')');
            }
            WordPart::ProcessSubstitution { commands, is_input } => {
                s.push_str(if *is_input { "<(" } else { ">(" });
                s.push_str(&inline_commands(commands));
                s.push(')');
            }
            other => {
                let single = Word {
                    parts: vec![other.clone()],
                    quoted: false,
                    has_unquoted_glob: false,
                    part_quoted: Vec::new(),
                    raw: None,
                };
                s.push_str(&single.to_string());
            }
        }
    }
    if w.quoted && w.parts.iter().all(|p| matches!(p, WordPart::Literal(_))) {
        return super::raw::single_quote(&s);
    }
    s
}

/// Render a shell job's command with the existing Bash command printer. Every
/// printed byte charges both the output ceiling and the caller's request budget;
/// AST traversal, discarded source and ANSI-decoding work also consume fuel.
/// Word parts write
/// through the quota before allocating output, and nested substitutions share it.
/// This does not execute or expand words.
pub fn command_string(
    command: &Command,
    fuel: &Cell<usize>,
    max_fuel: usize,
    execution_budget: Option<&ExecutionBudget>,
) -> Result<String> {
    let quota = Rc::new(PrintQuota {
        fuel,
        max_fuel,
        execution_budget,
        failure: RefCell::new(None),
    });
    quota.charge(0);
    let mut printer = Printer::with_quota(quota);
    printer.make(Some(command));
    printer.print_deferred_if_any("");
    printer.finish()
}

/// A substitution body as bash stores it after parsing (`print_comsub`).
pub(crate) fn comsub_commands(cmds: &[Command]) -> String {
    let mut p = Printer {
        printing_comsub: true,
        ..Printer::default()
    };
    p.print_list(cmds);
    p.print_deferred_if_any("");
    p.out.into_string()
}

/// Print a command-substitution body while charging every output byte to the
/// parser's shared fuel and request budget. Nested reconstructions reuse the
/// same quota, so process substitutions cannot escape the caller's limits.
pub(crate) fn comsub_commands_bounded(
    cmds: &[Command],
    fuel: &Cell<usize>,
    max_fuel: usize,
    execution_budget: Option<&ExecutionBudget>,
) -> Result<String> {
    let quota = Rc::new(PrintQuota {
        fuel,
        max_fuel,
        execution_budget,
        failure: RefCell::new(None),
    });
    let mut p = Printer::with_quota(quota);
    p.printing_comsub = true;
    p.print_list(cmds);
    p.print_deferred_if_any("");
    p.finish()
}

/// Commands printed on one line (inside `$(...)` reconstructions).
pub(crate) fn inline_commands(cmds: &[Command]) -> String {
    let mut p = Printer::default();
    p.print_list(cmds);
    p.print_deferred_if_any("");
    p.out.into_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::Parser;

    fn print_fn(src: &str) -> String {
        let script = Parser::new(src).parse().expect("parses");
        let Some(Command::Function(f)) = script.commands.first() else {
            panic!("expected a function definition");
        };
        function_string(&f.name, &f.body)
    }

    #[test]
    fn simple_body_keeps_words_as_written() {
        assert_eq!(
            print_fn("f() { echo 'a b' \"$x\" \\$y >out; }"),
            "f () \n{ \n    echo 'a b' \"$x\" \\$y > out\n}"
        );
    }

    #[test]
    fn elif_prints_as_nested_else_if() {
        assert_eq!(
            print_fn("f() { if a; then b; elif c; then d; fi; }"),
            "f () \n{ \n    if a; then\n        b;\n    else\n        if c; then\n            d;\n        fi;\n    fi\n}"
        );
    }

    #[test]
    fn heredoc_body_follows_its_line() {
        assert_eq!(
            print_fn("f() { cat <<'E'\n$x\nE\necho z; }"),
            "f () \n{ \n    cat <<'E'\n$x\nE\n\n    echo z\n}"
        );
    }

    #[test]
    fn heredoc_continuations_do_not_reappear_in_printed_delimiters() {
        let script = Parser::new(": <<EO\\\nF\nbody\nEOF\n").parse().unwrap();
        assert_eq!(comsub_commands(&script.commands), ": <<EOF\nbody\nEOF\n");
    }

    #[test]
    fn lone_cond_operand_gets_dash_n() {
        assert_eq!(
            print_fn("f() { [[ x ]]; [[ ! ( a == b ) ]]; }"),
            "f () \n{ \n    [[ -n x ]];\n    [[ ! ( a == b ) ]]\n}"
        );
    }

    #[test]
    fn pipe_both_prints_as_dup_redirect() {
        assert_eq!(print_fn("f() { a |& b; }"), "f () \n{ \n    a 2>&1 | b\n}");
    }

    #[test]
    fn reserved_word_name_gets_function_keyword() {
        let body = Parser::new("{ :; }").parse().expect("parses").commands[0].clone();
        assert!(function_string("if", &body).starts_with("function if () \n"));
    }

    #[test]
    fn word_without_source_text_is_reconstructed() {
        assert_eq!(word_text(&Word::literal("plain")), "plain");
        assert_eq!(word_text(&Word::quoted_literal("a b")), "'a b'");
    }

    #[test]
    fn line_continuation_dropped_outside_single_quotes() {
        assert_eq!(normalize_raw_word("a\\\nb"), "ab");
        assert_eq!(normalize_raw_word("'a\\\nb'"), "'a\\\nb'");
    }

    #[test]
    fn ansi_c_and_locale_quotes_print_as_plain_quotes() {
        assert_eq!(normalize_raw_word("$'a\\tb'"), "'a\tb'");
        assert_eq!(normalize_raw_word("$'it\\'s'"), "'it'\\''s'");
        assert_eq!(normalize_raw_word("$\"y\""), "\"y\"");
        assert_eq!(normalize_raw_word("\"$'x'\""), "\"$'x'\"");
        assert_eq!(normalize_raw_word("'$\"z\"'"), "'$\"z\"'");
    }

    #[test]
    fn empty_arith_for_clause_reads_one() {
        assert_eq!(arith_for_part("   "), "1");
        assert_eq!(arith_for_part(" i < 3 "), "i < 3 ");
    }

    #[test]
    fn top_level_words_keep_source_text_for_early_brace_expansion() {
        // Brace expansion needs the source phase before quote/parameter parsing.
        let script = Parser::new("echo 'a'").parse().expect("parses");
        let Some(Command::Simple(sc)) = script.commands.first() else {
            panic!("expected a simple command");
        };
        assert_eq!(sc.args[0].raw.as_deref(), Some("'a'"));
    }
}

#[cfg(test)]
mod job_command_tests {
    use super::*;
    use crate::parser::Parser;

    fn render(source: &str, limit: usize) -> Result<String> {
        let script = Parser::new(source).parse().unwrap();
        command_string(&script.commands[0], &Cell::new(limit), limit, None)
    }

    #[test]
    fn job_labels_preserve_quotes_and_normalize_connections() {
        for (source, expected) in [
            ("echo 'a b' \"$x\"", "echo 'a b' \"$x\""),
            ("false|true", "false | true"),
            ("true&&false", "true && false"),
            ("{ true; false; }", "{ true; false; }"),
            ("(true;false)", "( true; false )"),
            ("true &", "true &"),
        ] {
            assert_eq!(render(source, 4096).unwrap(), expected, "{source}");
        }
    }

    fn render_unbounded(source: &str) -> String {
        let script = Parser::new(source).parse().unwrap();
        let mut printer = Printer::default();
        printer.make(Some(&script.commands[0]));
        printer.print_deferred_if_any("");
        printer.out.into_string()
    }

    #[test]
    fn bounded_labels_match_unbounded_printer() {
        for source in [
            "A='a b' echo 'x y' > out 2>&1",
            "echo hi <<'EOF'\nbody\nEOF",
            "for x in 'a b' c; do echo $x; done",
            "case a in a) echo yes;; b) echo no;;& esac",
            "if true; then echo yes; else echo no; fi",
            "echo $(printf '%s' nested) <(printf '%s' process)",
        ] {
            assert_eq!(
                render(source, 4096).unwrap(),
                render_unbounded(source),
                "{source}"
            );
        }
    }

    #[test]
    fn job_labels_keep_bash_multiline_compound_layout() {
        for (source, expected) in [
            (
                "if true; then echo yes; else false; fi",
                "if true; then\n    echo yes;\nelse\n    false;\nfi",
            ),
            (
                "for x in a b; do echo $x; done",
                "for x in a b;\ndo\n    echo $x;\ndone",
            ),
            ("while false; do :; done", "while false; do\n    :;\ndone"),
            (
                "case a in a) :;; esac",
                "case a in \n    a)\n        :\n    ;;\nesac",
            ),
            (
                "for ((x=0; x<2; x++)); do :; done",
                "for ((x=0; x<2; x++))\ndo\n    :;\ndone",
            ),
        ] {
            assert_eq!(render(source, 4096).unwrap(), expected, "{source}");
        }
    }

    #[test]
    fn job_labels_support_every_command_family_and_have_an_output_ceiling() {
        for source in [
            "if true; then echo yes; else false; fi",
            "for x in a b; do echo \"$x\"; done",
            "for ((x=0; x<2; x++)); do :; done",
            "while false; do :; done",
            "until true; do :; done",
            "select x in a b; do :; done",
            "coproc worker { echo yes; }",
            "case a in a) :;; esac",
            "[[ a == a ]]",
            "((1+2))",
            "time true",
            "f() { echo 'quoted words'; }",
            "echo $(echo nested)",
            "cat <(echo nested)",
        ] {
            let rendered = render(source, 4096).unwrap();
            assert!(Parser::new(&rendered).parse().is_ok(), "{source}: {rendered}");
            assert!(render(source, 1).is_err(), "{source}");
        }
    }
}
