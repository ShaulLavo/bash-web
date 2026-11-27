//! Scalar arithmetic adapted from Bashkit arithmetic.rs at 491c3281f668b76d64b15210b8f5d7bf97244be0.
//! The grammar, wrapping integer rules and operator semantics are upstream-derived.
//! Streaming lexing, async work admission and immediate durable scalar writes are
//! original adapters: no interpreter overlay, token vector, or blocking evaluator.
use crate::{
    exec::{ResultFuture, fault},
    executor::Cancel,
    expand::{self, Error, Work},
    state::{Place, Reference, SharedState, State},
};
use futures::{
    FutureExt,
    future::{Either, ready},
};
use std::future::Future;
use std::rc::Rc;

// Admit the exact future frame before boxing it. A rejected admission returns
// an inline ready future, so even failure does not allocate an error frame.
pub(crate) fn admitted<'a, T: 'a, F: Future<Output = Result<T, Error>> + 'a>(
    work: &'a mut Work,
    build: impl FnOnce(&'a mut Work) -> F,
) -> ResultFuture<'a, T> {
    if let Err(error) = work.admit_storage(std::mem::size_of::<F>()) {
        return Either::Left(ready(Err(error)));
    }
    Either::Right(build(work).boxed_local())
}

const MAX_DEPTH: usize = 64;

fn match_operator(bytes: &[u8]) -> Option<&'static str> {
    let first = *bytes.first()?;
    let second = bytes.get(1).copied();
    let third = bytes.get(2).copied();
    Some(match first {
        b'<' => match (second, third) {
            (Some(b'<'), Some(b'=')) => "<<=",
            (Some(b'<'), _) => "<<",
            (Some(b'='), _) => "<=",
            _ => "<",
        },
        b'>' => match (second, third) {
            (Some(b'>'), Some(b'=')) => ">>=",
            (Some(b'>'), _) => ">>",
            (Some(b'='), _) => ">=",
            _ => ">",
        },
        b'*' => match second {
            Some(b'*') => "**",
            Some(b'=') => "*=",
            _ => "*",
        },
        b'+' => match second {
            Some(b'+') => "++",
            Some(b'=') => "+=",
            _ => "+",
        },
        b'-' => match second {
            Some(b'-') => "--",
            Some(b'=') => "-=",
            _ => "-",
        },
        b'=' => {
            if second == Some(b'=') {
                "=="
            } else {
                "="
            }
        }
        b'!' => {
            if second == Some(b'=') {
                "!="
            } else {
                "!"
            }
        }
        b'&' => match second {
            Some(b'&') => "&&",
            Some(b'=') => "&=",
            _ => "&",
        },
        b'|' => match second {
            Some(b'|') => "||",
            Some(b'=') => "|=",
            _ => "|",
        },
        b'/' => {
            if second == Some(b'=') {
                "/="
            } else {
                "/"
            }
        }
        b'%' => {
            if second == Some(b'=') {
                "%="
            } else {
                "%"
            }
        }
        b'^' => {
            if second == Some(b'=') {
                "^="
            } else {
                "^"
            }
        }
        b'~' => "~",
        b'?' => "?",
        b':' => ":",
        b',' => ",",
        _ => return None,
    })
}

