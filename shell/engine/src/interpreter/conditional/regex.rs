//! Original bounded no-capture ERE adapter for `[[ =~ ]]`.
//!
//! Shell quoting is retained by expansion, not reconstructed from strings.
//! Thompson states avoid backtracking. Compilation, epsilon closure, character
//! classes and input scans all charge Work and poll cancellation. Every vector
//! reserves against storage before growing; no host regex fallback is used.
//! ASCII pattern/input only, in C/POSIX/C.UTF-8/C.utf8 character and collation
//! locales. Other input/locale combinations fail closed rather than pretending
//! Unicode classes or byte-oriented C-locale matching have been implemented.
//! Capture groups/backreferences and locale collating/equivalence constructs
//! also fail closed (status 2): BASH_REMATCH belongs to the future arrays subarea.
use crate::{
    executor::Cancel,
    expand::{Error, Work, pattern::Pattern},
    state::SharedState,
};
use std::mem::size_of;

/// Like the scalar case adapter, select the first nonempty locale variable.
/// ERE ranges additionally depend on LC_COLLATE, not only LC_CTYPE. Never
/// silently substitute ASCII rules for a locale we do not implement.
pub(super) fn locale(state: &SharedState) -> Result<(), Error> {
    let state = state.borrow();
    for category in ["LC_CTYPE", "LC_COLLATE"] {
        let locale = ["LC_ALL", category, "LANG"]
            .iter()
            .filter_map(|name| state.scalar_parameter(name))
            .find(|value| !value.is_empty())
            .unwrap_or("C");
        if !matches!(locale, "C" | "POSIX" | "C.UTF-8" | "C.utf8") {
            return Err(2.into());
        }
    }
    Ok(())
}

