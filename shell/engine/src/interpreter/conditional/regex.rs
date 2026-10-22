//! Original bounded ERE adapter for `[[ =~ ]]`.
//!
//! Shell quoting is retained by expansion, not reconstructed from strings.
//! Thompson states avoid backtracking. Compilation, epsilon closure, character
//! classes and input scans all charge Work and poll cancellation. Every vector
//! reserves against storage before growing; no host regex fallback is used.
//! ASCII pattern/input only, in C/POSIX/C.UTF-8/C.utf8 character and collation
//! locales. Other input/locale combinations fail closed rather than pretending
//! Unicode classes or byte-oriented C-locale matching have been implemented.
//! Matching selects the leftmost-longest span. A reverse reachability table
//! reconstructs ordered captures with per-copy optional-group metadata and
//! terminal assertion provenance, without speculative input scans.
//! Backreferences and locale collating/equivalence constructs fail closed (2).
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
enum Expression {
    Empty,
    Atom(Atom),
    Group(usize, usize),
    Sequence(usize, usize),
    Alternative(usize, usize),
    Repeat {
        child: usize,
        min: usize,
        max: Option<usize>,
    },
}
#[derive(Default)]
struct Group {
    number: usize,
    sequence: Option<usize>,
    alternatives: Option<usize>,
}

impl Group {
    fn append(
        &mut self,
        child: usize,
        expressions: &mut Vec<Expression>,
        work: &mut Work,
    ) -> Result<(), Error> {
        self.sequence = Some(match self.sequence {
            Some(left) => push(expressions, Expression::Sequence(left, child), work)?,
            None => child,
        });
        Ok(())
    }

    fn branch(&mut self, expressions: &mut Vec<Expression>, work: &mut Work) -> Result<(), Error> {
        let branch = match self.sequence.take() {
            Some(sequence) => sequence,
            None => push(expressions, Expression::Empty, work)?,
        };
        self.alternatives = Some(match self.alternatives {
            Some(left) => push(expressions, Expression::Alternative(left, branch), work)?,
            None => branch,
        });
        Ok(())
    }

    fn finish(
        mut self,
        expressions: &mut Vec<Expression>,
        work: &mut Work,
    ) -> Result<usize, Error> {
        self.branch(expressions, work)?;
        self.alternatives.ok_or_else(|| 2.into())
    }
}

