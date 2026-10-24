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
    expand::{
        Error, Work,
        pattern::{Pattern, classes::Named},
    },
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
    let named = Named::parse(&name[..len]).ok_or(2)?;
    Ok(('\0', Some(named)))
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
                    named.map_or(low == ch, |named| named.matches(ch, false))
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
fn forward(node: Node) -> Option<usize> {
    match node {
        Node::Save(_, next) | Node::OptionalSave(_, next) | Node::Begin { next, .. } => Some(next),
        _ => None,
    }
}

// Save and Begin nodes only forward to `next` and never test the position, so
// they share their target's state. Whole-span scans and reachability run over
// the remaining nodes once, instead of revisiting every capture node per byte.
// Capture reconstruction retains their register and repeat effects separately.
struct Graph<'a> {
    nodes: &'a [Node],
    columns: Vec<usize>,
    kept: Vec<usize>,
    consumers: Vec<usize>,
    reverse: Reverse,
}
async fn graph<'a>(
    nodes: &'a [Node],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Graph<'a>, Error> {
    let mut columns = slots(nodes.len(), 0usize, work)?;
    let mut kept = Vec::new();
    let mut consumers = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        work.checkpoint(cancel).await?;
        // Compiled continuations point at earlier nodes, already resolved.
        if let Some(next) = forward(*node)
            && next < index
        {
            columns.push(columns[next]);
            continue;
        }
        columns.push(kept.len());
        push(&mut kept, index, work)?;
        if matches!(node, Node::Consume(..)) {
            push(&mut consumers, index, work)?;
        }
    }
    let mut heads = initialized(nodes.len(), None, work, cancel).await?;
    let mut edges = Vec::new();
    for &index in &kept {
        let (left, right) = epsilon(nodes[index]);
        for next in left.into_iter().chain(right) {
            work.checkpoint(cancel).await?;
            let edge = push(&mut edges, (index, heads[kept[columns[next]]]), work)?;
            heads[kept[columns[next]]] = Some(edge);
        }
    }
    Ok(Graph {
        nodes,
        columns,
        kept,
        consumers,
        reverse: Reverse { heads, edges },
    })
}
async fn closure(
    graph: &Graph<'_>,
    states: &mut [usize],
    stack: &mut Vec<usize>,
    candidate: (usize, usize),
    position: std::ops::Range<usize>,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    let (seed, origin) = candidate;
    let seed = graph.kept[graph.columns[seed]];
    if states[seed] <= origin {
        return Ok(());
    }
    states[seed] = origin;
    push(stack, seed, work)?;
    while let Some(index) = stack.pop() {
        work.checkpoint(cancel).await?;
        if !anchor(graph.nodes[index], position.start, position.end) {
            continue;
        }
        let origin = states[index];
        let (left, right) = epsilon(graph.nodes[index]);
        for next in left.into_iter().chain(right) {
            let next = graph.kept[graph.columns[next]];
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
    graph: &Graph<'_>,
    start: usize,
    pattern: &Pattern,
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Option<(usize, usize)>, Error> {
    let count = graph.nodes.len();
    let mut current = initialized(count, usize::MAX, work, cancel).await?;
    let mut next = initialized(count, usize::MAX, work, cancel).await?;
    let mut stack = slots(count, 0usize, work)?;
    let mut found = None;
    for position in 0..=value.len() {
        closure(
            graph,
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
        // Closures only write kept nodes; skipped entries stay unset.
        for &index in &graph.kept {
            work.checkpoint(cancel).await?;
            next[index] = usize::MAX;
        }
        for &index in &graph.consumers {
            work.checkpoint(cancel).await?;
            let Node::Consume(atom, destination) = graph.nodes[index] else {
                continue;
            };
            if current[index] == usize::MAX {
                continue;
            }
            if !atom_matches(atom, char::from(*ch), pattern, work, cancel).await? {
                continue;
            }
            closure(
                graph,
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
// Rows hold kept nodes only; look up any node through `Graph::columns`.
async fn reachability(
    graph: &Graph<'_>,
    pattern: &Pattern,
    value: &str,
    span: (usize, usize),
    terminal_unconstrained: bool,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Reachable, Error> {
    let width = graph.kept.len();
    let count = (span.1 - span.0 + 1).checked_mul(width).ok_or(2)?;
    let bits = initialized(count.div_ceil(64), 0u64, work, cancel).await?;
    let mut result = Reachable {
        bits,
        width,
        begin: span.0,
    };
    let mut stack = slots(width, 0usize, work)?;
    for position in (span.0..=span.1).rev() {
        if position == span.1 {
            result.insert(0, position);
            stack.push(0);
        }
        for &index in &graph.consumers {
            work.checkpoint(cancel).await?;
            let Node::Consume(atom, next) = graph.nodes[index] else {
                continue;
            };
            if position == span.1 || !result.get(graph.columns[next], position + 1) {
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
            result.insert(graph.columns[index], position);
            stack.push(index);
        }
        reverse_closure(
            graph,
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
    graph: &Graph<'_>,
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
            edge = graph.reverse.heads[stack.pop().ok_or(2)?];
            continue;
        };
        let (prior, previous) = graph.reverse.edges[id];
        edge = previous;
        let node = graph.nodes[prior];
        if position.unconstrained && matches!(node, Node::Start(_) | Node::End(_)) {
            continue;
        }
        if !anchor(node, position.offset, position.length) {
            continue;
        }
        if result.insert(graph.columns[prior], position.offset) {
            push(stack, prior, work)?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Default)]
struct CaptureVisit {
    order: usize,
    position: usize,
}
struct CaptureChain {
    next: usize,
    visit: CaptureVisit,
}
// Without OptionalSave, snapshots have no reader. Keep each owned Save chain's
// last visit instead of replaying its register writes at every input byte.
struct CaptureChains {
    owners: Vec<usize>,
    chains: Vec<CaptureChain>,
    order: usize,
}
impl CaptureChains {
    async fn new(
        nodes: &[Node],
        start: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<Self>, Error> {
        for node in nodes {
            work.checkpoint(cancel).await?;
            if matches!(node, Node::OptionalSave(..)) {
                return Ok(None);
            }
        }
        let mut incoming = initialized(nodes.len(), 0usize, work, cancel).await?;
        incoming[start] = 1;
        for node in nodes {
            let (left, right) = match *node {
                Node::Consume(_, next) => (Some(next), None),
                node => epsilon(node),
            };
            for next in left.into_iter().chain(right) {
                work.checkpoint(cancel).await?;
                incoming[next] = incoming[next].checked_add(1).ok_or(2)?;
            }
        }
        let mut owners = initialized(nodes.len(), usize::MAX, work, cancel).await?;
        let mut chains = Vec::new();
        for (index, node) in nodes.iter().enumerate() {
            work.checkpoint(cancel).await?;
            let Node::Save(_, next) = *node else {
                continue;
            };
            // A shared successor starts another chain. No branch or root can
            // enter an interior, so marking its head preserves seen semantics.
            owners[index] = if incoming[next] == 1 && owners[next] != usize::MAX {
                owners[next]
            } else {
                push(
                    &mut chains,
                    CaptureChain {
                        next,
                        visit: CaptureVisit::default(),
                    },
                    work,
                )?
            };
        }
        let bytes = incoming
            .capacity()
            .checked_mul(size_of::<usize>())
            .ok_or(2)?;
        drop(incoming);
        work.release_storage(bytes);
        Ok(Some(Self {
            owners,
            chains,
            order: 0,
        }))
    }
    fn visit(
        &mut self,
        index: usize,
        position: usize,
        undo: &mut Vec<Undo>,
        work: &mut Work,
    ) -> Result<usize, Error> {
        let id = self.owners[index];
        let chain = &mut self.chains[id];
        push(undo, Undo::Chain(id, chain.visit), work)?;
        self.order = self.order.checked_add(1).ok_or(2)?;
        chain.visit = CaptureVisit {
            order: self.order,
            position,
        };
        Ok(chain.next)
    }
    async fn resolve(
        &self,
        nodes: &[Node],
        slots: &mut [Option<usize>],
        written: &mut [usize],
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        // Continuations have lower indices. At equal visit order, the first
        // write encountered here was the last one executed inside the chain.
        for (index, node) in nodes.iter().enumerate() {
            work.checkpoint(cancel).await?;
            let Node::Save(slot, _) = *node else {
                continue;
            };
            let visit = self.chains[self.owners[index]].visit;
            Self::resolve_slot(slots, written, slot, Some(visit.position), visit.order);
            if slot.is_multiple_of(2) {
                Self::resolve_slot(slots, written, slot + 1, None, visit.order);
            }
        }
        Ok(())
    }
    fn resolve_slot(
        slots: &mut [Option<usize>],
        written: &mut [usize],
        slot: usize,
        value: Option<usize>,
        order: usize,
    ) {
        if order <= written[slot] {
            return;
        }
        written[slot] = order;
        slots[slot] = value;
    }
}

#[derive(Clone, Copy, Default)]
struct Iteration {
    position: usize,
    progressed: bool,
}
#[derive(Clone, Copy)]
enum Undo {
    Slot(usize, Option<usize>),
    Restored(usize, Option<usize>),
    Previous(usize, Option<usize>),
    Logged,
    Changed(usize),
    Iteration(usize, Iteration),
    Branch(usize),
    Chain(usize, CaptureVisit),
}
// `previous` is the register set at the last nonempty close. Instead of
// copying every register there, `log[changed..]` lists each register written
// since, so snapshots and restorations visit only registers that may differ.
struct Trace {
    chains: Option<CaptureChains>,
    slots: Vec<Option<usize>>,
    previous: Vec<Option<usize>>,
    log: Vec<usize>,
    changed: usize,
    // Input-position stamps (position + 1) avoid clearing per character.
    marked: Vec<usize>,
    iterations: Vec<Iteration>,
    seen: Vec<usize>,
    undo: Vec<Undo>,
}
impl Trace {
    async fn restore(&mut self, work: &mut Work, cancel: &Cancel) -> Result<Option<usize>, Error> {
        while let Some(undo) = self.undo.pop() {
            work.checkpoint(cancel).await?;
            match undo {
                Undo::Slot(slot, old) => {
                    self.slots[slot] = old;
                    self.log.pop();
                }
                Undo::Restored(slot, old) => self.slots[slot] = old,
                Undo::Previous(slot, old) => self.previous[slot] = old,
                Undo::Logged => {
                    self.log.pop();
                }
                Undo::Changed(old) => self.changed = old,
                Undo::Iteration(id, old) => self.iterations[id] = old,
                Undo::Branch(next) => return Ok(Some(next)),
                Undo::Chain(id, old) => self.chains.as_mut().ok_or(2)?.chains[id].visit = old,
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
    fn write(&mut self, slot: usize, value: Option<usize>, work: &mut Work) -> Result<(), Error> {
        push(&mut self.undo, Undo::Slot(slot, self.slots[slot]), work)?;
        push(&mut self.log, slot, work)?;
        self.slots[slot] = value;
        Ok(())
    }
    fn log_from(&mut self, end: usize, work: &mut Work) -> Result<(), Error> {
        push(&mut self.undo, Undo::Changed(self.changed), work)?;
        self.changed = end;
        Ok(())
    }
    async fn snapshot(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        let end = self.log.len();
        for index in self.changed..end {
            work.checkpoint(cancel).await?;
            let slot = self.log[index];
            if self.previous[slot] == self.slots[slot] {
                continue;
            }
            push(
                &mut self.undo,
                Undo::Previous(slot, self.previous[slot]),
                work,
            )?;
            self.previous[slot] = self.slots[slot];
        }
        self.log_from(end, work)
    }
    // Restore changed registers of closed groups from the snapshot. Starts go
    // first so each pair's open state is read before its end is restored.
    async fn rewind(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        let end = self.log.len();
        for ends in [false, true] {
            for index in self.changed..end {
                work.checkpoint(cancel).await?;
                let slot = self.log[index];
                if slot % 2 == usize::from(ends) {
                    self.rewind_slot(slot, work)?;
                }
            }
        }
        self.log_from(end, work)
    }
    fn rewind_slot(&mut self, slot: usize, work: &mut Work) -> Result<(), Error> {
        if self.previous[slot] == self.slots[slot] {
            return Ok(());
        }
        if self.slots[slot / 2 * 2 + 1].is_none() {
            push(&mut self.undo, Undo::Logged, work)?;
            push(&mut self.log, slot, work)?;
            return Ok(());
        }
        push(&mut self.undo, Undo::Restored(slot, self.slots[slot]), work)?;
        self.slots[slot] = self.previous[slot];
        Ok(())
    }
    // A consumed character ends backtracking. Once the log outgrows twice the
    // registers, keep one entry per register that still differs from the
    // snapshot. Each compaction is paid for by the appends since the last one.
    async fn compact(
        &mut self,
        position: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        if self.log.len() <= self.slots.len().saturating_mul(2) {
            return Ok(());
        }
        let stamp = position + 1;
        let mut kept = 0;
        for index in self.changed..self.log.len() {
            work.checkpoint(cancel).await?;
            let slot = self.log[index];
            if self.marked[slot] == stamp || self.previous[slot] == self.slots[slot] {
                continue;
            }
            self.marked[slot] = stamp;
            self.log[kept] = slot;
            kept += 1;
        }
        self.log.truncate(kept);
        self.changed = 0;
        Ok(())
    }
    // Empty optional closes restore the last completed nonempty register set,
    // without replacing an enclosing group that is still open. Unmarked closes overwrite.
    async fn save(
        &mut self,
        slot: usize,
        position: usize,
        optional: bool,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        self.write(slot, Some(position), work)?;
        if slot.is_multiple_of(2) {
            return self.write(slot + 1, None, work);
        }
        if self.slots[slot - 1].is_some_and(|start| start < position) {
            return self.snapshot(work, cancel).await;
        }
        if !optional || self.previous[slot - 1].is_none() {
            return Ok(());
        }
        self.rewind(work, cancel).await
    }
    async fn capture_node(
        &mut self,
        index: usize,
        node: Node,
        position: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<usize>, Error> {
        if let Some(chains) = &mut self.chains {
            return chains
                .visit(index, position, &mut self.undo, work)
                .map(Some);
        }
        let (Node::Save(slot, next) | Node::OptionalSave(slot, next)) = node else {
            return Err(2.into());
        };
        self.save(
            slot,
            position,
            matches!(node, Node::OptionalSave(..)),
            work,
            cancel,
        )
        .await?;
        Ok(Some(next))
    }
    async fn step(
        &mut self,
        nodes: &[Node],
        index: usize,
        position: usize,
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<Option<usize>, Error> {
        let seen = self.seen[index] == position + 1;
        self.seen[index] = position + 1;
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
            node @ (Node::Save(..) | Node::OptionalSave(..)) => {
                self.capture_node(index, node, position, work, cancel).await
            }
            Node::Start(next) | Node::End(next) => Ok(Some(next)),
            _ => Ok(None),
        }
    }
}
async fn captures(
    graph: &Graph<'_>,
    start: usize,
    count: usize,
    reachable: &Reachable,
    span: (usize, usize),
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<Option<(usize, usize)>>, Error> {
    let count = count.checked_add(1).ok_or(2)?;
    let nodes = graph.nodes;
    let chains = CaptureChains::new(nodes, start, work, cancel).await?;
    let snapshot_slots = if chains.is_some() {
        0
    } else {
        count.checked_mul(2).ok_or(2)?
    };
    let mut trace = Trace {
        chains,
        slots: initialized(count.checked_mul(2).ok_or(2)?, None, work, cancel).await?,
        previous: initialized(snapshot_slots, None, work, cancel).await?,
        log: Vec::new(),
        changed: 0,
        marked: initialized(count.checked_mul(2).ok_or(2)?, 0, work, cancel).await?,
        iterations: initialized(nodes.len(), Iteration::default(), work, cancel).await?,
        seen: initialized(nodes.len(), 0, work, cancel).await?,
        undo: Vec::new(),
    };
    let mut index = start;
    let mut position = span.0;
    while index != 0 || position != span.1 {
        work.checkpoint(cancel).await?;
        if !reachable.get(graph.columns[index], position) {
            index = trace.restore(work, cancel).await?.ok_or(2)?;
            continue;
        }
        if let Node::Consume(_, next) = nodes[index] {
            position += 1;
            index = next;
            trace.undo.clear();
            trace.compact(position, work, cancel).await?;
            continue;
        }
        index = match trace.step(nodes, index, position, work, cancel).await? {
            Some(next) => next,
            None => trace.restore(work, cancel).await?.ok_or(2)?,
        };
    }
    if let Some(chains) = &trace.chains {
        chains
            .resolve(nodes, &mut trace.slots, &mut trace.marked, work, cancel)
            .await?;
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
    let graph = graph(&nodes, work, cancel).await?;
    let Some(span) = longest(&graph, start, pattern, value, work, cancel).await? else {
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
    let mut reachable = reachability(&graph, pattern, value, span, true, work, cancel).await?;
    if !reachable.get(graph.columns[start], span.0) {
        reachable = reachability(&graph, pattern, value, span, false, work, cancel).await?;
    }
    captures(&graph, start, count, &reachable, span, work, cancel)
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
    fn assert_captures(source: &str, value: &str, expected: &[&str]) {
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
            assert_captures(source, value, &expected);
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
            assert_captures(source, value, &expected);
        }
    }
    fn status(source: &str, value: &str) -> bool {
        let pattern = self::pattern(source);
        let mut work = Work::new(10_000_000, 10_000_000, 16);
        finish(matches(&pattern, value, &mut work, &Cancel::new()))
            .unwrap_or_else(|_| panic!("match failed: {source:?} on {value:?}"))
            .is_some()
    }
    #[test]
    fn consuming_suffix_inside_repeated_nullable_count_keeps_match_status() {
        for source in [
            "(((a*|b){2,3})*b)*",
            "((((a*)|b){2,3})*b)*",
            "(((a*|b){3,4})*b)*",
            "(((a?|b){2,3})*b)*",
            "(((a*|b){2,3})*[ab])+",
            "(((a*|b){2,3})*(b)){1,3}",
            "(((a*|b){2,3})*|b)*",
            "(((a*|b){2,3})*b){1}",
            "((((a*|b){2,3})*b){0})*",
        ] {
            assert!(status(source, "bbbb"), "{source}");
        }
        for value in ["", "c", "ac"] {
            assert!(!status("^(((a*|b){2,3})*b)+$", value), "{value:?}");
        }
    }
    // Register snapshots must not copy every capture at each group close.
    fn reconstruction_steps(groups: usize) -> usize {
        let source = "(".repeat(groups) + "a" + &")".repeat(groups) + "*";
        let pattern = self::pattern(&source);
        let value = "a".repeat(256);
        let budget = 100_000_000;
        let mut work = Work::new(budget, 100_000_000, 16);
        let captures = finish(matches(&pattern, &value, &mut work, &Cancel::new()))
            .unwrap_or_else(|_| panic!("{groups} nested groups must match"))
            .unwrap();
        assert_eq!(captures.len(), groups + 1);
        budget - work.remaining
    }
    // Main matches these under one command's default work and storage; the
    // capture pipeline must too, without a larger budget.
    #[test]
    fn deep_nested_group_captures_fit_default_command_work() {
        for groups in [48, 64] {
            let source = "(".repeat(groups) + "a" + &")".repeat(groups) + "*";
            let pattern = self::pattern(&source);
            let value = "a".repeat(2048);
            let mut work = crate::interpreter::command_work(&crate::interpreter::Limits::default());
            let captures = finish(matches(&pattern, &value, &mut work, &Cancel::new()))
                .unwrap_or_else(|_| panic!("{groups} nested groups exhausted default work"))
                .unwrap();
            assert_eq!(captures[0], Some((0, 2048)));
            assert_eq!(captures[1], Some((2047, 2048)));
        }
    }
    #[test]
    fn larger_nested_group_captures_fit_default_command_work() {
        for (groups, length) in [
            (64, 3072),
            (48, 4096),
            (32, 8192),
            (16, 16384),
            (4, 65536),
            (1, 65536),
        ] {
            let source = "(".repeat(groups) + "a" + &")".repeat(groups) + "*";
            let pattern = self::pattern(&source);
            let value = "a".repeat(length);
            let mut work = crate::interpreter::command_work(&crate::interpreter::Limits::default());
            let captures = finish(matches(&pattern, &value, &mut work, &Cancel::new()))
                .unwrap_or_else(|_| {
                    panic!("{groups} groups on {length} bytes exhausted default work")
                })
                .unwrap();
            assert_eq!(captures.len(), groups + 1);
            assert_eq!(captures[0], Some((0, length)));
            assert!(
                captures[1..]
                    .iter()
                    .all(|pair| *pair == Some((length - 1, length)))
            );
        }
    }
    #[test]
    fn ordinary_save_chains_bound_reconstruction_work() {
        for (groups, length) in [
            (64, 3072),
            (48, 4096),
            (32, 8192),
            (16, 16384),
            (4, 65536),
            (1, 65536),
        ] {
            let source = "(".repeat(groups) + "a" + &")".repeat(groups) + "*";
            let pattern = self::pattern(&source);
            let value = "a".repeat(length);
            let cancel = Cancel::new();
            let mut work = Work::new(100_000_000, 100_000_000, 16);
            finish(ascii(&pattern, &value, &mut work, &cancel))
                .unwrap_or_else(|_| panic!("profile stage failed"));
            let (nodes, start, count) = finish(compile(&pattern, &mut work, &cancel))
                .unwrap_or_else(|_| panic!("profile stage failed"));
            let compiled = work.remaining;
            let graph = finish(graph(&nodes, &mut work, &cancel))
                .unwrap_or_else(|_| panic!("profile stage failed"));
            let graphed = work.remaining;
            let span = finish(longest(&graph, start, &pattern, &value, &mut work, &cancel))
                .unwrap_or_else(|_| panic!("profile stage failed"))
                .expect("profile matches");
            let scanned = work.remaining;
            let reachable = finish(reachability(
                &graph, &pattern, &value, span, true, &mut work, &cancel,
            ))
            .unwrap_or_else(|_| panic!("profile stage failed"));
            let reached = work.remaining;
            let captures = finish(captures(
                &graph, start, count, &reachable, span, &mut work, &cancel,
            ))
            .unwrap_or_else(|_| panic!("profile stage failed"));
            assert_eq!(captures[0], Some((0, length)));
            assert!(
                captures[1..]
                    .iter()
                    .all(|pair| *pair == Some((length - 1, length)))
            );
            assert!(reached - work.remaining < length * 5 + nodes.len() * 8);
            eprintln!(
                "PROFILE groups={groups} n={length} nodes={} kept={} compile={} graph={} scan={} reach={} reconstruction={} total={} storage={}",
                nodes.len(),
                graph.kept.len(),
                100_000_000 - compiled,
                compiled - graphed,
                graphed - scanned,
                scanned - reached,
                reached - work.remaining,
                100_000_000 - work.remaining,
                100_000_000 - work.storage_remaining
            );
        }
    }
    #[test]
    fn nested_group_reconstruction_is_linear_in_groups() {
        let small = reconstruction_steps(16);
        let large = reconstruction_steps(64);
        assert!(
            large < small * 6,
            "16 groups: {small} steps, 64 groups: {large}"
        );
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
            let graph = finish(graph(&nodes, &mut work, &cancel))
                .unwrap_or_else(|_| panic!("fixture graph must build"));
            finish(reachability(
                &graph, &pattern, &text, span, true, &mut work, &cancel,
            ))
            .unwrap_or_else(|_| panic!("fixture span must be reachable"))
        });
        let executor = Executor::new();
        let child_cancel = cancel.clone();
        let job = executor.spawn(async move {
            let mut work = Work::new(100_000_000, 10_000_000, 16);
            let Ok(graph) = graph(&nodes, &mut work, &child_cancel).await else {
                panic!("fixture graph must build before cancellation");
            };
            let result = match reachable {
                Some(reachable) => captures(
                    &graph,
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
                    &graph,
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
        let graph = finish(graph(&nodes, &mut work, &cancel))
            .unwrap_or_else(|_| panic!("fixture graph must build"));
        let reachable = finish(reachability(
            &graph,
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
                &graph,
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
                &graph,
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