fn plain_decimal(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut start = 0;
    while start < bytes.len() && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    let mut end = bytes.len();
    while end > start && bytes[end - 1].is_ascii_whitespace() {
        end -= 1;
    }
    let slice = &bytes[start..end];
    if slice.is_empty() {
        return Some(0);
    }
    let (neg, digits) = match slice[0] {
        b'-' => (true, &slice[1..]),
        b'+' => (false, &slice[1..]),
        _ => (false, slice),
    };
    if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
        return None;
    }
    let mut value = 0i64;
    for &byte in digits {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.wrapping_mul(10).wrapping_add(i64::from(byte - b'0'));
    }
    Some(if neg { value.wrapping_neg() } else { value })
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Token<'a> {
    Number(&'a str),
    Ident(&'a str),
    Op(&'static str),
    Open,
    Close,
    Invalid,
    Unsupported,
    End,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CachedToken {
    Number(usize, usize),
    Ident(usize, usize),
    Op(&'static str),
    Open,
    Close,
    Invalid,
    Unsupported,
    End,
}

struct Parser<'a> {
    source: &'a str,
    cursor: usize,
    current: Token<'a>,
    next: Token<'a>,
    cached: Option<Rc<[CachedToken]>>,
    cached_index: usize,
}
impl<'a> Parser<'a> {
    async fn new(source: &'a str, work: &mut Work, cancel: &Cancel) -> Result<Self, Error> {
        let mut parser = Self {
            source,
            cursor: 0,
            current: Token::End,
            next: Token::End,
            cached: None,
            cached_index: 0,
        };
        parser.current = parser.lex(work, cancel).await?;
        parser.next = parser.lex(work, cancel).await?;
        Ok(parser)
    }
    async fn lex(&mut self, work: &mut Work, cancel: &Cancel) -> Result<Token<'a>, Error> {
        let bytes = self.source.as_bytes();
        let mut ws_steps = 0usize;
        while self.cursor < bytes.len() {
            ws_steps += 1;
            if bytes[self.cursor].is_ascii_whitespace() {
                self.cursor += 1;
            } else if bytes[self.cursor..].starts_with(b"\\\n") {
                self.cursor += 2;
            } else {
                break;
            }
        }
        if ws_steps != 0 {
            work.checkpoint_steps(ws_steps, cancel).await?;
        }
        let start = self.cursor;
        let Some(&ch) = bytes.get(start) else {
            return Ok(Token::End);
        };
        if ch.is_ascii_alphanumeric() || ch == b'_' {
            let number = ch.is_ascii_digit();
            self.cursor += 1;
            let mut steps = 0usize;
            while let Some(&ch) = bytes.get(self.cursor) {
                steps += 1;
                if !(ch.is_ascii_alphanumeric()
                    || ch == b'_'
                    || number && matches!(ch, b'#' | b'@'))
                {
                    break;
                }
                self.cursor += 1;
            }
            if steps != 0 {
                work.checkpoint_steps(steps, cancel).await?;
            }
            if !number && bytes.get(self.cursor) == Some(&b'[') {
                let end = Reference::end(self.source, self.cursor).ok_or(2)?;
                work.checkpoint_steps(end - self.cursor, cancel).await?;
                self.cursor = end;
            }
            let text = &self.source[start..self.cursor];
            return Ok(if number {
                Token::Number(text)
            } else {
                Token::Ident(text)
            });
        }
        if !ch.is_ascii() {
            self.cursor += self.source[start..].chars().next().ok_or(2)?.len_utf8();
            return Ok(Token::Invalid);
        }
        self.cursor += 1;
        match ch {
            b'(' => Ok(Token::Open),
            b')' => Ok(Token::Close),
            b'[' | b']' | b'`' => Ok(Token::Unsupported),
            _ => match match_operator(&bytes[start..]) {
                Some(op) => {
                    self.cursor = start + op.len();
                    Ok(Token::Op(op))
                }
                None => Ok(Token::Invalid),
            },
        }
    }
    fn resolve(source: &'a str, token: CachedToken) -> Token<'a> {
        match token {
            CachedToken::Number(start, end) => Token::Number(&source[start..end]),
            CachedToken::Ident(start, end) => Token::Ident(&source[start..end]),
            CachedToken::Op(op) => Token::Op(op),
            CachedToken::Open => Token::Open,
            CachedToken::Close => Token::Close,
            CachedToken::Invalid => Token::Invalid,
            CachedToken::Unsupported => Token::Unsupported,
            CachedToken::End => Token::End,
        }
    }
    async fn advance(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        if let Some(tokens) = &self.cached {
            self.current = self.next;
            self.cached_index = self.cached_index.saturating_add(1);
            self.next = tokens
                .get(self.cached_index.saturating_add(1))
                .copied()
                .map_or(Token::End, |token| Self::resolve(self.source, token));
            return Ok(());
        }
        self.current = self.next;
        self.next = self.lex(work, cancel).await?;
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Program {
    tokens: Rc<[CachedToken]>,
}

impl Program {
    pub(crate) fn is_static(source: &str) -> bool {
        !source.contains(['$', '"', '\\', '`'])
    }

    pub(crate) fn retained_bytes(source: &str) -> usize {
        source
            .len()
            .saturating_add(1)
            .saturating_mul(std::mem::size_of::<CachedToken>())
            .saturating_add(std::mem::size_of::<Self>())
    }

    pub(crate) fn exact_bytes(&self) -> usize {
        self.tokens
            .len()
            .saturating_mul(std::mem::size_of::<CachedToken>())
            .saturating_add(2 * std::mem::size_of::<usize>())
            .saturating_add(std::mem::size_of::<Self>())
    }

    pub(crate) async fn compile(
        source: &str,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Self, Error> {
        let mut lexer = Parser {
            source,
            cursor: 0,
            current: Token::End,
            next: Token::End,
            cached: None,
            cached_index: 0,
        };
        let base = source.as_ptr() as usize;
        let mut tokens = Vec::new();
        loop {
            let token = lexer.lex(work, cancel).await?;
            let cached = match token {
                Token::Number(slice) => {
                    let start = slice.as_ptr() as usize - base;
                    CachedToken::Number(start, start + slice.len())
                }
                Token::Ident(slice) => {
                    let start = slice.as_ptr() as usize - base;
                    CachedToken::Ident(start, start + slice.len())
                }
                Token::Op(op) => CachedToken::Op(op),
                Token::Open => CachedToken::Open,
                Token::Close => CachedToken::Close,
                Token::Invalid => CachedToken::Invalid,
                Token::Unsupported => CachedToken::Unsupported,
                Token::End => CachedToken::End,
            };
            tokens.push(cached);
            if token == Token::End {
                break;
            }
        }
        Ok(Self {
            tokens: Rc::from(tokens),
        })
    }

    fn parser<'a>(&self, source: &'a str) -> Parser<'a> {
        let current = self
            .tokens
            .first()
            .copied()
            .map_or(Token::End, |token| Parser::resolve(source, token));
        let next = self
            .tokens
            .get(1)
            .copied()
            .map_or(Token::End, |token| Parser::resolve(source, token));
        Parser {
            source,
            cursor: 0,
            current,
            next,
            cached: Some(self.tokens.clone()),
            cached_index: 0,
        }
    }
}

fn evaluate_inner<'a>(
    source: &'a str,
    program: Option<&'a Program>,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
) -> ResultFuture<'a, i64> {
    admitted(work, move |work| async move {
        work.enter_arithmetic()?;
        let result = async {
            work.checkpoint(cancel).await?;
            if source.len() > max {
                return Err(2.into());
            }
            if let Some(program) = program {
                let mut parser = program.parser(source);
                return finish_parse(&mut parser, state, cancel, max, work, 1).await;
            }
            let expanded;
            let source = if source.contains(['$', '"', '\\', '`']) {
                expanded = expand::scalar_text(
                    expand::ScalarSyntax::Arithmetic,
                    source,
                    state,
                    cancel,
                    max,
                    work,
                )
                .await?;
                expanded.as_str()
            } else {
                source
            };
            expression_body(source, state, cancel, max, work, 0).await
        }
        .await;
        work.leave_arithmetic();
        result
    })
}

pub(crate) fn evaluate<'a>(
    source: &'a str,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
) -> ResultFuture<'a, i64> {
    evaluate_inner(source, None, state, cancel, max, work)
}

