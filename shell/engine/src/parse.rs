//! Internal context adapters over the shell parser.
//!
//! Entry points encode today's grammar/options and resource policy, not new
//! capabilities. Callers supply lexical options without exposing shell state: readers
//! stay lenient at top level and strict in substitution bodies. Expansion callers
//! still admit work/storage and choose when lazy text becomes active; this layer
//! neither pre-parses inactive operands nor translates expansion errors.
use shell_parser::{
    Parser,
    limits::{ExecutionBudget, ExecutionLimits},
    parser::{Command, Lexer, ParseOptions, Position, SpannedToken, Word, WordPart},
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
    options: ParseOptions,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
    reader(source, source_bytes, budget, options, Position::new())
}

/// Joined eval arguments use the script reader's grammar and lexical options.
pub(crate) use script as eval;

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
    pub(crate) command_starts: Vec<(usize, usize)>,
}

/// Parse shell source the way the script reader and `eval` do. Resource
/// limits are errors; a syntax error keeps the complete lines before it.
pub(crate) fn reader(
    source: &str,
    source_bytes: usize,
    budget: &shell_parser::limits::ExecutionBudget,
    options: ParseOptions,
    position: Position,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
    let (script, error) =
        parser(source, source_bytes, budget, options, position)?.parse_recovering();
    recovered(script, error, budget)
}

/// Re-read only the next complete read unit with the current alias table.
/// AST offsets remain relative to the caller-owned original source.
pub(crate) fn read_unit(
    source: &str,
    source_bytes: usize,
    budget: &ExecutionBudget,
    options: ParseOptions,
    position: Position,
) -> Result<(ParsedScript, Option<ParseFailure>, Option<Position>), String> {
    let (script, error, next) =
        parser(source, source_bytes, budget, options, position)?.parse_read_unit_recovering();
    let (script, failure) = recovered(script, error, budget)?;
    Ok((script, failure, next))
}

fn parser<'a>(
    source: &'a str,
    source_bytes: usize,
    budget: &ExecutionBudget,
    options: ParseOptions,
    position: Position,
) -> Result<Parser<'a>, String> {
    if source.len() > source_bytes {
        return Err("shell source limit exceeded".into());
    }
    let limits = ExecutionLimits {
        max_input_bytes: source_bytes,
        ..Default::default()
    };
    Ok(Parser::at_position(
        source,
        limits.max_ast_depth,
        limits.max_parser_operations,
        Some(limits.parser_timeout),
        options,
        position,
    )
    .with_execution_budget(budget.clone())
    .with_strict_substitution_bodies())
}

fn recovered(
    script: shell_parser::parser::Script,
    error: Option<shell_parser::Error>,
    budget: &ExecutionBudget,
) -> Result<(ParsedScript, Option<ParseFailure>), String> {
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
            command_starts: script.command_starts,
        },
        failure,
    ))
}

/// One already-admitted brace variant: word context, not command grammar.
/// Its depth cap must not inherit the smaller lazy-operand evaluation cap.
pub(crate) fn generated_word(source: &str) -> shell_parser::Result<Word> {
    Parser::parse_expanded_word_with_limits(
        source,
        ExecutionLimits::default().max_ast_depth,
        source.len().saturating_add(3).saturating_mul(16),
    )
}

/// The malformed-header classifier used by the word parser, without an AST.
/// The operand caller has already bounded and charged the token scan.
pub(crate) fn bad_parameter_token(token: &str) -> bool {
    Parser::is_bad_parameter_token(token)
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
    Parser::parse_substitution_token_with_limits(
        token,
        ExecutionLimits::default().max_ast_depth,
        token.len().saturating_add(3).saturating_mul(16),
    )
}

/// Backslashes have already been processed. Syntax failures remain unparsed
/// substitutions for the child to report, rather than immediate reader errors.
#[inline(never)]
pub(crate) fn backtick_body(body: &str) -> shell_parser::Result<WordPart> {
    Parser::parse_backtick_body_with_limits(
        body,
        ExecutionLimits::default().max_ast_depth,
        body.len().saturating_add(3).saturating_mul(16),
    )
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
