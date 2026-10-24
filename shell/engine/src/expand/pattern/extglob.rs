//! Full-pattern groups compiled to an epsilon-NFA, without backtracking.
use super::{Atom, Cancel, Error, Pattern, Work, admit_vec_slot};
use crate::expand::admit_vec_exact;

mod negative;

#[derive(Clone, Copy)]
enum Instruction {
    Consume(Atom, usize),
    Split(usize, usize),
    Jump(usize),
    Accept,
    Negate(usize, usize),
}

struct Group {
    choice: usize,
    arm: usize,
    exit: usize,
    repeat: usize,
    literal_depth: usize,
}

struct Compiler {
    code: Vec<Instruction>,
    groups: Vec<Group>,
    tail: usize,
}
impl Compiler {
    fn emit(&mut self, instruction: Instruction, work: &mut Work) -> Result<usize, Error> {
        admit_vec_slot(&mut self.code, work)?;
        let index = self.code.len();
        self.code.push(instruction);
        Ok(index)
    }

    fn open(&mut self, operator: char, work: &mut Work) -> Result<(), Error> {
        let exit = self.emit(Instruction::Accept, work)?;
        let choice = self.emit(Instruction::Accept, work)?;
        let arm = self.emit(Instruction::Accept, work)?;
        self.code[self.tail] = match operator {
            '!' => Instruction::Negate(choice, exit),
            '?' | '*' => Instruction::Split(choice, exit),
            _ => Instruction::Jump(choice),
        };
        self.code[choice] = Instruction::Jump(arm);
        let repeat = if matches!(operator, '*' | '+') {
            self.emit(Instruction::Split(choice, exit), work)?
        } else if operator == '!' {
            self.emit(Instruction::Accept, work)?
        } else {
            exit
        };
        admit_vec_slot(&mut self.groups, work)?;
        self.groups.push(Group {
            choice,
            arm,
            exit,
            repeat,
            literal_depth: 0,
        });
        self.tail = arm;
        Ok(())
    }

    fn alternative(&mut self, work: &mut Work) -> Result<(), Error> {
        let choice = self.emit(Instruction::Accept, work)?;
        let arm = self.emit(Instruction::Accept, work)?;
        let group = self.groups.last_mut().ok_or(2)?;
        self.code[self.tail] = Instruction::Jump(group.repeat);
        self.code[group.choice] = Instruction::Split(group.arm, choice);
        self.code[choice] = Instruction::Jump(arm);
        group.choice = choice;
        group.arm = arm;
        self.tail = arm;
        Ok(())
    }

    fn close(&mut self) -> Result<(), Error> {
        let group = self.groups.pop().ok_or(2)?;
        self.code[self.tail] = Instruction::Jump(group.repeat);
        self.tail = group.exit;
        Ok(())
    }

    fn consume(&mut self, atom: Atom, work: &mut Work) -> Result<(), Error> {
        let next = self.emit(Instruction::Accept, work)?;
        self.code[self.tail] = Instruction::Consume(atom, next);
        if matches!(atom, Atom::Star) {
            let consume = self.emit(Instruction::Consume(Atom::Any, self.tail), work)?;
            self.code[self.tail] = Instruction::Split(consume, next);
        }
        self.tail = next;
        Ok(())
    }
}

