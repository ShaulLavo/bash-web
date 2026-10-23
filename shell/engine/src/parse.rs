//! Original internal context adapters over the unchanged shell parser.
//!
//! Entry points encode today's grammar/options and resource policy, not new
//! capabilities. No shell options or capability filters are added here: readers
//! stay lenient at top level and strict in substitution bodies. Expansion callers
//! still admit work/storage and choose when lazy text becomes active; this layer
//! neither pre-parses inactive operands nor translates expansion errors.
use shell_parser::{
    Parser,
    limits::{ExecutionBudget, ExecutionLimits},
    parser::{Command, Lexer, ParseOptions, SpannedToken, Word, WordPart},
};

// Scalar operands are reparsed inside nested expansion futures, unlike scripts
// and generated words. Keep their lower stack cap and admitted token fuel.
pub(crate) const OPERAND_DEPTH: usize = 16;
pub(crate) const OPERAND_TOKEN_BYTES: usize = 4096;

/// A new script input. The caller owns the source and fresh interruptible budget.
pub(crate) fn script(
    source: &str,
    source_bytes: usize,
    budget: &ExecutionBudget,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
    reader(source, source_bytes, budget)
}

/// Joined eval arguments, admitted and retained by the eval reader. Keep this
/// distinct from script entry even though their grammar is currently identical.
pub(crate) fn eval(
    source: &str,
    source_bytes: usize,
    budget: &ExecutionBudget,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
    reader(source, source_bytes, budget)
}

/// Where parsing stopped. Bash reads and runs a script one complete line at
/// a time, so the commands on earlier lines still run first.
pub(crate) enum ParseFailure {
    /// A command substitution body that does not parse (status 127).
    Word(usize),
    /// Any other syntax error (status 2).
    Syntax { message: String, line: usize },
}

pub(crate) struct ParsedScript {
    pub(crate) commands: Vec<Command>,
    pub(crate) command_end_lines: Vec<usize>,
}

/// Parse shell source the way the script reader and `eval` do. Resource
/// limits are errors; a syntax error keeps the complete lines before it.
fn reader(
    source: &str,
    source_bytes: usize,
    budget: &shell_parser::limits::ExecutionBudget,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
    if source.len() > source_bytes {
        return Err("shell source limit exceeded".into());
    }
    let parser_limits = shell_parser::limits::ExecutionLimits {
        max_input_bytes: source_bytes,
        ..Default::default()
    };
    let (script, error) = Parser::with_limits_and_timeout(
        source,
        parser_limits.max_ast_depth,
        parser_limits.max_parser_operations,
        Some(parser_limits.parser_timeout),
    )
    .with_execution_budget(budget.clone())
    // The whole script is parsed before aliases it defines exist, so the
    // top level stays lenient; substitution bodies get bash's grammar.
    .with_strict_substitution_bodies()
    .parse_recovering();
    budget.check().map_err(|error| error.to_string())?;
    let failure = match error {
        None => None,
        Some(shell_parser::Error::ShellWord { line }) => Some(ParseFailure::Word(line)),
        Some(shell_parser::Error::Parse { message, line, .. }) => {
            Some(ParseFailure::Syntax { message, line })
        }
        Some(error) => return Err(error.to_string()),
    };
    Ok((
        ParsedScript {
            commands: script.commands,
            command_end_lines: script.command_end_lines,
        },
        failure,
    ))
}

/// One already-admitted brace variant: word context, not command grammar.
/// Its depth cap must not inherit the smaller lazy-operand evaluation cap.
pub(crate) fn generated_word(source: &str) -> shell_parser::Result<Word> {
    expanded_token(source, Parser::parse_expanded_word_with_limits)
}

pub(crate) fn scalar_word(source: &str, subscript: bool) -> shell_parser::Result<Word> {
    if subscript {
        return expanded_token(source, Parser::parse_subscript_with_limits);
    }
    generated_word(source)
}

fn expanded_token<T>(
    source: &str,
    parse: impl FnOnce(&str, usize, usize) -> shell_parser::Result<T>,
) -> shell_parser::Result<T> {
    parse(
        source,
        ExecutionLimits::default().max_ast_depth,
        source.len().saturating_add(3).saturating_mul(16),
    )
}

/// An active, boundary-scanned ${...} token. Quote/pattern context belongs to
/// the operand scanner; nested operands remain raw and lazy in the parser AST.
pub(crate) fn lazy_parameter(
    token: &str,
    outer_quoted: bool,
    pattern: bool,
) -> shell_parser::Result<WordPart> {
    Parser::parse_parameter_token_with_limits(
        token,
        OPERAND_DEPTH,
        OPERAND_TOKEN_BYTES * 16,
        outer_quoted,
        pattern,
    )
}

/// An active basic variable token. Preserve the parser's infallible word API;
/// the caller still checks that the word contains exactly one supported part.
pub(crate) fn lazy_variable(token: &str) -> Word {
    Parser::parse_word_string_with_limits(token, OPERAND_DEPTH, OPERAND_TOKEN_BYTES * 16)
}

// Keep synchronous parser frames out of recursive expansion futures. Callers
// retain their admission, checkpoint ordering and context-specific error mapping.
#[inline(never)]
pub(crate) fn substitution_token(token: &str) -> shell_parser::Result<WordPart> {
    expanded_token(token, Parser::parse_substitution_token_with_limits)
}

/// Backslashes have already been processed. Syntax failures remain unparsed
/// substitutions for the child to report, rather than immediate reader errors.
#[inline(never)]
pub(crate) fn backtick_body(body: &str) -> shell_parser::Result<WordPart> {
    expanded_token(body, Parser::parse_backtick_body_with_limits)
}

/// Validate an admitted lazy command body without executing it. This is the
/// existing substitution grammar (default options, no new capability policy).
#[inline(never)]
pub(crate) fn substitution_grammar(source: &str) -> shell_parser::Result<()> {
    Parser::with_limits_and_options(source, OPERAND_DEPTH, 4096 * 16, ParseOptions::default())
        .with_substitution_body()
        .parse()
        .map(|_| ())
}

/// Re-lex only the caller's bounded declaration-command span, preserving raw
/// spelling and token order. The caller still checkpoints after each token and
/// decides which assignments, redirects and AST words consume that spelling.
pub(crate) fn declaration_tokens(source: &str) -> impl Iterator<Item = SpannedToken> + '_ {
    let mut lexer = Lexer::new(source);
    lexer.set_capture_raw(true);
    std::iter::from_fn(move || lexer.next_spanned_token())
}

#[cfg(test)]
mod tests;

pub(crate) fn array_element(word: &Word) -> Option<(&str, &str, bool)> {
    let raw = word.raw.as_deref()?.strip_prefix('[')?;
    let mut quote = None;
    let mut escaped = false;
    let mut depth = 0usize;
    for (offset, ch) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if quote == Some(ch) {
            quote = None;
            continue;
        }
        if quote.is_some() {
            continue;
        }
        if matches!(ch, '\'' | '"') {
            quote = Some(ch);
            continue;
        }
        if ch == '[' {
            depth += 1;
            continue;
        }
        if ch != ']' {
            continue;
        }
        if depth != 0 {
            depth -= 1;
            continue;
        }
        let suffix = &raw[offset + 1..];
        if let Some(value) = suffix.strip_prefix("+=") {
            return Some((&raw[..offset], value, true));
        }
        return suffix
            .strip_prefix('=')
            .map(|value| (&raw[..offset], value, false));
    }
    None
}