async fn finish_parse(
    parser: &mut Parser<'_>,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
    depth: usize,
) -> Result<i64, Error> {
    if parser.current == Token::End {
        return Ok(0);
    }
    let result = parse_body(parser, (0, true), state, cancel, max, work, depth).await?;
    if parser.current == Token::Unsupported {
        return Err(2.into());
    }
    if parser.current != Token::End {
        return fault("syntax error in expression", work);
    }
    Ok(result)
}

pub(crate) fn evaluate_program<'a>(
    source: &'a str,
    program: &'a Program,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
) -> ResultFuture<'a, i64> {
    evaluate_inner(source, Some(program), state, cancel, max, work)
}

/// let arguments have already undergone shell expansion as ordinary words.
/// Re-expanding their literal dollar or quote text would execute it twice.
pub(crate) async fn evaluate_literal(
    source: &str,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<i64, Error> {
    expression(source, state, cancel, max, work, 0).await
}

async fn expression_body(
    source: &str,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
    depth: usize,
) -> Result<i64, Error> {
    if depth >= MAX_DEPTH {
        return Err(2.into());
    }
    if source.len() > max {
        return Err(2.into());
    }
    let mut parser = Parser::new(source, work, cancel).await?;
    finish_parse(&mut parser, state, cancel, max, work, depth + 1).await
}

fn expression<'a>(
    source: &'a str,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
    depth: usize,
) -> ResultFuture<'a, i64> {
    admitted(work, move |work| {
        expression_body(source, state, cancel, max, work, depth)
    })
}

