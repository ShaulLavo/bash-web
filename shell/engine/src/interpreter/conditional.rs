//! Original structured `[[ ]]` evaluator. Parsing fixes operator identity and
//! precedence before expansion; skipped branches never expand their operands.
//! Scalar operands do not undergo IFS splitting, globbing, or brace expansion.
use super::{Context, Descriptors, Outcome, expansion_failure};
use crate::{
    arithmetic, builtins,
    exec::ResultFuture,
    expand::{self, Error, Work},
    io::{Endpoint, FdTable},
    state::SharedState,
};
use shell_parser::parser::{TestExpr, Word};
use std::{cmp::Ordering, mem::size_of};

mod regex;

const MAX_DEPTH: usize = 64;

pub(super) async fn run(
    expression: &TestExpr,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut Work,
) -> Outcome {
    match evaluate(expression, state, fds, context, work).await {
        Ok(status) => Outcome::status(status),
        Err(error) => expansion_failure(error.into(), fds, context).await,
    }
}

enum Continuation<'a> {
    Not,
    Group,
    And(&'a [TestExpr]),
    Or(&'a [TestExpr]),
}

fn push<'a>(
    stack: &mut Vec<Continuation<'a>>,
    continuation: Continuation<'a>,
    work: &mut Work,
) -> Result<(), Error> {
    if stack.len() >= MAX_DEPTH {
        return Err(2.into());
    }
    if stack.len() == stack.capacity() {
        let capacity = stack.capacity().saturating_mul(2).clamp(4, MAX_DEPTH);
        let growth = capacity - stack.capacity();
        work.admit_storage(growth.checked_mul(size_of::<Continuation<'_>>()).ok_or(2)?)?;
        stack
            .try_reserve_exact(capacity - stack.len())
            .map_err(|_| Error::Status(2))?;
    }
    stack.push(continuation);
    Ok(())
}

// One admitted future owns an iterative, bounded continuation stack. A wide
// logical chain reuses a single stack slot, not a boxed future per sibling.
fn evaluate<'a>(
    expression: &'a TestExpr,
    state: &'a SharedState,
    fds: &'a Descriptors,
    context: &'a Context,
    work: &'a mut Work,
) -> ResultFuture<'a, i32> {
    arithmetic::admitted(work, move |work| async move {
        let mut stack = Vec::new();
        let mut current = expression;
        'evaluate: loop {
            work.checkpoint(&context.cancel).await?;
            match current {
                TestExpr::Not(child) => {
                    push(&mut stack, Continuation::Not, work)?;
                    current = child;
                    continue;
                }
                TestExpr::Group(child) => {
                    push(&mut stack, Continuation::Group, work)?;
                    current = child;
                    continue;
                }
                TestExpr::And(children) | TestExpr::Or(children) => {
                    let (first, rest) = children.split_first().ok_or(2)?;
                    let continuation = if matches!(current, TestExpr::And(_)) {
                        Continuation::And(rest)
                    } else {
                        Continuation::Or(rest)
                    };
                    push(&mut stack, continuation, work)?;
                    current = first;
                    continue;
                }
                _ => {}
            }
            let mut value = predicate(current, state, fds, context, work).await?;
            while let Some(continuation) = stack.pop() {
                work.checkpoint(&context.cancel).await?;
                match continuation {
                    Continuation::Not => value = i32::from(value == 0),
                    Continuation::Group => {}
                    Continuation::And(rest) | Continuation::Or(rest) => {
                        let select_next = match continuation {
                            Continuation::And(_) => value == 0,
                            Continuation::Or(_) => value != 0,
                            _ => unreachable!("logical continuation"),
                        };
                        if select_next && let Some((next, rest)) = rest.split_first() {
                            let continuation = if value == 0 {
                                Continuation::And(rest)
                            } else {
                                Continuation::Or(rest)
                            };
                            push(&mut stack, continuation, work)?;
                            current = next;
                            continue 'evaluate;
                        }
                    }
                }
            }
            return Ok(value);
        }
    })
}

async fn predicate(
    expression: &TestExpr,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut Work,
) -> Result<i32, Error> {
    match expression {
        TestExpr::Word(word) => Ok(i32::from(
            scalar(word, state, context, work).await?.is_empty(),
        )),
        TestExpr::Unary { operator, operand } => {
            let value = scalar(operand, state, context, work).await?;
            unary(operator, &value, state, fds, context, work).await
        }
        TestExpr::Binary {
            left,
            operator,
            right,
        } => binary(left, operator, right, state, fds, context, work)
            .await
            .map(|value| i32::from(!value)),
        _ => unreachable!("logical nodes handled by continuation traversal"),
    }
}

async fn unary(
    operator: &str,
    value: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut Work,
) -> Result<i32, Error> {
    match operator {
        "-n" => return Ok(i32::from(value.is_empty())),
        "-z" => return Ok(i32::from(!value.is_empty())),
        _ => {}
    }
    if !builtins::test::is_unary(operator) {
        return Err(2.into());
    }
    let table = descriptors(fds, context, work).await?;
    match builtins::test::unary(operator, value, state, &table, context, work).await {
        Ok(value) => Ok(i32::from(!value)),
        Err(builtins::test::UnaryError::Status(status)) => Err(status.into()),
        Err(builtins::test::UnaryError::Integer) => {
            builtins::test::integer_diagnostic("[[", value, &table, context).await?;
            // Bash's malformed -t status participates in !/&&/||. Other unary
            // failures remain expansion errors, as before.
            Ok(2)
        }
    }
}