async fn group_boundaries(
    pattern: &Pattern,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<bool>, Error> {
    let mut paired = Vec::new();
    if !pattern.extglob {
        return Ok(paired);
    }
    admit_vec_exact(&mut paired, pattern.chars.len(), work)?;
    for _ in &pattern.chars {
        work.checkpoint(cancel).await?;
        paired.push(false);
    }
    let mut opens = Vec::new();
    let mut index = 0;
    while index < pattern.chars.len() {
        work.checkpoint(cancel).await?;
        index = boundary_next(pattern, index, &mut opens, &mut paired, work, cancel).await?;
    }
    Ok(paired)
}

async fn boundary_next(
    pattern: &Pattern,
    index: usize,
    opens: &mut Vec<usize>,
    paired: &mut [bool],
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    if pattern.active(index, '[') {
        if let Some((_, next)) = pattern.bracket(index + 1, work, cancel).await? {
            return Ok(next);
        }
        // An unmatched class invalidates containing groups, but stays literal
        // outside them. Later, independent groups may still be well formed.
        opens.clear();
        return Ok(index + 1);
    }
    if pattern.active(index, '(') {
        admit_vec_slot(opens, work)?;
        opens.push(index);
    }
    if pattern.active(index, ')')
        && let Some(open) = opens.pop()
    {
        paired[open] = true;
    }
    Ok(index + 1)
}

async fn compile(
    pattern: &Pattern,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<Vec<Instruction>, Error> {
    let paired = group_boundaries(pattern, work, cancel).await?;
    let mut compiler = Compiler {
        code: Vec::new(),
        groups: Vec::new(),
        tail: 0,
    };
    compiler.emit(Instruction::Accept, work)?;
    let mut index = 0;
    while index < pattern.chars.len() {
        work.checkpoint(cancel).await?;
        index = compile_next(pattern, &paired, index, &mut compiler, work, cancel).await?;
    }
    if !compiler.groups.is_empty() {
        return Err(2.into());
    }
    Ok(compiler.code)
}

async fn compile_next(
    pattern: &Pattern,
    paired: &[bool],
    index: usize,
    compiler: &mut Compiler,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    if pattern.extglob
        && let Some(operator) = pattern.group_operator(index)
    {
        if !paired[index + 1] {
            return literal_tail(pattern, index, compiler, work, cancel).await;
        }
        compiler.open(operator, work)?;
        return Ok(index + 2);
    }
    if let Some(group) = compiler.groups.last_mut() {
        if group.literal_depth == 0 && pattern.active(index, '|') {
            compiler.alternative(work)?;
            return Ok(index + 1);
        }
        if group.literal_depth == 0 && pattern.active(index, ')') {
            compiler.close()?;
            return Ok(index + 1);
        }
        if pattern.active(index, '(') {
            group.literal_depth = group.literal_depth.checked_add(1).ok_or(2)?;
        }
        if pattern.active(index, ')') {
            group.literal_depth -= 1;
        }
    }
    let (atom, next) = pattern.basic_atom(index, work, cancel).await?;
    compiler.consume(atom, work)?;
    Ok(next)
}

async fn literal_tail(
    pattern: &Pattern,
    start: usize,
    compiler: &mut Compiler,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<usize, Error> {
    for ch in &pattern.chars[start..] {
        work.checkpoint(cancel).await?;
        for _ in 0..ch.literal_prefix {
            work.checkpoint(cancel).await?;
            compiler.consume(Atom::Literal('\\'), work)?;
        }
        compiler.consume(Atom::Literal(ch.value), work)?;
    }
    Ok(pattern.chars.len())
}

struct States {
    live: Vec<bool>,
    pending: Vec<usize>,
}
impl States {
    async fn new(count: usize, work: &mut Work, cancel: &Cancel) -> Result<Self, Error> {
        let mut live = Vec::new();
        let mut pending = Vec::new();
        admit_vec_exact(&mut live, count, work)?;
        admit_vec_exact(&mut pending, count, work)?;
        for _ in 0..count {
            work.checkpoint(cancel).await?;
            live.push(false);
        }
        Ok(Self { live, pending })
    }

    fn insert(&mut self, index: usize) {
        if self.live[index] {
            return;
        }
        self.live[index] = true;
        self.pending.push(index);
    }

    async fn clear(&mut self, work: &mut Work, cancel: &Cancel) -> Result<(), Error> {
        self.pending.clear();
        for live in &mut self.live {
            work.checkpoint(cancel).await?;
            *live = false;
        }
        Ok(())
    }

    fn follow(&mut self, instruction: Instruction) {
        match instruction {
            Instruction::Jump(target) => self.insert(target),
            Instruction::Split(left, right) => {
                self.insert(left);
                self.insert(right);
            }
            _ => {}
        }
    }

    async fn close(
        &mut self,
        code: &[Instruction],
        work: &mut Work,
        cancel: &Cancel,
    ) -> Result<(), Error> {
        let mut index = 0;
        while index < self.pending.len() {
            work.checkpoint(cancel).await?;
            self.follow(code[self.pending[index]]);
            index += 1;
        }
        Ok(())
    }
}

pub(super) async fn matches(
    pattern: &Pattern,
    value: &str,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<bool, Error> {
    let code = compile(pattern, work, cancel).await?;
    for instruction in &code {
        work.checkpoint(cancel).await?;
        if matches!(instruction, Instruction::Negate(..)) {
            return negative::matches(pattern, &code, value, work, cancel).await;
        }
    }
    let mut current = States::new(code.len(), work, cancel).await?;
    let mut next = States::new(code.len(), work, cancel).await?;
    current.insert(0);
    current.close(&code, work, cancel).await?;
    for ch in value.chars() {
        work.checkpoint(cancel).await?;
        next.clear(work, cancel).await?;
        advance(pattern, &code, &current, &mut next, ch, work, cancel).await?;
        next.close(&code, work, cancel).await?;
        std::mem::swap(&mut current, &mut next);
    }
    for (index, instruction) in code.iter().enumerate() {
        work.checkpoint(cancel).await?;
        if current.live[index] && matches!(instruction, Instruction::Accept) {
            return Ok(true);
        }
    }
    Ok(false)
}

async fn advance(
    pattern: &Pattern,
    code: &[Instruction],
    current: &States,
    next: &mut States,
    value: char,
    work: &mut Work,
    cancel: &Cancel,
) -> Result<(), Error> {
    for (index, instruction) in code.iter().enumerate() {
        work.checkpoint(cancel).await?;
        if !current.live[index] {
            continue;
        }
        let Instruction::Consume(atom, target) = instruction else {
            continue;
        };
        if pattern.matches(atom, value, work, cancel).await? {
            next.insert(*target);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expand::Protection;
    use futures::FutureExt;

    fn pattern(source: &str) -> Pattern {
        let mut work = Work::new(usize::MAX, usize::MAX, 16);
        let mut pattern = Pattern::with_options(false, true);
        for ch in source.chars() {
            pattern
                .push(ch, Protection::None, &mut work)
                .unwrap_or_else(|_| panic!("pattern fits"));
        }
        pattern
    }

    fn finish<T>(future: impl std::future::Future<Output = T>) -> T {
        let mut future = Box::pin(future);
        let mut context = std::task::Context::from_waker(futures::task::noop_waker_ref());
        for _ in 0..16384 {
            if let std::task::Poll::Ready(value) = future.as_mut().poll(&mut context) {
                return value;
            }
        }
        panic!("bounded matcher did not finish");
    }

    fn assert_cases(cases: &[(&str, &str, bool)]) {
        for (source, value, expected) in cases {
            let mut work = Work::new(100000, 100000, 16);
            assert_eq!(
                finish(pattern(source).matches_full(value, &mut work, &Cancel::new())).ok(),
                Some(*expected),
                "{source}: {value}"
            );
        }
    }

    fn assert_cancelled_after_yield<T>(
        future: impl std::future::Future<Output = Result<T, Error>>,
        cancel: &Cancel,
    ) {
        let mut pending = Box::pin(future);
        assert!(pending.as_mut().now_or_never().is_none());
        cancel.cancel();
        assert!(matches!(finish(pending), Err(Error::Status(130))));
    }

    #[test]
    fn negative_groups_match_empty_nested_repeated_and_suffix_languages() {
        assert_cases(&[
            ("!(a)", "", true),
            ("!(a)", "a", false),
            ("!(a)", "b", true),
            ("!(*)", "", false),
            ("!(*)", "a", false),
            ("!()", "", false),
            ("!()", "a", true),
            ("!(a|b)", "ab", true),
            ("--!(help|verbose)", "--help", false),
            ("--!(help|verbose)", "--oops", true),
            ("!(*d)d", "d", true),
            ("!(a)d", "ad", false),
            ("!(a)d", "bd", true),
            ("@(!(a)|b)", "c", true),
            ("@(!(a))", "a", false),
            ("!(x)?", "ab", true),
            ("!(!(a))", "a", true),
            ("!(!(a))", "b", false),
            ("*(!(a))", "", true),
            ("+(!(a))", "", true),
            ("*(!(a))", "a", false),
            ("*(!(a))", "ab", true),
            ("!(x)+(ab)", "abab", true),
            ("!(z)*(a|aa)", "aaa", true),
            ("!(z)+(a)", "x", false),
            ("!([a-c]|x)", "é🙂", true),
            ("!([a-c]|x)", "a", false),
        ]);
    }

    #[test]
    fn nested_negative_groups_do_not_recurse_or_backtrack() {
        let source = format!("{}a{}", "!(".repeat(128), ")".repeat(128));
        let mut work = Work::new(1000000, 4000000, 16);
        assert_eq!(
            finish(pattern(&source).matches_full("a", &mut work, &Cancel::new())).ok(),
            Some(true)
        );
    }

    #[test]
    fn negative_storage_work_and_cancellation_fail_as_errors_not_misses() {
        let source = pattern("!(a|aa)*(!(b))");
        let cancel = Cancel::new();
        let mut denied = Work::new(1000000, 0, 16);
        assert!(matches!(
            finish(matches(&source, "abc", &mut denied, &cancel)),
            Err(Error::Status(2))
        ));
        let mut exhausted = Work::new(1000, 1000000, 16);
        assert!(matches!(
            finish(matches(&source, &"a".repeat(64), &mut exhausted, &cancel)),
            Err(Error::Status(2))
        ));
        let mut work = Work::new(10000000, 10000000, 16);
        assert_cancelled_after_yield(
            matches(&source, &"a".repeat(256), &mut work, &cancel),
            &cancel,
        );
    }

    #[test]
    fn negative_cost_is_bounded_for_overlapping_and_nullable_alternatives() {
        for length in [8, 16, 32, 64] {
            let source = pattern("!(*(a|aa|aaa|aaaa))z");
            let value = format!("{}z", "a".repeat(length));
            let mut work = Work::new(10000000, 10000000, 16);
            assert_eq!(
                finish(matches(&source, &value, &mut work, &Cancel::new())).ok(),
                Some(false)
            );
            let steps = 10000000 - work.remaining;
            let storage = 10000000 - work.storage_remaining;
            eprintln!("negative-cost length={length} steps={steps} storage={storage}");
            assert!(steps < 300 * (length + 2) * (length + 2));
            assert!(storage < 1000 * (length + 2) * (length + 2));
        }
    }

    #[test]
    fn positive_operators_nested_empty_and_nullable_cycles() {
        assert_cases(&[
            ("@(a|ab)c", "abc", true),
            ("?(@(a)|b)c", "c", true),
            ("+(a|aa)", "aaaa", true),
            ("+(a|aa)", "", false),
            ("*(a|aa)", "aaaa", true),
            ("*(a|aa)", "aaab", false),
            ("+()", "", true),
            ("*(|a)*(b|)", "aabb", true),
            ("*(|a)*(b|)", "aabz", false),
            ("@(?)+(?)", "é🙂", true),
            ("@([|]|[)])", ")", true),
        ]);
    }

    #[test]
    fn literal_parentheses_and_brackets_preserve_group_boundaries() {
        assert_cases(&[
            ("@(a(b)c|x)", "a(b)c", true),
            ("@(a(b|c)d|x)", "a(b|c)d", true),
            ("@(a((b|c))d|x)", "x", true),
            ("@(a(@(b|c))d|x)", "a(b)d", true),
            ("@([|a)", "a", false),
            ("@([|a)", "[", false),
            ("@([|a)", "@([|a)", true),
            ("@(@([|a)|b)", "b", false),
            ("@([a)|b])", ")", true),
            ("[@(a|b)", "[a", true),
            ("@(@(a)|[b)", "@(@(a)|[b)", true),
            ("@(@(a)|[b)", "@(a|[b)", false),
            ("@([a|b)@(x)", "@([a|b)@(x)", true),
            ("*(a", "zz(a", false),
            ("[a", "[a", true),
        ]);
    }

    #[test]
    fn malformed_group_suffix_retains_raw_backslashes() {
        assert_cases(&[
            (r"@([|a)\*", r"@([|a)\*", true),
            (r"@([|a)\*", "@([|a)*", false),
            (r"@([\]|x)", r"@([\]|x)", true),
            (r"@([\]|x)", "@([]|x)", false),
            (r"@([|a)\b", r"@([|a)\b", true),
            (r"@([|a)\\", r"@([|a)\\", true),
            (r"[\]|x", "[]|x", true),
            (r"@(\[|x)", "[", true),
            (r"@([\]]|x)", "]", true),
        ]);
    }

    #[test]
    fn malformed_group_quoted_spelling_is_idempotent() {
        for (prefix, quoted, value) in [
            ("", '*', r"@([|a)\*"),
            ("", 'b', "@([|a)b"),
            (r"\", '*', r"@([|a)\\*"),
            (r"\", '.', r"@([|a)\\."),
        ] {
            let mut source = pattern("@([|a)");
            let mut work = Work::new(100000, 100000, 16);
            for ch in prefix.chars() {
                source
                    .push(ch, Protection::None, &mut work)
                    .unwrap_or_else(|_| panic!("fits"));
            }
            source
                .push(quoted, Protection::All, &mut work)
                .unwrap_or_else(|_| panic!("fits"));
            for _ in 0..3 {
                assert_eq!(
                    finish(source.matches_full(value, &mut work, &Cancel::new())).ok(),
                    Some(true),
                    "{prefix}{quoted}: {value}"
                );
            }
        }
    }

    #[test]
    fn literal_suffix_expansion_admits_storage_and_checkpoints_cancellation() {
        let mut source = pattern(&format!("@([|a){}", r"\*".repeat(8192)));
        let mut work = Work::new(1000000, 1000000, 16);
        let cancel = Cancel::new();
        finish(source.normalize_glob(true, &mut work, &cancel))
            .unwrap_or_else(|_| panic!("normalization fits"));
        let mut compiler = Compiler {
            code: Vec::new(),
            groups: Vec::new(),
            tail: 0,
        };
        let mut denied = Work::new(1000000, 0, 16);
        assert!(matches!(
            finish(literal_tail(
                &source,
                0,
                &mut compiler,
                &mut denied,
                &cancel
            )),
            Err(Error::Status(2))
        ));
        assert_eq!(compiler.code.capacity(), 0);
        compiler
            .emit(Instruction::Accept, &mut work)
            .unwrap_or_else(|_| panic!("fits"));
        assert_cancelled_after_yield(
            literal_tail(&source, 0, &mut compiler, &mut work, &cancel),
            &cancel,
        );
    }

    #[test]
    fn group_boundary_storage_and_scan_are_admitted_and_cancellable() {
        let source = pattern("@(a)");
        let cancel = Cancel::new();
        let mut work = Work::new(100000, source.chars.len() - 1, 16);
        assert!(matches!(
            finish(group_boundaries(&source, &mut work, &cancel)),
            Err(Error::Status(2))
        ));
        let mut work = Work::new(100000, source.chars.len(), 16);
        assert!(matches!(
            finish(group_boundaries(&source, &mut work, &cancel)),
            Err(Error::Status(2))
        ));
        let source = pattern(&format!("@({})", "a".repeat(8192)));
        let mut work = Work::new(1000000, 1000000, 16);
        assert_cancelled_after_yield(group_boundaries(&source, &mut work, &cancel), &cancel);
    }

    #[test]
    fn option_off_is_basic_but_deferred_contexts_still_reject_groups() {
        let mut basic = Pattern::with_options(false, false);
        let mut work = Work::new(100000, 100000, 16);
        for ch in "?(a|b)".chars() {
            basic
                .push(ch, Protection::None, &mut work)
                .unwrap_or_else(|_| panic!("fits"));
        }
        assert_eq!(
            finish(basic.matches_full("x(a|b)", &mut work, &Cancel::new())).ok(),
            Some(true)
        );
        assert!(matches!(
            finish(pattern("@(a)").matches_pathname("a", &mut work, &Cancel::new())),
            Err(Error::Status(2))
        ));
        assert!(matches!(
            finish(pattern("@(a)").remove("abc", true, true, &mut work, &Cancel::new())),
            Err(Error::Status(2))
        ));
        assert_eq!(
            finish(pattern("!(a)").matches_full("b", &mut work, &Cancel::new())).ok(),
            Some(true)
        );
    }

    #[test]
    fn deep_groups_compile_and_match_without_recursive_stack() {
        let source = format!("{}a{}", "@(".repeat(4096), ")".repeat(4096));
        let mut work = Work::new(1000000, 4000000, 16);
        assert_eq!(
            finish(pattern(&source).matches_full("a", &mut work, &Cancel::new())).ok(),
            Some(true)
        );
    }

    #[test]
    fn overlapping_repetition_has_linear_state_storage_and_bounded_work() {
        let mut work = Work::new(1000000, 100000, 16);
        let input = format!("{}z", "a".repeat(2048));
        assert_eq!(
            finish(pattern("*(a|aa|aaa|aaaa)").matches_full(&input, &mut work, &Cancel::new()))
                .ok(),
            Some(false)
        );
        assert!(work.storage_remaining > 90000);
        assert!(work.remaining > 500000);
    }

    #[test]
    fn exhausted_work_and_storage_are_errors_not_misses() {
        for (steps, storage) in [(1, 100000), (100000, 1)] {
            let mut work = Work::new(steps, storage, 16);
            assert!(matches!(
                finish(pattern("*(a|aa)").matches_full("aaaa", &mut work, &Cancel::new())),
                Err(Error::Status(2))
            ));
        }
    }

    #[test]
    fn states_and_compiler_admit_capacity_before_allocation() {
        let mut compiler = Compiler {
            code: Vec::new(),
            groups: Vec::new(),
            tail: 0,
        };
        let mut work = Work::new(100000, std::mem::size_of::<Instruction>() - 1, 16);
        assert!(matches!(
            compiler.emit(Instruction::Accept, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(compiler.code.capacity(), 0);
        let count = 32;
        let bytes = count * (std::mem::size_of::<bool>() + std::mem::size_of::<usize>());
        let mut work = Work::new(100000, bytes - 1, 16);
        assert!(matches!(
            finish(States::new(count, &mut work, &Cancel::new())),
            Err(Error::Status(2))
        ));
        let mut work = Work::new(100000, bytes, 16);
        let states = finish(States::new(count, &mut work, &Cancel::new()))
            .unwrap_or_else(|_| panic!("exact states fit"));
        assert_eq!(work.storage_remaining, 0);
        assert_eq!(states.live.capacity(), count);
        assert_eq!(states.pending.capacity(), count);
    }

    #[test]
    fn cancellation_interrupts_compilation_and_matching_after_yield() {
        let mut work = Work::new(1000000, 1000000, 16);
        let cancel = Cancel::new();
        cancel.cancel();
        assert!(matches!(
            finish(pattern("@(a)").matches_full("a", &mut work, &cancel)),
            Err(Error::Status(130))
        ));
        let cancel = Cancel::new();
        let input = "a".repeat(8192);
        let pattern = pattern("*(a|aa)");
        assert_cancelled_after_yield(matches(&pattern, &input, &mut work, &cancel), &cancel);
    }
}