async fn ascii(
    pattern: &Pattern,
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    let mut index = 0;
    while let Some((ch, _)) = pattern.regex_character(index) {
        work.checkpoint(cancel).await?;
        if !ch.is_ascii() {
            return Err(2.into());
        }
        index += 1;
    }
    for byte in value.bytes() {
        work.checkpoint(cancel).await?;
        if !byte.is_ascii() {
            return Err(2.into());
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Atom {
    Literal(char),
    Any,
    Class {
        start: usize,
        end: usize,
        negated: bool,
    },
    Start,
    End,
}
#[derive(Clone, Copy)]
struct Term {
    atom: Atom,
    min: usize,
    max: Option<usize>,
}
#[derive(Clone, Copy)]
enum Node {
    Accept,
    Consume(Atom, usize),
    Split(usize, usize),
    Start(usize),
    End(usize),
}

fn push<T>(values: &mut Vec<T>, value: T, work: &mut Work) -> Result<usize, Error> {
    if values.len() == values.capacity() {
        let capacity = values.capacity().saturating_mul(2).max(4);
        work.admit_storage(
            (capacity - values.capacity())
                .checked_mul(size_of::<T>())
                .ok_or(2)?,
        )?;
        values
            .try_reserve_exact(capacity - values.len())
            .map_err(|_| Error::Status(2))?;
    }
    let index = values.len();
    values.push(value);
    Ok(index)
}
fn active(pattern: &Pattern, index: usize, value: char) -> bool {
    pattern.regex_character(index) == Some((value, false))
}

// ERE escapes introduced by unquoted parameter expansion are handled here;
// source backslash escapes have already become protected literal characters.
fn character(pattern: &Pattern, index: &mut usize) -> Result<(char, bool), Error> {
    let (value, protected) = pattern.regex_character(*index).ok_or(2)?;
    *index += 1;
    if value == '\\' && !protected {
        let (escaped, _) = pattern.regex_character(*index).ok_or(2)?;
        *index += 1;
        // POSIX leaves escapes of ordinary characters undefined; GNU extensions
        // such as \b/\w and backreferences must not become guessed literals.
        if escaped.is_ascii_alphanumeric() {
            return Err(2.into());
        }
        return Ok((escaped, true));
    }
    Ok((value, protected))
}

async fn class_end(
    pattern: &Pattern,
    mut index: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(Atom, usize), Error> {
    let negated = active(pattern, index, '^');
    index += usize::from(negated);
    let start = index;
    if active(pattern, index, ']') {
        index += 1;
    }
    while let Some((value, protected)) = pattern.regex_character(index) {
        work.checkpoint(cancel).await?;
        if value == ']' && !protected {
            if index == start {
                return Err(2.into());
            }
            // Validate all ranges and named classes even if matching would
            // short circuit before this branch or this class member.
            let mut member = start;
            while member < index {
                work.checkpoint(cancel).await?;
                let (low, named) = class_member(pattern, &mut member, index, work, cancel).await?;
                if active(pattern, member, '-') && member + 1 < index {
                    member += 1;
                    let (high, high_named) =
                        class_member(pattern, &mut member, index, work, cancel).await?;
                    if named.is_some() || high_named.is_some() || low > high {
                        return Err(2.into());
                    }
                }
            }
            return Ok((
                Atom::Class {
                    start,
                    end: index,
                    negated,
                },
                index + 1,
            ));
        }
        if value == '[' && !protected && active(pattern, index + 1, ':') {
            index += 2;
            while pattern.regex_character(index).is_some() && !active(pattern, index, ':') {
                work.checkpoint(cancel).await?;
                index += 1;
            }
            if !active(pattern, index, ':') || !active(pattern, index + 1, ']') {
                return Err(2.into());
            }
            index += 2;
        } else {
            // Backslash is ordinary inside POSIX ERE bracket expressions.
            index += 1;
        }
    }
    Err(2.into())
}

#[derive(Clone, Copy)]
enum Named {
    Alnum,
    Alpha,
    Blank,
    Cntrl,
    Digit,
    Graph,
    Lower,
    Print,
    Punct,
    Space,
    Upper,
    Xdigit,
}
async fn class_member(
    pattern: &Pattern,
    index: &mut usize,
    end: usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(char, Option<Named>), Error> {
    let (ch, protected) = pattern.regex_character(*index).ok_or(2)?;
    if ch != '[' || protected {
        *index += 1;
        return Ok((ch, None));
    }
    if active(pattern, *index + 1, '.') || active(pattern, *index + 1, '=') {
        return Err(2.into());
    }
    if !active(pattern, *index + 1, ':') {
        *index += 1;
        return Ok((ch, None));
    }
    *index += 2;
    // POSIX class names fit this fixed stack buffer. No hidden allocation.
    let mut name = [0u8; 6];
    let mut len = 0;
    while *index < end && !active(pattern, *index, ':') {
        work.checkpoint(cancel).await?;
        let (ch, protected) = pattern.regex_character(*index).ok_or(2)?;
        if protected || !ch.is_ascii() || len == name.len() {
            return Err(2.into());
        }
        name[len] = ch as u8;
        len += 1;
        *index += 1;
    }
    if !active(pattern, *index, ':') || !active(pattern, *index + 1, ']') {
        return Err(2.into());
    }
    *index += 2;
    let named = match &name[..len] {
        b"alnum" => Named::Alnum,
        b"alpha" => Named::Alpha,
        b"blank" => Named::Blank,
        b"cntrl" => Named::Cntrl,
        b"digit" => Named::Digit,
        b"graph" => Named::Graph,
        b"lower" => Named::Lower,
        b"print" => Named::Print,
        b"punct" => Named::Punct,
        b"space" => Named::Space,
        b"upper" => Named::Upper,
        b"xdigit" => Named::Xdigit,
        _ => return Err(2.into()),
    };
    Ok(('\0', Some(named)))
}
fn named_matches(named: Named, ch: char) -> bool {
    match named {
        Named::Alnum => ch.is_ascii_alphanumeric(),
        Named::Alpha => ch.is_ascii_alphabetic(),
        Named::Blank => matches!(ch, ' ' | '\t'),
        Named::Cntrl => ch.is_ascii_control(),
        Named::Digit => ch.is_ascii_digit(),
        Named::Graph => ch.is_ascii_graphic(),
        Named::Lower => ch.is_ascii_lowercase(),
        Named::Print => ch == ' ' || ch.is_ascii_graphic(),
        Named::Punct => ch.is_ascii_punctuation(),
        Named::Space => matches!(ch, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'),
        Named::Upper => ch.is_ascii_uppercase(),
        Named::Xdigit => ch.is_ascii_hexdigit(),
    }
}
async fn atom_matches(
    atom: Atom,
    ch: char,
    pattern: &Pattern,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    match atom {
        Atom::Literal(value) => Ok(value == ch),
        Atom::Any => Ok(true),
        Atom::Class {
            start,
            end,
            negated,
        } => {
            let mut index = start;
            let mut matched = false;
            while index < end {
                work.checkpoint(cancel).await?;
                let (low, named) = class_member(pattern, &mut index, end, work, cancel).await?;
                let found = if active(pattern, index, '-') && index + 1 < end {
                    index += 1;
                    let (high, _) = class_member(pattern, &mut index, end, work, cancel).await?;
                    low <= ch && ch <= high
                } else {
                    named.map_or(low == ch, |named| named_matches(named, ch))
                };
                matched |= found;
            }
            Ok(matched != negated)
        }
        Atom::Start | Atom::End => unreachable!("anchors are epsilon nodes"),
    }
}
async fn decimal(
    pattern: &Pattern,
    index: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    let start = *index;
    let mut number = 0usize;
    while let Some((ch @ '0'..='9', false)) = pattern.regex_character(*index) {
        work.checkpoint(cancel).await?;
        number = number
            .checked_mul(10)
            .and_then(|n| n.checked_add((ch as u8 - b'0') as usize))
            .ok_or(2)?;
        *index += 1;
    }
    if *index == start {
        return Err(2.into());
    }
    Ok(number)
}
async fn repetition(
    pattern: &Pattern,
    index: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(usize, Option<usize>), Error> {
    let result = match pattern.regex_character(*index) {
        Some(('*', false)) => (0, None),
        Some(('+', false)) => (1, None),
        Some(('?', false)) => (0, Some(1)),
        Some(('{', false)) => {
            *index += 1;
            let min = decimal(pattern, index, work, cancel).await?;
            let max = if active(pattern, *index, ',') {
                *index += 1;
                if active(pattern, *index, '}') {
                    None
                } else {
                    Some(decimal(pattern, index, work, cancel).await?)
                }
            } else {
                Some(min)
            };
            if !active(pattern, *index, '}') || max.is_some_and(|max| min > max) {
                return Err(2.into());
            }
            (min, max)
        }
        _ => return Ok((1, Some(1))),
    };
    *index += 1;
    if let Some(('*' | '+' | '?' | '{', false)) = pattern.regex_character(*index) {
        // GNU repeated quantifier extensions are deliberately unsupported.
        return Err(2.into());
    }
    Ok(result)
}
async fn compile(
    pattern: &Pattern,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(Vec<Node>, usize), Error> {
    let mut nodes = Vec::new();
    push(&mut nodes, Node::Accept, work)?;
    let mut alternatives = Vec::new();
    let mut terms = Vec::new();
    let mut index = 0;
    loop {
        work.checkpoint(cancel).await?;
        let boundary = pattern.regex_character(index).is_none() || active(pattern, index, '|');
        if boundary {
            let mut next = 0;
            while let Some(term) = terms.pop() {
                let Term { atom, min, max } = term;
                if matches!(atom, Atom::Start | Atom::End) {
                    next = push(
                        &mut nodes,
                        if matches!(atom, Atom::Start) {
                            Node::Start(next)
                        } else {
                            Node::End(next)
                        },
                        work,
                    )?;
                    continue;
                }
                if let Some(max) = max {
                    for _ in min..max {
                        work.checkpoint(cancel).await?;
                        let consume = push(&mut nodes, Node::Consume(atom, next), work)?;
                        next = push(&mut nodes, Node::Split(consume, next), work)?;
                    }
                } else {
                    let split = push(&mut nodes, Node::Split(0, next), work)?;
                    let consume = push(&mut nodes, Node::Consume(atom, split), work)?;
                    nodes[split] = Node::Split(consume, next);
                    next = split;
                }
                for _ in 0..min {
                    work.checkpoint(cancel).await?;
                    next = push(&mut nodes, Node::Consume(atom, next), work)?;
                }
            }
            push(&mut alternatives, next, work)?;
            if pattern.regex_character(index).is_none() {
                break;
            }
            index += 1;
            continue;
        }
        let (ch, protected) = character(pattern, &mut index)?;
        let atom = match (ch, protected) {
            ('(', false) | (')', false) => return Err(2.into()),
            ('*' | '+' | '?' | '{', false) => return Err(2.into()),
            ('[', false) => {
                let (atom, next) = class_end(pattern, index, work, cancel).await?;
                index = next;
                atom
            }
            ('.', false) => Atom::Any,
            ('^', false) => Atom::Start,
            ('$', false) => Atom::End,
            _ => Atom::Literal(ch),
        };
        let (min, max) = repetition(pattern, &mut index, work, cancel).await?;
        if matches!(atom, Atom::Start | Atom::End) && (min != 1 || max != Some(1)) {
            return Err(2.into());
        }
        push(&mut terms, Term { atom, min, max }, work)?;
    }
    let mut start = alternatives.pop().ok_or(2)?;
    while let Some(other) = alternatives.pop() {
        work.checkpoint(cancel).await?;
        start = push(&mut nodes, Node::Split(other, start), work)?;
    }
    Ok((nodes, start))
}
fn slots<T: Clone>(count: usize, value: T, work: &mut Work) -> Result<Vec<T>, Error> {
    work.admit_storage(count.checked_mul(size_of::<T>()).ok_or(2)?)?;
    let mut result = Vec::new();
    result
        .try_reserve_exact(count)
        .map_err(|_| Error::Status(2))?;
    // Initialization happens cooperatively in matches, not via resize here.
    let _ = value;
    Ok(result)
}
async fn closure(
    nodes: &[Node],
    states: &mut [bool],
    stack: &mut Vec<usize>,
    seed: usize,
    position: std::ops::Range<usize>,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    if !states[seed] {
        states[seed] = true;
        stack.push(seed);
    }
    while let Some(index) = stack.pop() {
        work.checkpoint(cancel).await?;
        let mut add = |next: usize| {
            if !states[next] {
                states[next] = true;
                stack.push(next);
            }
        };
        match nodes[index] {
            Node::Split(left, right) => {
                add(left);
                add(right);
            }
            Node::Start(next) if position.start == 0 => add(next),
            Node::End(next) if position.start == position.end => add(next),
            _ => {}
        }
    }
    Ok(())
}

pub(super) async fn matches(
    pattern: &Pattern,
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    ascii(pattern, value, work, cancel).await?;
    let (nodes, start) = compile(pattern, work, cancel).await?;
    let mut current = slots(nodes.len(), false, work)?;
    let mut next = slots(nodes.len(), false, work)?;
    let mut stack: Vec<usize> = slots(nodes.len(), 0, work)?;
    for _ in 0..nodes.len() {
        work.checkpoint(cancel).await?;
        current.push(false);
        next.push(false);
    }
    closure(
        &nodes,
        &mut current,
        &mut stack,
        start,
        0..value.len(),
        work,
        cancel,
    )
    .await?;
    if current[0] {
        return Ok(true);
    }
    for (position, ch) in value.char_indices() {
        work.checkpoint(cancel).await?;
        let after = position + ch.len_utf8();
        for state in &mut next {
            work.checkpoint(cancel).await?;
            *state = false;
        }
        for index in 0..nodes.len() {
            work.checkpoint(cancel).await?;
            if current[index]
                && let Node::Consume(atom, destination) = nodes[index]
                && atom_matches(atom, ch, pattern, work, cancel).await?
            {
                closure(
                    &nodes,
                    &mut next,
                    &mut stack,
                    destination,
                    after..value.len(),
                    work,
                    cancel,
                )
                .await?;
            }
        }
        closure(
            &nodes,
            &mut next,
            &mut stack,
            start,
            after..value.len(),
            work,
            cancel,
        )
        .await?;
        std::mem::swap(&mut current, &mut next);
        if current[0] {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{executor::Executor, expand, state::State};
    use futures::FutureExt;
    use std::{
        future::Future,
        task::{Context, Poll},
    };

    fn finish<T>(future: impl Future<Output = T>) -> T {
        let mut future = Box::pin(future);
        let mut context = Context::from_waker(futures::task::noop_waker_ref());
        for _ in 0..100_000 {
            if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
        panic!("bounded ERE operation did not finish");
    }
    fn pattern(source: &str) -> Pattern {
        let mut word = shell_parser::Parser::parse_word_string_with_limits(source, 32, 65536);
        // This parser entry returns a synthetic word without source spelling.
        // Pattern expansion requires the actual source, never Display output.
        word.raw = Some(source.to_owned());
        let mut work = Work::new(1_000_000, 1_000_000, 16);
        finish(expand::conditional_pattern(
            &word,
            &State::default().shared(),
            &Cancel::new(),
            65536,
            &mut work,
        ))
        .unwrap_or_else(|_| panic!("pattern expansion must succeed"))
    }
    #[test]
    fn state_vector_admission_precedes_growth() {
        let mut work = Work::new(64, 0, 1);
        let mut nodes = Vec::new();
        assert!(matches!(
            push(&mut nodes, Node::Accept, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(nodes.capacity(), 0);
        assert!(nodes.is_empty());
        assert!(matches!(
            slots::<usize>(1, 0, &mut work),
            Err(Error::Status(2))
        ));
    }
    #[test]
    fn compile_and_match_exhaustion_are_errors_not_misses() {
        let pattern = pattern("a{1024}");
        let mut work = Work::new(1_000_000, 1024, 1);
        assert!(matches!(
            finish(matches(&pattern, "a", &mut work, &Cancel::new())),
            Err(Error::Status(2))
        ));
        let pattern = self::pattern("a*");
        let mut work = Work::new(0, 65536, 1);
        assert!(matches!(
            finish(matches(&pattern, "a", &mut work, &Cancel::new())),
            Err(Error::Status(2))
        ));
    }
    #[test]
    fn matching_itself_yields_and_polls_cancellation() {
        let pattern = pattern("a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b$");
        let text = "a".repeat(65536);
        let executor = Executor::new();
        let cancel = Cancel::new();
        let child_cancel = cancel.clone();
        let job = executor.spawn(async move {
            let mut work = Work::new(100_000_000, 1_000_000, 1);
            match matches(&pattern, &text, &mut work, &child_cancel).await {
                Ok(value) => i32::from(!value),
                Err(Error::Status(status)) => status,
                Err(_) => panic!("unexpected non-status ERE error"),
            }
        });
        executor.drive(1);
        assert!(
            !job.is_finished(),
            "ERE traversal must yield independently of expansion"
        );
        cancel.cancel();
        for _ in 0..10 {
            executor.drive(1);
            if job.is_finished() {
                break;
            }
        }
        assert_eq!(job.now_or_never(), Some(130));
        assert_eq!(executor.drive(64).pending, 0);
    }
}