async fn scalar(
    word: &Word,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<String, Error> {
    expand::conditional_word(
        word,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await
}

async fn binary(
    left: &Word,
    operator: &str,
    right: &Word,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut Work,
) -> Result<bool, Error> {
    let left = scalar(left, state, context, work).await?;
    if matches!(operator, "=" | "==" | "!=") {
        let mut pattern = expand::conditional_pattern(
            right,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            work,
        )
        .await?;
        let matched = pattern.matches_full(&left, work, &context.cancel).await?;
        return Ok(if operator == "!=" { !matched } else { matched });
    }
    if operator == "=~" {
        let pattern = expand::conditional_pattern(
            right,
            state,
            &context.cancel,
            context.limits().expansion_bytes,
            work,
        )
        .await?;
        regex::locale(state)?;
        return regex::matches(&pattern, &left, work, &context.cancel).await;
    }
    let right = scalar(right, state, context, work).await?;
    if matches!(operator, "<" | ">") {
        let order = compare(&left, &right, context, work).await?;
        return Ok(if operator == "<" {
            order.is_lt()
        } else {
            order.is_gt()
        });
    }
    if matches!(operator, "-nt" | "-ot" | "-ef") {
        let table = descriptors(fds, context, work).await?;
        return builtins::test::file_binary(&left, operator, &right, state, &table, context, work)
            .await
            .map_err(Into::into);
    }
    if !matches!(operator, "-eq" | "-ne" | "-lt" | "-le" | "-gt" | "-ge") {
        // Unknown operators never fall back to guessed false values.
        return Err(2.into());
    }
    let Some(left) = number(&left, state, fds, context, work).await? else {
        return Ok(false);
    };
    let Some(right) = number(&right, state, fds, context, work).await? else {
        return Ok(false);
    };
    Ok(match operator {
        "-eq" => left == right,
        "-ne" => left != right,
        "-lt" => left < right,
        "-le" => left <= right,
        "-gt" => left > right,
        "-ge" => left >= right,
        _ => unreachable!("numeric operator checked above"),
    })
}

// A numeric predicate's arithmetic/readonly diagnostic makes it false, not a
// shell-expansion failure. Logical negation/OR still operate on that false value.
// Errors from expanding the operands themselves never pass through this helper.
async fn number(
    source: &str,
    state: &SharedState,
    fds: &Descriptors,
    context: &Context,
    work: &mut Work,
) -> Result<Option<i64>, Error> {
    // Already shell-expanded: do not execute literal dollar text a second time.
    match arithmetic::evaluate_literal(
        source,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await
    {
        Ok(value) => Ok(Some(value)),
        Err(
            error @ Error::Arithmetic {
                expansion: false, ..
            }
            | error @ Error::Readonly {
                expansion: false, ..
            },
        ) => {
            let result = super::arithmetic_result(Err(error), fds, context).await;
            if result.code != 1 {
                return Err(result.code.into());
            }
            work.checkpoint(&context.cancel).await?;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

// Predicates may yield. Never hold the descriptor RefCell borrow over them;
// charge a conservative B-tree copy before cloning its existing entries.
async fn descriptors(
    fds: &Descriptors,
    context: &Context,
    work: &mut Work,
) -> Result<FdTable, Error> {
    let count = fds.borrow().iter().count();
    for _ in 0..count {
        work.checkpoint(&context.cancel).await?;
    }
    let bytes = count
        .checked_mul(size_of::<(u32, Endpoint)>() + size_of::<usize>())
        .and_then(|bytes| bytes.checked_mul(16))
        .ok_or(2)?;
    work.admit_storage(bytes)?;
    Ok(fds.borrow().clone())
}

// Match the engine's byte-order locale without a long uninterruptible scan.
async fn compare(
    left: &str,
    right: &str,
    context: &Context,
    work: &mut Work,
) -> Result<Ordering, Error> {
    for (left, right) in left.bytes().zip(right.bytes()) {
        work.checkpoint(&context.cancel).await?;
        let order = left.cmp(&right);
        if !order.is_eq() {
            return Ok(order);
        }
    }
    Ok(left.len().cmp(&right.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuation_storage_is_admitted_before_vector_growth() {
        let mut stack = Vec::new();
        let mut work = Work::new(64, 0, 1);
        assert!(matches!(
            push(&mut stack, Continuation::Not, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(stack.len(), 0);
        assert_eq!(stack.capacity(), 0);

        let mut work = Work::new(64, 4 * size_of::<Continuation<'_>>(), 1);
        for _ in 0..4 {
            push(&mut stack, Continuation::Not, &mut work)
                .unwrap_or_else(|_| panic!("admitted slots must fit"));
        }
        assert_eq!(stack.len(), 4);
        assert!(matches!(
            push(&mut stack, Continuation::Not, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(stack.len(), 4);
        assert_eq!(stack.capacity(), 4);
    }

    #[test]
    fn continuation_depth_rejection_does_not_grow_the_stack() {
        let mut stack = Vec::new();
        let mut work = Work::new(64, MAX_DEPTH * size_of::<Continuation<'_>>(), 1);
        for _ in 0..MAX_DEPTH {
            push(&mut stack, Continuation::Group, &mut work)
                .unwrap_or_else(|_| panic!("bounded depth must fit"));
        }
        assert!(matches!(
            push(&mut stack, Continuation::Not, &mut work),
            Err(Error::Status(2))
        ));
        assert_eq!(stack.len(), MAX_DEPTH);
        assert_eq!(stack.capacity(), MAX_DEPTH);
    }
}