fn assignment(op: &str) -> bool {
    matches!(
        op,
        "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "^=" | "|="
    )
}
fn precedence(op: &str) -> Option<u8> {
    Some(match op {
        "," => 0,
        "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "^=" | "|=" => 1,
        "?" => 2,
        "||" => 3,
        "&&" => 4,
        "|" => 5,
        "^" => 6,
        "&" => 7,
        "==" | "!=" => 8,
        "<" | ">" | "<=" | ">=" => 9,
        "<<" | ">>" => 10,
        "+" | "-" | "++" | "--" => 11,
        "*" | "/" | "%" => 12,
        "**" => 13,
        _ => return None,
    })
}

fn parse<'a, 's: 'a>(
    p: &'a mut Parser<'s>,
    mode: (u8, bool),
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
    depth: usize,
) -> ResultFuture<'a, i64> {
    admitted(work, move |work| {
        parse_body(p, mode, state, cancel, max, work, depth)
    })
}

async fn leaf_operand(
    p: &mut Parser<'_>,
    active: bool,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
    depth: usize,
) -> Result<Option<i64>, Error> {
    if depth >= MAX_DEPTH {
        return Err(2.into());
    }
    match p.current {
        Token::Number(text) => {
            work.checkpoint(cancel).await?;
            let value = number(text, work, cancel).await?;
            p.advance(work, cancel).await?;
            Ok(Some(value))
        }
        Token::Ident(name) => {
            work.checkpoint(cancel).await?;
            p.advance(work, cancel).await?;
            let place = place(name, active, state, cancel, max, work).await?;
            let value = read_place(place.as_ref(), state, cancel, max, work, depth + 1).await?;
            if let Token::Op(op @ ("++" | "--")) = p.current {
                p.advance(work, cancel).await?;
                let next = if op == "++" {
                    value.wrapping_add(1)
                } else {
                    value.wrapping_sub(1)
                };
                store_place(place.as_ref(), next, state, cancel, max, work).await?;
            }
            Ok(Some(value))
        }
        _ => Ok(None),
    }
}