#[derive(Clone, Copy)]
enum Node {
    Accept,
    Consume(Atom, usize),
    Split(usize, usize),
    Start(usize),
    End(usize),
    Save(usize, usize),
    OptionalSave(usize, usize),
    Begin { repeat: usize, next: usize },
    Repeat { body: usize, next: usize },
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
async fn interval(
    pattern: &Pattern,
    index: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(usize, Option<usize>), Error> {
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
    if !active(pattern, *index, '}')
        || min > 32767
        || max.is_some_and(|max| min > max || max > 32767)
    {
        return Err(2.into());
    }
    Ok((min, max))
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
        Some(('{', false)) => interval(pattern, index, work, cancel).await?,
        _ => return Ok((1, Some(1))),
    };
    *index += 1;
    if let Some(('*' | '+' | '?' | '{', false)) = pattern.regex_character(*index) {
        // GNU repeated quantifier extensions are deliberately unsupported.
        return Err(2.into());
    }
    Ok(result)
}
async fn repeated(
    child: usize,
    expressions: &mut Vec<Expression>,
    pattern: &Pattern,
    index: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    let (min, max) = repetition(pattern, index, work, cancel).await?;
    if min == 1 && max == Some(1) {
        return Ok(child);
    }
    if matches!(
        expressions[child],
        Expression::Atom(Atom::Start | Atom::End)
    ) {
        return Err(2.into());
    }
    push(expressions, Expression::Repeat { child, min, max }, work)
}

fn open_group(groups: &mut Vec<Group>, group: &mut Group, work: &mut Work) -> Result<(), Error> {
    if groups.len() == 64 {
        return Err(2.into());
    }
    push(groups, std::mem::take(group), work)?;
    Ok(())
}

async fn parse_atom(
    pattern: &Pattern,
    index: &mut usize,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Atom, Error> {
    let (ch, protected) = character(pattern, index)?;
    Ok(match (ch, protected) {
        ('*' | '+' | '?' | '{', false) => return Err(2.into()),
        ('[', false) => {
            let (atom, next) = class_end(pattern, *index, work, cancel).await?;
            *index = next;
            atom
        }
        ('.', false) => Atom::Any,
        ('^', false) => Atom::Start,
        ('$', false) => Atom::End,
        _ => Atom::Literal(ch),
    })
}

async fn parse(
    pattern: &Pattern,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(Vec<Expression>, usize, usize), Error> {
    let mut expressions = Vec::new();
    let mut groups = Vec::new();
    let mut group = Group::default();
    let mut count = 0usize;
    let mut index = 0;
    while pattern.regex_character(index).is_some() {
        work.checkpoint(cancel).await?;
        if active(pattern, index, '(') {
            open_group(&mut groups, &mut group, work)?;
            count = count.checked_add(1).ok_or(2)?;
            group.number = count;
            index += 1;
            continue;
        }
        if active(pattern, index, ')') {
            let number = group.number;
            let child = group.finish(&mut expressions, work)?;
            let child = push(&mut expressions, Expression::Group(child, number), work)?;
            group = groups.pop().ok_or(2)?;
            index += 1;
            let child =
                repeated(child, &mut expressions, pattern, &mut index, work, cancel).await?;
            group.append(child, &mut expressions, work)?;
            continue;
        }
        if active(pattern, index, '|') {
            group.branch(&mut expressions, work)?;
            index += 1;
            continue;
        }
        let atom = parse_atom(pattern, &mut index, work, cancel).await?;
        let child = push(&mut expressions, Expression::Atom(atom), work)?;
        let child = repeated(child, &mut expressions, pattern, &mut index, work, cancel).await?;
        group.append(child, &mut expressions, work)?;
    }
    if !groups.is_empty() {
        return Err(2.into());
    }
    let root = group.finish(&mut expressions, work)?;
    Ok((expressions, root, count))
}

// Copying an expanded subtree resets its optional-group markers. A newly
// optional wrapper can then mark its own root group without marking descendants.
#[derive(Clone, Copy, Default)]
struct CopyContext {
    duplicated: bool,
    optional: bool,
}
impl CopyContext {
    fn close(self, slot: usize, next: usize) -> Node {
        if self.optional {
            return Node::OptionalSave(slot, next);
        }
        Node::Save(slot, next)
    }
    fn child(self) -> Self {
        Self {
            optional: false,
            ..self
        }
    }
    fn copy(self, duplicated: bool, optional: bool) -> Self {
        Self {
            duplicated: self.duplicated || duplicated,
            optional: !self.duplicated && optional,
        }
    }
}

#[derive(Clone, Copy)]
enum Compile {
    Visit(usize, usize, CopyContext),
    Sequence(usize, CopyContext),
    Alternative {
        left: usize,
        next: usize,
        context: CopyContext,
    },
    Join {
        right: usize,
        next: usize,
    },
    Capture(usize),
    Begin(usize),
    Copies {
        child: usize,
        required: usize,
        optional: usize,
        context: CopyContext,
    },
    Optional(usize),
    Loop {
        split: usize,
        next: usize,
    },
}

fn copies(
    child: usize,
    required: usize,
    optional: usize,
    context: CopyContext,
    next: usize,
    tasks: &mut Vec<Compile>,
    work: &mut Work,
) -> Result<(), Error> {
    if optional > 0 {
        push(
            tasks,
            Compile::Copies {
                child,
                required,
                optional: optional - 1,
                context,
            },
            work,
        )?;
        push(tasks, Compile::Optional(next), work)?;
        push(
            tasks,
            Compile::Visit(
                child,
                next,
                context.copy(required > 0 || optional > 1, optional == 1),
            ),
            work,
        )?;
        return Ok(());
    }
    if required > 0 {
        push(
            tasks,
            Compile::Copies {
                child,
                required: required - 1,
                optional: 0,
                context: context.child(),
            },
            work,
        )?;
        push(
            tasks,
            Compile::Visit(child, next, context.copy(required > 1, context.optional)),
            work,
        )?;
    }
    Ok(())
}

fn atom_node(atom: Atom, next: usize) -> Node {
    match atom {
        Atom::Start => Node::Start(next),
        Atom::End => Node::End(next),
        _ => Node::Consume(atom, next),
    }
}

fn visit(
    expression: Expression,
    next: usize,
    context: CopyContext,
    nodes: &mut Vec<Node>,
    tasks: &mut Vec<Compile>,
    work: &mut Work,
) -> Result<usize, Error> {
    match expression {
        Expression::Empty => return Ok(next),
        Expression::Atom(atom) => return push(nodes, atom_node(atom, next), work),
        Expression::Group(child, number) => {
            let slot = number.checked_mul(2).ok_or(2)?;
            let end = push(nodes, context.close(slot + 1, next), work)?;
            push(tasks, Compile::Capture(slot), work)?;
            push(tasks, Compile::Visit(child, end, context.child()), work)?;
        }
        Expression::Sequence(left, right) => {
            push(tasks, Compile::Sequence(left, context), work)?;
            push(tasks, Compile::Visit(right, next, context.child()), work)?;
        }
        Expression::Alternative(left, right) => {
            push(
                tasks,
                Compile::Alternative {
                    left,
                    next,
                    context,
                },
                work,
            )?;
            push(tasks, Compile::Visit(right, next, context.child()), work)?;
        }
        Expression::Repeat {
            child,
            min,
            max: Some(max),
        } => {
            push(
                tasks,
                Compile::Copies {
                    child,
                    required: min,
                    optional: max - min,
                    context: CopyContext {
                        optional: min > 1 && max > min,
                        ..context
                    },
                },
                work,
            )?;
        }
        Expression::Repeat {
            child,
            min,
            max: None,
        } => {
            let split = push(nodes, Node::Repeat { body: 0, next }, work)?;
            push(tasks, Compile::Begin(split), work)?;
            push(
                tasks,
                Compile::Copies {
                    child,
                    required: min,
                    optional: 0,
                    context: CopyContext {
                        optional: min > 1,
                        ..context
                    },
                },
                work,
            )?;
            push(tasks, Compile::Loop { split, next }, work)?;
            push(
                tasks,
                Compile::Visit(child, split, context.copy(min > 0, false)),
                work,
            )?;
        }
    }
    Ok(next)
}

fn compile_task(
    task: Compile,
    expressions: &[Expression],
    nodes: &mut Vec<Node>,
    tasks: &mut Vec<Compile>,
    work: &mut Work,
    mut result: usize,
) -> Result<usize, Error> {
    match task {
        Compile::Visit(child, next, context) => {
            result = visit(expressions[child], next, context, nodes, tasks, work)?
        }
        Compile::Sequence(left, context) => {
            push(tasks, Compile::Visit(left, result, context.child()), work)?;
        }
        Compile::Alternative {
            left,
            next,
            context,
        } => {
            push(
                tasks,
                Compile::Join {
                    right: result,
                    next,
                },
                work,
            )?;
            push(tasks, Compile::Visit(left, next, context.child()), work)?;
        }
        Compile::Join { right, next } if result == next => {
            result = push(nodes, Node::Split(right, result), work)?;
        }
        Compile::Join { right, .. } => result = push(nodes, Node::Split(result, right), work)?,
        Compile::Capture(slot) => result = push(nodes, Node::Save(slot, result), work)?,
        Compile::Begin(repeat) => {
            result = push(
                nodes,
                Node::Begin {
                    repeat,
                    next: result,
                },
                work,
            )?;
        }
        Compile::Copies {
            child,
            required,
            optional,
            context,
        } => copies(child, required, optional, context, result, tasks, work)?,
        Compile::Optional(next) => result = push(nodes, Node::Split(result, next), work)?,
        Compile::Loop { split, next } => {
            nodes[split] = Node::Repeat { body: result, next };
            result = split;
        }
    }
    Ok(result)
}

async fn compile(
    pattern: &Pattern,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(Vec<Node>, usize, usize), Error> {
    let (expressions, root, count) = parse(pattern, work, cancel).await?;
    let mut nodes = Vec::new();
    push(&mut nodes, Node::Accept, work)?;
    let mut tasks = Vec::new();
    push(
        &mut tasks,
        Compile::Visit(root, 0, CopyContext::default()),
        work,
    )?;
    let mut result = 0;
    while let Some(task) = tasks.pop() {
        work.checkpoint(cancel).await?;
        result = compile_task(task, &expressions, &mut nodes, &mut tasks, work, result)?;
    }
    Ok((nodes, result, count))
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
fn epsilon(node: Node) -> (Option<usize>, Option<usize>) {
    match node {
        Node::Split(left, right) => (Some(left), Some(right)),
        Node::Repeat { body, next } => (Some(body), Some(next)),
        Node::Save(_, next)
        | Node::OptionalSave(_, next)
        | Node::Start(next)
        | Node::End(next)
        | Node::Begin { next, .. } => (Some(next), None),
        _ => (None, None),
    }
}
fn anchor(node: Node, position: usize, length: usize) -> bool {
    !matches!(node, Node::Start(_) if position != 0)
        && !matches!(node, Node::End(_) if position != length)
}
async fn closure(
    nodes: &[Node],
    states: &mut [usize],
    stack: &mut Vec<usize>,
    candidate: (usize, usize),
    position: std::ops::Range<usize>,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    let (seed, origin) = candidate;
    if states[seed] <= origin {
        return Ok(());
    }
    states[seed] = origin;
    push(stack, seed, work)?;
    while let Some(index) = stack.pop() {
        work.checkpoint(cancel).await?;
        if !anchor(nodes[index], position.start, position.end) {
            continue;
        }
        let origin = states[index];
        let (left, right) = epsilon(nodes[index]);
        for next in left.into_iter().chain(right) {
            if states[next] <= origin {
                continue;
            }
            states[next] = origin;
            push(stack, next, work)?;
        }
    }
    Ok(())
}
async fn longest(
    nodes: &[Node],
    start: usize,
    pattern: &Pattern,
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<(usize, usize)>, Error> {
    let mut current = initialized(nodes.len(), usize::MAX, work, cancel).await?;
    let mut next = initialized(nodes.len(), usize::MAX, work, cancel).await?;
    let mut stack = slots(nodes.len(), 0usize, work)?;
    let mut found = None;
    for position in 0..=value.len() {
        closure(
            nodes,
            &mut current,
            &mut stack,
            (start, position),
            position..value.len(),
            work,
            cancel,
        )
        .await?;
        if current[0] != usize::MAX && found.is_none_or(|(begin, _)| current[0] <= begin) {
            found = Some((current[0], position));
        }
        let Some(ch) = value.as_bytes().get(position) else {
            break;
        };
        for state in &mut next {
            work.checkpoint(cancel).await?;
            *state = usize::MAX;
        }
        for (index, node) in nodes.iter().enumerate() {
            work.checkpoint(cancel).await?;
            let Node::Consume(atom, destination) = *node else {
                continue;
            };
            if current[index] == usize::MAX {
                continue;
            }
            if !atom_matches(atom, char::from(*ch), pattern, work, cancel).await? {
                continue;
            }
            closure(
                nodes,
                &mut next,
                &mut stack,
                (destination, current[index]),
                position + 1..value.len(),
                work,
                cancel,
            )
            .await?;
        }
        std::mem::swap(&mut current, &mut next);
    }
    Ok(found)
}
async fn initialized<T: Copy>(
    count: usize,
    value: T,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<T>, Error> {
    let mut result = slots(count, value, work)?;
    for _ in 0..count {
        work.checkpoint(cancel).await?;
        result.push(value);
    }
    Ok(result)
}

// Reverse epsilon edges let each input row reach a fixed point in O(nodes).
// Bits cover only the chosen match, not unmatched prefixes/suffixes.
struct Reverse {
    heads: Vec<Option<usize>>,
    edges: Vec<(usize, Option<usize>)>,
}
struct Reachable {
    bits: Vec<u64>,
    width: usize,
    begin: usize,
}
impl Reachable {
    fn get(&self, node: usize, position: usize) -> bool {
        let bit = (position - self.begin) * self.width + node;
        self.bits[bit / 64] & (1 << (bit % 64)) != 0
    }
    fn insert(&mut self, node: usize, position: usize) -> bool {
        let bit = (position - self.begin) * self.width + node;
        let mask = 1 << (bit % 64);
        let old = self.bits[bit / 64];
        self.bits[bit / 64] |= mask;
        old & mask == 0
    }
}
async fn reachability(
    nodes: &[Node],
    pattern: &Pattern,
    value: &str,
    span: (usize, usize),
    terminal_unconstrained: bool,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Reachable, Error> {
    let count = (span.1 - span.0 + 1).checked_mul(nodes.len()).ok_or(2)?;
    let bits = initialized(count.div_ceil(64), 0u64, work, cancel).await?;
    let mut result = Reachable {
        bits,
        width: nodes.len(),
        begin: span.0,
    };
    let mut heads = initialized(nodes.len(), None, work, cancel).await?;
    let mut edges = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        let (left, right) = epsilon(*node);
        for next in left.into_iter().chain(right) {
            work.checkpoint(cancel).await?;
            let edge = push(&mut edges, (index, heads[next]), work)?;
            heads[next] = Some(edge);
        }
    }
    let reverse = Reverse { heads, edges };
    let mut stack = slots(nodes.len(), 0usize, work)?;
    for position in (span.0..=span.1).rev() {
        if position == span.1 {
            result.insert(0, position);
            stack.push(0);
        }
        for (index, node) in nodes.iter().enumerate() {
            work.checkpoint(cancel).await?;
            let Node::Consume(atom, next) = *node else {
                continue;
            };
            if position == span.1 || !result.get(next, position + 1) {
                continue;
            }
            if !atom_matches(
                atom,
                char::from(value.as_bytes()[position]),
                pattern,
                work,
                cancel,
            )
            .await?
            {
                continue;
            }
            result.insert(index, position);
            stack.push(index);
        }
        reverse_closure(
            nodes,
            &reverse,
            &mut result,
            &mut stack,
            CapturePosition {
                offset: position,
                length: value.len(),
                unconstrained: terminal_unconstrained && position == span.1,
            },
            work,
            cancel,
        )
        .await?;
    }
    Ok(result)
}

struct CapturePosition {
    offset: usize,
    length: usize,
    unconstrained: bool,
}
async fn reverse_closure(
    nodes: &[Node],
    reverse: &Reverse,
    result: &mut Reachable,
    stack: &mut Vec<usize>,
    position: CapturePosition,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    let mut edge: Option<usize> = None;
    while edge.is_some() || !stack.is_empty() {
        work.checkpoint(cancel).await?;
        let Some(id) = edge else {
            edge = reverse.heads[stack.pop().ok_or(2)?];
            continue;
        };
        let (prior, previous) = reverse.edges[id];
        edge = previous;
        if position.unconstrained && matches!(nodes[prior], Node::Start(_) | Node::End(_)) {
            continue;
        }
        if !anchor(nodes[prior], position.offset, position.length) {
            continue;
        }
        if result.insert(prior, position.offset) {
            push(stack, prior, work)?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Default)]
struct Iteration {
    position: usize,
    progressed: bool,
}
#[derive(Clone, Copy)]
enum Undo {
    Slot(usize, Option<usize>),
    Previous(usize, Option<usize>),
    Iteration(usize, Iteration),
    Branch(usize),
}
struct Trace {
    slots: Vec<Option<usize>>,
    previous: Vec<Option<usize>>,
    iterations: Vec<Iteration>,
    seen: Vec<bool>,
    undo: Vec<Undo>,
}
impl Trace {
    async fn restore(&mut self, work: &mut Work, cancel: &Cancel) -> Result<Option<usize>, Error> {
        while let Some(undo) = self.undo.pop() {
            work.checkpoint(cancel).await?;
            match undo {
                Undo::Slot(slot, old) => self.slots[slot] = old,
                Undo::Previous(slot, old) => self.previous[slot] = old,
                Undo::Iteration(id, old) => self.iterations[id] = old,
                Undo::Branch(next) => return Ok(Some(next)),
            }
        }
        Ok(None)
    }
    fn iteration(&mut self, id: usize, value: Iteration, work: &mut Work) -> Result<(), Error> {
        push(
            &mut self.undo,
            Undo::Iteration(id, self.iterations[id]),
            work,
        )?;
        self.iterations[id] = value;
        Ok(())
    }
    // Empty optional closes restore the last completed nonempty register set,
    // including enclosing and nested groups. Unmarked closes still overwrite.
    async fn save(
        &mut self,
        slot: usize,
        position: usize,
        optional: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        push(&mut self.undo, Undo::Slot(slot, self.slots[slot]), work)?;
        self.slots[slot] = Some(position);
        if slot.is_multiple_of(2) {
            push(
                &mut self.undo,
                Undo::Slot(slot + 1, self.slots[slot + 1]),
                work,
            )?;
            self.slots[slot + 1] = None;
            return Ok(());
        }
        let nonempty = self.slots[slot - 1].is_some_and(|start| start < position);
        if !nonempty && (!optional || self.previous[slot - 1].is_none()) {
            return Ok(());
        }
        for index in 0..self.slots.len() {
            work.checkpoint(cancel).await?;
            if nonempty {
                push(
                    &mut self.undo,
                    Undo::Previous(index, self.previous[index]),
                    work,
                )?;
                self.previous[index] = self.slots[index];
            } else {
                push(&mut self.undo, Undo::Slot(index, self.slots[index]), work)?;
                self.slots[index] = self.previous[index];
            }
        }
        Ok(())
    }
    async fn step(
        &mut self,
        nodes: &[Node],
        index: usize,
        position: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<usize>, Error> {
        let seen = self.seen[index];
        self.seen[index] = true;
        if let Node::Repeat { next, .. } = nodes[index]
            && seen
        {
            return Ok((!self.iterations[index].progressed).then_some(next));
        }
        if seen {
            return Ok(None);
        }
        match nodes[index] {
            Node::Split(left, right) => {
                push(&mut self.undo, Undo::Branch(right), work)?;
                Ok(Some(left))
            }
            Node::Repeat { body, next } => {
                let old = self.iterations[index];
                self.iteration(
                    index,
                    Iteration {
                        position,
                        progressed: old.progressed || position > old.position,
                    },
                    work,
                )?;
                push(&mut self.undo, Undo::Branch(next), work)?;
                Ok(Some(body))
            }
            Node::Begin { repeat, next } => {
                self.iteration(
                    repeat,
                    Iteration {
                        position,
                        progressed: false,
                    },
                    work,
                )?;
                Ok(Some(next))
            }
            Node::Save(slot, next) | Node::OptionalSave(slot, next) => {
                self.save(
                    slot,
                    position,
                    matches!(nodes[index], Node::OptionalSave(..)),
                    work,
                    cancel,
                )
                .await?;
                Ok(Some(next))
            }
            Node::Start(next) | Node::End(next) => Ok(Some(next)),
            _ => Ok(None),
        }
    }
}
async fn captures(
    nodes: &[Node],
    start: usize,
    count: usize,
    reachable: &Reachable,
    span: (usize, usize),
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<Option<(usize, usize)>>, Error> {
    let count = count.checked_add(1).ok_or(2)?;
    let mut trace = Trace {
        slots: initialized(count.checked_mul(2).ok_or(2)?, None, work, cancel).await?,
        previous: initialized(count.checked_mul(2).ok_or(2)?, None, work, cancel).await?,
        iterations: initialized(nodes.len(), Iteration::default(), work, cancel).await?,
        seen: initialized(nodes.len(), false, work, cancel).await?,
        undo: Vec::new(),
    };
    let mut index = start;
    let mut position = span.0;
    while index != 0 || position != span.1 {
        work.checkpoint(cancel).await?;
        if !reachable.get(index, position) {
            index = trace.restore(work, cancel).await?.ok_or(2)?;
            continue;
        }
        if let Node::Consume(_, next) = nodes[index] {
            position += 1;
            index = next;
            trace.undo.clear();
            for seen in &mut trace.seen {
                work.checkpoint(cancel).await?;
                *seen = false;
            }
            continue;
        }
        index = match trace.step(nodes, index, position, work, cancel).await? {
            Some(next) => next,
            None => trace.restore(work, cancel).await?.ok_or(2)?,
        };
    }
    let mut result = slots(count, None, work)?;
    result.push(Some(span));
    for pair in trace.slots[2..].as_chunks::<2>().0 {
        work.checkpoint(cancel).await?;
        result.push(pair[0].zip(pair[1]));
    }
    Ok(result)
}

pub(super) type Captures = Vec<Option<(usize, usize)>>;

pub(super) async fn matches(
    pattern: &Pattern,
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<Captures>, Error> {
    ascii(pattern, value, work, cancel).await?;
    let (nodes, start, count) = compile(pattern, work, cancel).await?;
    let Some(span) = longest(&nodes, start, pattern, value, work, cancel).await? else {
        return Ok(None);
    };
    if count == 0 {
        let mut result = slots(1, None, work)?;
        result.push(Some(span));
        return Ok(Some(result));
    }
    // Assertions constrain their epsilon suffix, not the whole matching path.
    // Prefer the original accepting terminal over an assertion-derived terminal
    // at the same span; retain ordinary branch order inside either terminal.
    let mut reachable = reachability(&nodes, pattern, value, span, true, work, cancel).await?;
    if !reachable.get(start, span.0) {
        reachable = reachability(&nodes, pattern, value, span, false, work, cancel).await?;
    }
    captures(&nodes, start, count, &reachable, span, work, cancel)
        .await
        .map(Some)
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
    fn bash_capture_order_and_leftmost_longest_spans() {
        for (source, value, expected) in [
            ("(a|aa)(a?)", "aa", vec!["aa", "a", "a"]),
            ("(a*){2,3}", "a", vec!["a", "a"]),
            ("((a*){2,3}){2}", "a", vec!["a", "", ""]),
            ("(a(b*)?){2,3}", "aba", vec!["aba", "a", ""]),
            ("(a*){2,}", "a", vec!["a", "a"]),
            ("((a)*){2,}", "a", vec!["a", "a", "a"]),
            ("((a*)|b){2,3}", "ab", vec!["ab", "b", "a"]),
            ("(|a)a?", "a", vec!["a", "a"]),
            ("(|aa+){1,3}", "aa", vec!["aa", ""]),
            ("(a|)a?", "a", vec!["a", "a"]),
            ("(()|a)a?", "a", vec!["a", "", ""]),
            ("(a*){2}", "a", vec!["a", ""]),
            ("(a*){1,3}", "a", vec!["a", ""]),
            ("((a$)|a)", "a", vec!["a", "a", ""]),
            ("((a*)|a)", "a", vec!["a", "a", "a"]),
            ("((a*)$|a$)", "a", vec!["a", "a", "a"]),
            ("(a*)(a*)", "aa", vec!["aa", "aa", ""]),
            ("(a|aa)*", "aa", vec!["aa", "a"]),
            ("(a?)*", "aa", vec!["aa", "a"]),
            ("(a?)*", "", vec!["", ""]),
            ("(a*)*", "aa", vec!["aa", "aa"]),
            ("(a*)+", "aa", vec!["aa", "aa"]),
            ("(a*){1,3}", "aa", vec!["aa", ""]),
            ("^(()|a?)*$", "aa", vec!["aa", "a", ""]),
            ("((a)|(b))*", "aba", vec!["aba", "a", "a", "b"]),
            ("(a(b)?)*", "aba", vec!["aba", "a", "b"]),
            ("((a*)*)", "aa", vec!["aa", "aa", "aa"]),
            ("a|aa", "xaa", vec!["aa"]),
            ("[0-9]+", "x12z345", vec!["12"]),
            ("(a)?(b*)", "z", vec!["", "", ""]),
        ] {
            let pattern = self::pattern(source);
            let mut work = Work::new(10_000_000, 10_000_000, 16);
            let ranges = finish(matches(&pattern, value, &mut work, &Cancel::new()))
                .unwrap_or_else(|_| panic!("capture failed: {source:?} on {value:?}"))
                .unwrap();
            let actual: Vec<_> = ranges
                .into_iter()
                .map(|range| range.map_or("", |(start, end)| &value[start..end]))
                .collect();
            assert_eq!(actual, expected, "{source:?} on {value:?}");
        }
    }
    #[test]
    fn counted_nullable_repeats_preserve_current_enclosing_capture() {
        for (source, value, expected) in [
            ("((a*|b){2,3})*", "bb", vec!["bb", "b", "b"]),
            ("((a*|b){2,3})*", "bbb", vec!["bbb", "b", "b"]),
            ("(((a*)|b){2,3})*", "bb", vec!["bb", "b", "b", ""]),
            ("(((a*)|b){2,3})*", "bbb", vec!["bbb", "b", "b", ""]),
            ("((a*|b){3,4})*", "bb", vec!["bb", "b", "b"]),
            ("((a*|b){3,4})*", "bbb", vec!["bbb", "b", "b"]),
            ("((a?|b){2,3})*", "bb", vec!["bb", "b", "b"]),
            ("((a?|b){2,3})*", "bbb", vec!["bbb", "b", "b"]),
        ] {
            let pattern = self::pattern(source);
            let mut work = Work::new(10_000_000, 10_000_000, 16);
            let ranges = finish(matches(&pattern, value, &mut work, &Cancel::new()))
                .unwrap_or_else(|_| panic!("capture failed: {source:?} on {value:?}"))
                .unwrap();
            let actual: Vec<_> = ranges
                .into_iter()
                .map(|range| range.map_or("", |(start, end)| &value[start..end]))
                .collect();
            assert_eq!(actual, expected, "{source:?} on {value:?}");
        }
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
    fn cancel_reconstruction(trace: bool) {
        let pattern = pattern("(a?)*");
        let text = "a".repeat(32768);
        let span = (0, text.len());
        let cancel = Cancel::new();
        let mut work = Work::new(100_000_000, 10_000_000, 16);
        let (nodes, start, count) = finish(compile(&pattern, &mut work, &cancel))
            .unwrap_or_else(|_| panic!("fixture must compile"));
        let reachable = trace.then(|| {
            finish(reachability(
                &nodes, &pattern, &text, span, true, &mut work, &cancel,
            ))
            .unwrap_or_else(|_| panic!("fixture span must be reachable"))
        });
        let executor = Executor::new();
        let child_cancel = cancel.clone();
        let job = executor.spawn(async move {
            let mut work = Work::new(100_000_000, 10_000_000, 16);
            let result = match reachable {
                Some(reachable) => captures(
                    &nodes,
                    start,
                    count,
                    &reachable,
                    span,
                    &mut work,
                    &child_cancel,
                )
                .await
                .map(|_| ()),
                None => reachability(
                    &nodes,
                    &pattern,
                    &text,
                    span,
                    true,
                    &mut work,
                    &child_cancel,
                )
                .await
                .map(|_| ()),
            };
            match result {
                Err(Error::Status(status)) => status,
                _ => panic!("capture reconstruction must be interrupted"),
            }
        });
        executor.drive(1);
        assert!(!job.is_finished());
        cancel.cancel();
        for _ in 0..16 {
            executor.drive(1);
        }
        assert_eq!(job.now_or_never(), Some(130));
        assert_eq!(executor.drive(64).pending, 0);
    }
    #[test]
    fn capture_reachability_and_trace_both_yield_and_cancel() {
        cancel_reconstruction(false);
        cancel_reconstruction(true);
    }
    #[test]
    fn capture_reconstruction_admits_storage_before_allocating() {
        let pattern = pattern("(a?)*");
        let cancel = Cancel::new();
        let mut work = Work::new(100_000, 100_000, 16);
        let (nodes, start, count) = finish(compile(&pattern, &mut work, &cancel))
            .unwrap_or_else(|_| panic!("fixture must compile"));
        let reachable = finish(reachability(
            &nodes,
            &pattern,
            "aa",
            (0, 2),
            true,
            &mut work,
            &cancel,
        ))
        .unwrap_or_else(|_| panic!("fixture span must be reachable"));
        let mut work = Work::new(100_000, 0, 16);
        assert!(matches!(
            finish(reachability(
                &nodes,
                &pattern,
                "aa",
                (0, 2),
                true,
                &mut work,
                &cancel
            )),
            Err(Error::Status(2))
        ));
        assert!(matches!(
            finish(captures(
                &nodes,
                start,
                count,
                &reachable,
                (0, 2),
                &mut work,
                &cancel
            )),
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
                Ok(value) => i32::from(value.is_none()),
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
