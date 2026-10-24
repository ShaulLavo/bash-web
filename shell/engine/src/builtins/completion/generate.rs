use super::super::{error_status, scan_bytes, write};
use super::{
    options::{self, Arguments},
    wordlist,
};
use crate::{
    commands,
    exec::{Error, RESOURCE_STATUS},
    expand::{self, Work, pattern::Pattern},
    interpreter::{Context, Flow, Outcome},
    io::FdTable,
    state::{Binding, SharedState},
};
mod filesystem;

/// Each generator owns its sorting policy; -W preserves order and repetitions.
const GENERATION: &[&str] = &[
    "alias",
    "arrayvar",
    "binding",
    "builtin",
    "command",
    "disabled",
    "enabled",
    "export",
    "function",
    "group",
    "helptopic",
    "hostname",
    "job",
    "keyword",
    "running",
    "service",
    "setopt",
    "shopt",
    "signal",
    "stopped",
    "user",
    "variable",
    "directory",
    "file",
];
pub(super) struct Candidates {
    values: Vec<String>,
    bytes: usize,
    limits: (usize, usize),
}
impl Candidates {
    fn new(context: &Context) -> Self {
        Self {
            values: Vec::new(),
            bytes: 0,
            limits: (context.limits().expansion_bytes, context.limits().arguments),
        }
    }
    fn add(&mut self, value: &str, prefix: &str, work: &mut Work) -> Result<(), i32> {
        if !value.starts_with(prefix) {
            return Ok(());
        }
        if value.len() > self.limits.0.saturating_sub(self.bytes)
            || self.values.len() >= self.limits.1
        {
            return Err(RESOURCE_STATUS);
        }
        if self.values.len() == self.values.capacity() {
            let growth = self.values.capacity().max(1);
            work.admit_storage(growth.saturating_mul(std::mem::size_of::<String>()))
                .map_err(error_status)?;
            let requested = self.values.capacity() + growth;
            self.values
                .try_reserve_exact(growth)
                .map_err(|_| RESOURCE_STATUS)?;
            work.admit_storage(
                (self.values.capacity() - requested) * std::mem::size_of::<String>(),
            )
            .map_err(error_status)?;
        }
        work.admit_storage(value.len()).map_err(error_status)?;
        self.values.push(value.to_owned());
        self.bytes += value.len();
        Ok(())
    }
    async fn sort(&mut self, context: &Context, work: &mut Work) -> Result<(), i32> {
        expand::sort_candidates(&mut self.values, work, &context.cancel)
            .await
            .map_err(error_status)
    }
}
pub(super) async fn run(
    args: &Arguments<'_>,
    state: &SharedState,
    fds: &FdTable,
    context: &Context,
    work: &mut Work,
) -> Result<Outcome, i32> {
    if !args.supplied {
        return Ok(Outcome::status(0));
    }
    let mut candidates = Candidates::new(context);
    let prefix = args.operands.first().map_or("", String::as_str);
    for action in GENERATION {
        if !options::has(args.spec, action) {
            continue;
        }
        action_candidates(action, prefix, state, &mut candidates, context, work).await?;
    }
    if let Some(glob) = args.spec.text[0] {
        let paths =
            expand::completion_matches(glob, state, candidates.limits, work, &context.cancel)
                .await
                .map_err(error_status)?;
        for path in paths {
            candidates.add(&path, "", work)?;
        }
    }
    if let Some(words) = args.spec.text[1] {
        let result = wordlist::expand(words, state, candidates.limits, work, &context.cancel).await;
        let words = match result {
            Ok(words) => words,
            Err(Error::Unbound { .. }) => {
                return Ok(Outcome {
                    code: 127,
                    flow: Flow::Abort,
                });
            }
            Err(Error::Status(code @ (130 | RESOURCE_STATUS))) => return Err(code),
            Err(_) => return Err(1),
        };
        for word in words {
            candidates.add(&word, prefix, work)?;
        }
    }
    // -F/-C are retained by complete, but need a separate interpreter invocation contract.
    if args.spec.text[5].is_some() || args.spec.text[6].is_some() {
        return Err(2);
    }
    filter(
        &mut candidates,
        args.spec.text[4],
        prefix,
        state,
        context,
        work,
    )
    .await?;
    let primary_count = candidates.values.len();
    let plusdirs = options::option(args.spec, "plusdirs");
    if plusdirs || candidates.values.is_empty() && options::option(args.spec, "dirnames") {
        filesystem::paths(
            prefix,
            filesystem::Mode::Directories,
            state,
            &mut candidates,
            context,
            work,
        )
        .await?;
    }
    if candidates.values.is_empty() && options::option(args.spec, "default") {
        filesystem::paths(
            prefix,
            filesystem::Mode::Files,
            state,
            &mut candidates,
            context,
            work,
        )
        .await?;
    }
    let status = i32::from(candidates.values.is_empty());
    for (index, value) in candidates.values.into_iter().enumerate() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if index < primary_count {
            write(
                fds,
                args.spec.text[2].unwrap_or_default().as_bytes(),
                context,
            )
            .await?;
        }
        write(fds, value.as_bytes(), context).await?;
        if index < primary_count {
            write(
                fds,
                args.spec.text[3].unwrap_or_default().as_bytes(),
                context,
            )
            .await?;
        }
        write(fds, b"\n", context).await?;
    }
    Ok(Outcome::status(status))
}
async fn action_candidates(
    action: &str,
    prefix: &str,
    state: &SharedState,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let mut generated = Candidates::new(context);
    match action {
        "function" | "variable" | "export" | "arrayvar" => {
            names(action, prefix, state, &mut generated, context, work).await?
        }
        "builtin" | "enabled" | "keyword" | "helptopic" => {
            catalogue(action, prefix, &mut generated, context, work).await?
        }
        "command" => {
            catalogue("keyword", prefix, output, context, work).await?;
            names("function", prefix, state, &mut generated, context, work).await?;
            generated.sort(context, work).await?;
            for value in generated.values {
                output.add(&value, "", work)?;
            }
            catalogue("builtin", prefix, output, context, work).await?;
            return filesystem::commands(prefix, state, output, context, work).await;
        }
        "file" => {
            return filesystem::paths(
                prefix,
                filesystem::Mode::Files,
                state,
                output,
                context,
                work,
            )
            .await;
        }
        "directory" => {
            return filesystem::paths(
                prefix,
                filesystem::Mode::Directories,
                state,
                output,
                context,
                work,
            )
            .await;
        }
        "user" | "group" | "hostname" | "service" => {
            return filesystem::database(action, prefix, state, output, context, work).await;
        }
        "shopt" => {
            for name in super::super::SHOPT_OPTIONS {
                generated.add(name, prefix, work)?;
            }
        }
        "setopt" => {
            for name in ["errexit", "monitor", "noglob", "nounset", "pipefail"] {
                generated.add(name, prefix, work)?;
            }
        }
        "signal" => {
            for name in super::super::trap::NAMES {
                let value = match name {
                    "32" => "SIGJUNK(32)",
                    "33" => "SIGJUNK(33)",
                    name => name,
                };
                generated.add(value, prefix, work)?;
            }
        }
        "alias" | "disabled" => {}
        _ => return Err(2),
    }
    if !matches!(action, "keyword" | "signal" | "setopt" | "shopt") {
        generated.sort(context, work).await?;
    }
    for value in generated.values {
        output.add(&value, "", work)?;
    }
    Ok(())
}
async fn catalogue(
    action: &str,
    prefix: &str,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let mut generated = Candidates::new(context);
    for command in commands::catalogue() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        let selected = match action {
            "keyword" => command.query_keyword(),
            "helptopic" => command.query_builtin() || command.query_keyword(),
            _ => command.query_builtin(),
        };
        if selected {
            generated.add(command.name, prefix, work)?;
        }
    }
    if action != "keyword" {
        generated.sort(context, work).await?;
    }
    for value in generated.values {
        output.add(&value, "", work)?;
    }
    Ok(())
}
async fn names(
    action: &str,
    prefix: &str,
    state: &SharedState,
    output: &mut Candidates,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    // Admission and the scan happen before copying any binding-name storage.
    let bytes = {
        let state = state.borrow();
        if action == "function" {
            state.functions().keys().map(String::len).sum()
        } else {
            state.raw_bindings().keys().map(String::len).sum()
        }
    };
    scan_bytes(bytes, context, work).await?;
    let state = state.borrow();
    if action == "function" {
        for name in state.functions().keys() {
            output.add(name, prefix, work)?;
        }
        return Ok(());
    }
    for (name, binding) in state.raw_bindings() {
        let selected = match action {
            "export" => state.exported_bindings().contains(name),
            "arrayvar" => matches!(binding, Binding::Indexed(_)),
            _ => true,
        };
        if selected {
            output.add(name, prefix, work)?;
        }
    }
    Ok(())
}
async fn filter(
    output: &mut Candidates,
    filter: Option<&str>,
    prefix: &str,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<(), i32> {
    let Some(filter) = filter else {
        return Ok(());
    };
    let inverse = filter.starts_with('!');
    let filter = if inverse { &filter[1..] } else { filter };
    let text = filter_pattern(filter, prefix, context, work).await?;
    let mut pattern = Pattern::literal(&text, state, work, &context.cancel)
        .await
        .map_err(error_status)?;
    let mut kept = 0;
    for index in 0..output.values.len() {
        let storage = work.storage_left();
        let matched = pattern
            .matches_full(&output.values[index], work, &context.cancel)
            .await
            .map_err(error_status)?;
        let released = storage.saturating_sub(work.storage_left());
        work.release_storage(released);
        if matched == inverse {
            output.values.swap(kept, index);
            kept += 1;
        }
    }
    output.values.truncate(kept);
    Ok(())
}
async fn filter_pattern(
    filter: &str,
    prefix: &str,
    context: &Context,
    work: &mut Work,
) -> Result<String, i32> {
    let count = filter.bytes().filter(|byte| *byte == b'&').count();
    let bytes = filter
        .len()
        .checked_add(count.checked_mul(prefix.len()).ok_or(RESOURCE_STATUS)?)
        .ok_or(RESOURCE_STATUS)?;
    if bytes > context.limits().expansion_bytes {
        return Err(RESOURCE_STATUS);
    }
    work.admit_storage(bytes).map_err(error_status)?;
    let mut text = String::with_capacity(bytes);
    let mut chars = filter.chars();
    while let Some(ch) = chars.next() {
        work.checkpoint(&context.cancel)
            .await
            .map_err(error_status)?;
        if ch == '\\' {
            text.push(ch);
            text.extend(chars.next());
            continue;
        }
        if ch == '&' {
            text.push_str(prefix);
        } else {
            text.push(ch);
        }
    }
    Ok(text)
}