async fn parse_body(
    p: &mut Parser<'_>,
    mode: (u8, bool),
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
    depth: usize,
) -> Result<i64, Error> {
    let (min, active) = mode;
    if depth >= MAX_DEPTH {
        return Err(2.into());
    }
    work.checkpoint(cancel).await?;
    // Capture compound-assignment's old value before the RHS mutates it.
    // Plain '=' never recursively evaluates its unused old value.
    let mut value = if min <= 1
        && let (Token::Ident(name), Token::Op(op)) = (p.current, p.next)
        && assignment(op)
    {
        p.advance(work, cancel).await?;
        p.advance(work, cancel).await?;
        let place = place(name, active, state, cancel, max, work).await?;
        let old = if op == "=" {
            0
        } else {
            read_place(place.as_ref(), state, cancel, max, work, depth + 1).await?
        };
        let rhs = parse(p, (1, active), state, cancel, max, work, depth + 1).await?;
        let result = if op == "=" {
            rhs
        } else {
            binary(&op[..op.len() - 1], old, rhs, active, work)?
        };
        store_place(place.as_ref(), result, state, cancel, max, work).await?;
        result
    } else if let Some(leaf) = leaf_operand(p, active, state, cancel, max, work, depth + 1).await? {
        leaf
    } else {
        unary(p, active, state, cancel, max, work, depth + 1).await?
    };
    loop {
        work.checkpoint(cancel).await?;
        let Token::Op(mut op) = p.current else {
            break;
        };
        let Some(prec) = precedence(op) else {
            break;
        };
        if prec < min {
            break;
        }
        if assignment(op) {
            return fault("attempted assignment to non-variable", work);
        }
        if op == "?" {
            p.advance(work, cancel).await?;
            let yes = parse(
                p,
                (0, active && value != 0),
                state,
                cancel,
                max,
                work,
                depth + 1,
            )
            .await?;
            if p.current != Token::Op(":") {
                return fault("`:' expected for conditional expression", work);
            }
            p.advance(work, cancel).await?;
            let no = parse(
                p,
                (2, active && value == 0),
                state,
                cancel,
                max,
                work,
                depth + 1,
            )
            .await?;
            value = if value != 0 { yes } else { no };
            continue;
        }
        // On a non-lvalue, 5++1 and 5--1 mean binary sign + unary sign.
        if matches!(op, "++" | "--") {
            op = if op == "++" { "+" } else { "-" };
            p.current = Token::Op(op);
        } else {
            p.advance(work, cancel).await?;
        }
        let rhs_active = active && !(op == "&&" && value == 0 || op == "||" && value != 0);
        let next_min = if op == "**" { prec } else { prec + 1 };
        // Inline a single-token leaf RHS when no postfix or higher-precedence operator follows.
        let is_plain_leaf = matches!(p.current, Token::Number(_))
            || (matches!(p.current, Token::Ident(_)) && !matches!(p.next, Token::Op("++" | "--")));
        let rhs = if is_plain_leaf
            && !matches!(p.next, Token::Op(next_op) if precedence(next_op).is_some_and(|p| p >= next_min))
        {
            leaf_operand(p, rhs_active, state, cancel, max, work, depth + 2)
                .await?
                .expect("checked number or ident")
        } else {
            parse(
                p,
                (next_min, rhs_active),
                state,
                cancel,
                max,
                work,
                depth + 1,
            )
            .await?
        };
        value = binary(op, value, rhs, active, work)?;
    }
    Ok(value)
}

fn unary<'a, 's: 'a>(
    p: &'a mut Parser<'s>,
    active: bool,
    state: &'a SharedState,
    cancel: &'a Cancel,
    max: usize,
    work: &'a mut Work,
    depth: usize,
) -> ResultFuture<'a, i64> {
    admitted(work, move |work| async move {
        if depth >= MAX_DEPTH {
            return Err(2.into());
        }
        work.checkpoint(cancel).await?;
        if let Token::Op(op @ ("++" | "--")) = p.current {
            if let Token::Ident(name) = p.next {
                p.advance(work, cancel).await?;
                p.advance(work, cancel).await?;
                let place = place(name, active, state, cancel, max, work).await?;
                let old = read_place(place.as_ref(), state, cancel, max, work, depth + 1).await?;
                let value = if op == "++" {
                    old.wrapping_add(1)
                } else {
                    old.wrapping_sub(1)
                };
                store_place(place.as_ref(), value, state, cancel, max, work).await?;
                return Ok(value);
            }
            // Two unary signs when there is no identifier after the token.
            p.current = Token::Op(if op == "++" { "+" } else { "-" });
            let value = unary(p, active, state, cancel, max, work, depth + 1).await?;
            return Ok(if op == "--" {
                value.wrapping_neg()
            } else {
                value
            });
        }
        if let Token::Op(op @ ("+" | "-" | "!" | "~")) = p.current {
            p.advance(work, cancel).await?;
            let value = unary(p, active, state, cancel, max, work, depth + 1).await?;
            return Ok(match op {
                "-" => value.wrapping_neg(),
                "!" => i64::from(value == 0),
                "~" => !value,
                _ => value,
            });
        }
        if let Some(leaf) = leaf_operand(p, active, state, cancel, max, work, depth).await? {
            return Ok(leaf);
        }
        match p.current {
            Token::Open => {
                p.advance(work, cancel).await?;
                let value = parse(p, (0, active), state, cancel, max, work, depth + 1).await?;
                if p.current != Token::Close {
                    return fault("missing `)'", work);
                }
                p.advance(work, cancel).await?;
                Ok(value)
            }
            Token::Unsupported => Err(2.into()),
            _ => fault("syntax error: operand expected", work),
        }
    })
}

async fn place(
    name: &str,
    active: bool,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<Option<Place>, Error> {
    if !active {
        return Ok(None);
    }
    expand::references::select(expand::references::syntax(name)?, state, cancel, max, work)
        .await
        .map(Some)
}
async fn read_place(
    place: Option<&Place>,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
    depth: usize,
) -> Result<i64, Error> {
    let Some(place) = place else { return Ok(0) };
    let value = if place.index.is_none() && state.borrow().dynamic_parameter(&place.name) {
        work.admit_storage(State::DYNAMIC_PARAMETER_BYTES)?;
        state.borrow().parameter(&place.name).into_owned()
    } else {
        expand::references::read(place, state, cancel, max, work)
            .await?
            .unwrap_or_default()
    };
    if depth >= MAX_DEPTH || value.len() > max {
        return Err(2.into());
    }
    if depth + 3 < MAX_DEPTH
        && let Some(parsed) = plain_decimal(&value)
    {
        work.checkpoint_steps(value.len().max(1), cancel).await?;
        return Ok(parsed);
    }
    work.enter_scalar_arithmetic(&place.name, place.index.unwrap_or(0), cancel)
        .await?;
    let result = expression(&value, state, cancel, max, work, depth).await;
    work.leave_scalar_arithmetic();
    result
}
async fn store_place(
    place: Option<&Place>,
    value: i64,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<(), Error> {
    let Some(place) = place else { return Ok(()) };
    let digits = if value == 0 {
        1
    } else {
        value.unsigned_abs().ilog10() as usize + 1
    } + usize::from(value < 0);
    if place.name.len() > max || digits > max {
        return Err(2.into());
    }
    work.admit_storage(digits)?;
    let text = value.to_string();
    let changed = state.borrow().place_value(place) != Some(text.as_str());
    expand::references::write(place, text, state, cancel, work).await?;
    work.arithmetic_writes = work.arithmetic_writes.wrapping_add(u64::from(changed));
    Ok(())
}

async fn number(text: &str, work: &mut Work, cancel: &Cancel) -> Result<i64, Error> {
    let (base, digits) =
        if let Some(digits) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            (16, digits)
        } else if let Some((prefix, digits)) = text.split_once('#') {
            if prefix.starts_with('0') {
                return fault("invalid number", work);
            }
            work.checkpoint_steps(prefix.len(), cancel).await?;
            let mut base = 0u32;
            for byte in prefix.bytes() {
                if !byte.is_ascii_digit() {
                    return fault("invalid arithmetic base", work);
                }
                base = base
                    .saturating_mul(10)
                    .saturating_add(u32::from(byte - b'0'));
            }
            if !(2..=64).contains(&base) {
                return fault("invalid arithmetic base", work);
            }
            (base, digits)
        } else if text.len() > 1 && text.starts_with('0') {
            (8, &text[1..])
        } else {
            (10, text)
        };
    if digits.is_empty() {
        return if base == 16 && !text.contains('#') {
            Ok(0)
        } else {
            fault("invalid integer constant", work)
        };
    }
    work.checkpoint_steps(digits.len(), cancel).await?;
    let mut value = 0i64;
    for byte in digits.bytes() {
        let digit = match byte {
            b'0'..=b'9' => u32::from(byte - b'0'),
            b'a'..=b'z' => u32::from(byte - b'a') + 10,
            b'A'..=b'Z' => u32::from(byte - b'A') + if base > 36 { 36 } else { 10 },
            b'@' => 62,
            b'_' => 63,
            _ => return fault("invalid number", work),
        };
        if digit >= base {
            return fault("value too great for base", work);
        }
        value = value
            .wrapping_mul(i64::from(base))
            .wrapping_add(i64::from(digit));
    }
    Ok(value)
}
fn binary(op: &str, left: i64, right: i64, active: bool, work: &mut Work) -> Result<i64, Error> {
    Ok(match op {
        "+" => left.wrapping_add(right),
        "-" => left.wrapping_sub(right),
        "*" => left.wrapping_mul(right),
        "/" | "%" => {
            if right == 0 {
                if !active {
                    return Ok(0);
                }
                return fault("division by 0", work);
            }
            if op == "/" {
                left.wrapping_div(right)
            } else {
                left.wrapping_rem(right)
            }
        }
        "**" => {
            if right < 0 {
                if !active {
                    return Ok(0);
                }
                return fault("exponent less than 0", work);
            }
            let mut exponent = right as u64;
            let mut base = left;
            let mut result = 1i64;
            // At most 63 iterations, independent of exponent magnitude.
            while exponent != 0 {
                if exponent & 1 != 0 {
                    result = result.wrapping_mul(base);
                }
                base = base.wrapping_mul(base);
                exponent >>= 1;
            }
            result
        }
        "<<" => left.wrapping_shl((right & 63) as u32),
        ">>" => left.wrapping_shr((right & 63) as u32),
        "<" => i64::from(left < right),
        ">" => i64::from(left > right),
        "<=" => i64::from(left <= right),
        ">=" => i64::from(left >= right),
        "==" => i64::from(left == right),
        "!=" => i64::from(left != right),
        "&" => left & right,
        "^" => left ^ right,
        "|" => left | right,
        "&&" => i64::from(left != 0 && right != 0),
        "||" => i64::from(left != 0 || right != 0),
        "," => right,
        _ => return fault("syntax error in expression", work),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor::Executor, state::State};

    fn finish<T: Clone + 'static>(ex: &Executor, job: crate::executor::JoinHandle<T>) -> T {
        for _ in 0..100_000 {
            if job.is_finished() {
                return job.now_or_never().unwrap();
            }
            ex.drive(64);
        }
        panic!("arithmetic exceeded bounded executor turns");
    }

    #[test]
    fn completed_feature_futures_keep_their_exact_cumulative_storage_charge() {
        let bytes = std::mem::size_of::<futures::future::Ready<Result<usize, Error>>>();
        let mut work = Work::new(1, bytes * 2, 1);
        for expected in [bytes, 0] {
            let frame = admitted(&mut work, |_| ready(Ok(7usize)));
            assert!(matches!(frame.now_or_never(), Some(Ok(7))));
            assert_eq!(work.storage_left(), expected);
        }
        assert!(matches!(
            admitted(&mut work, |_| ready(Ok(7usize))),
            Either::Left(_)
        ));
        assert_eq!(work.storage_left(), 0);
    }

    #[test]
    fn future_frame_and_scalar_snapshot_storage_are_admitted_before_growth() {
        let ex = Executor::new();
        let job = ex.spawn(async {
            let state = State::default().shared();
            state
                .borrow_mut()
                .assign_parameter("x".into(), "7".repeat(1000))
                .unwrap();
            let cancel = Cancel::new();
            let mut empty = Work::new(100_000, 0, 1);
            assert!(matches!(
                evaluate("1", &state, &cancel, 4096, &mut empty).await,
                Err(Error::Status(2))
            ));
            let mut bounded = Work::new(100_000, 1_000_000, 1);
            assert!(matches!(
                evaluate("x", &state, &cancel, 999, &mut bounded).await,
                Err(Error::Status(2))
            ));
            assert_eq!(state.borrow().bindings()["x"].len(), 1000);
            let mut fuel = Work::new(1, 1_000_000, 1);
            assert!(matches!(
                evaluate("1+2", &state, &cancel, 4096, &mut fuel).await,
                Err(Error::Status(2))
            ));
        });
        finish(&ex, job);
    }

    #[test]
    fn loops_yield_and_cancel_without_rolling_back_completed_writes() {
        let ex = Executor::new();
        let state = State::default().shared();
        let observed = state.clone();
        let cancel = Cancel::new();
        let token = cancel.clone();
        let job = ex.spawn(async move {
            let source = format!("x=9,{}1", "1+".repeat(10_000));
            let mut work = Work::new(1_000_000, 64 * 1024 * 1024, 1);
            match evaluate(&source, &state, &token, 100_000, &mut work).await {
                Err(Error::Status(code)) => code,
                _ => 0,
            }
        });
        for _ in 0..100 {
            ex.drive(1);
            if observed.borrow().bindings().contains_key("x") {
                break;
            }
        }
        assert_eq!(
            observed
                .borrow()
                .bindings()
                .get("x")
                .map(|value| value.as_str()),
            Some("9")
        );
        assert!(
            !job.is_finished(),
            "large arithmetic must yield before finishing"
        );
        cancel.cancel();
        assert_eq!(finish(&ex, job), 130);
        assert_eq!(observed.borrow().bindings()["x"], "9");
    }

    #[test]
    fn recursive_cycles_are_domain_errors_but_parser_depth_is_resource_failure() {
        let ex = Executor::new();
        let job = ex.spawn(async {
            let state = State::default().shared();
            state
                .borrow_mut()
                .assign_parameter("x".into(), "y".into())
                .unwrap();
            state
                .borrow_mut()
                .assign_parameter("y".into(), "x".into())
                .unwrap();
            let cancel = Cancel::new();
            let mut work = Work::new(1_000_000, 1_000_000, 1);
            assert!(matches!(
                evaluate("x", &state, &cancel, 4096, &mut work).await,
                Err(Error::Arithmetic { .. })
            ));
            let mut work = Work::new(1_000_000, 1_000_000, 1);
            let source = format!("{}1{}", "(".repeat(100), ")".repeat(100));
            assert!(matches!(
                evaluate(&source, &state, &cancel, 4096, &mut work).await,
                Err(Error::Status(2))
            ));
        });
        finish(&ex, job);
    }

    #[test]
    fn rhs_leaf_inlining_preserves_postfix_precedence_and_scalar_bases() {
        let ex = Executor::new();
        let job = ex.spawn(async {
            let state = State::default().shared();
            state
                .borrow_mut()
                .assign_parameter("a".into(), "3".into())
                .unwrap();
            state
                .borrow_mut()
                .assign_parameter("oct".into(), "010".into())
                .unwrap();
            state
                .borrow_mut()
                .assign_parameter("min".into(), "-9223372036854775808".into())
                .unwrap();
            let cancel = Cancel::new();
            let mut work = Work::new(1_000_000, 1_000_000, 1);
            assert_eq!(
                evaluate("1 + a++ ** 2", &state, &cancel, 4096, &mut work)
                    .await
                    .ok(),
                Some(10)
            );
            assert_eq!(state.borrow().bindings()["a"], "4");
            assert_eq!(
                evaluate("oct + 1", &state, &cancel, 4096, &mut work)
                    .await
                    .ok(),
                Some(9)
            );
            assert_eq!(
                evaluate("min", &state, &cancel, 4096, &mut work).await.ok(),
                Some(i64::MIN)
            );
        });
        finish(&ex, job);
    }
}
