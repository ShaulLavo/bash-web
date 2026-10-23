//! Original indexed assignment execution; binding storage stays state-owned.
use super::*;
use crate::state::{Binding, BindingUpdate, Indexed};

pub(super) async fn assign(
    assignment: &Assignment,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
    frame: PrefixFrame,
    bytes: &mut usize,
    completed: &mut crate::state::AssignmentFrame,
) -> Result<(), expand::Error> {
    let update = value(assignment, state, context, work).await?;
    let (copy, storage) = state
        .borrow()
        .admit_binding_update(&assignment.name, &update, work)?;
    let undo_bytes = update.undo_bytes(state.borrow().binding(&assignment.name));
    completed.reserve(&assignment.name, undo_bytes)?;
    frame
        .reserve(&assignment.name, storage)
        .map_err(expand::Error::from)?;
    for _ in 0..copy {
        work.checkpoint(&context.cancel).await?;
    }
    work.checkpoint(&context.cancel).await?;
    *bytes = bytes
        .saturating_add(assignment.name.len() + 1)
        .saturating_add(update.value_bytes());
    if *bytes > context.limits().expansion_bytes {
        return Err(2.into());
    }
    frame.commit_update(assignment.name.clone(), update, completed)
}

async fn value(
    assignment: &Assignment,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<BindingUpdate, expand::Error> {
    State::admit_scalar_access(state, &assignment.name, &context.cancel, work).await?;
    if state.borrow().is_associative(&assignment.name) {
        return super::associative::value(assignment, state, context, work).await;
    }
    match &assignment.value {
        AssignmentValue::Scalar(word) => scalar(assignment, word, state, context, work).await,
        AssignmentValue::Array(words) => compound(assignment, words, state, context, work).await,
    }
}

async fn scalar(
    assignment: &Assignment,
    word: &Word,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<BindingUpdate, expand::Error> {
    let limit = context.limits().expansion_bytes;
    let value = expand::assignment(word, state, &context.cancel, limit, limit, work).await?;
    let index = match &assignment.index {
        Some(index) => {
            crate::arithmetic::evaluate(index, state, &context.cancel, limit, work).await?
        }
        None => 0,
    };
    let state = state.borrow();
    let old = state.binding(&assignment.name);
    let Some(index) = old.map_or((index >= 0).then_some(index), |value| {
        value.resolve_index(index)
    }) else {
        let subscript = assignment.index.as_deref().unwrap_or("0");
        work.admit_storage(
            assignment
                .name
                .len()
                .saturating_add(subscript.len())
                .saturating_add(160),
        )?;
        return Err(expand::Error::BadArraySubscript {
            name: format!("{}[{subscript}]", assignment.name),
            line: None,
        });
    };
    let previous = old.and_then(|old| old.slot(index));
    let value = append(previous, value, assignment.append, limit, work)?;
    if assignment.index.is_none() && !matches!(old, Some(Binding::Indexed(_))) {
        return Ok(BindingUpdate::Replace(value.into()));
    }
    Ok(BindingUpdate::Element { index, value })
}

pub(super) fn append(
    old: Option<&String>,
    value: String,
    append: bool,
    limit: usize,
    work: &mut expand::Work,
) -> Result<String, expand::Error> {
    if !append {
        return Ok(value);
    }
    let old = old.map_or("", String::as_str);
    let bytes = old.len().checked_add(value.len()).ok_or(2)?;
    if bytes > limit {
        return Err(2.into());
    }
    work.admit_storage(bytes)?;
    let mut joined = String::with_capacity(bytes);
    joined.push_str(old);
    joined.push_str(&value);
    Ok(joined)
}

async fn compound(
    assignment: &Assignment,
    words: &[Word],
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<BindingUpdate, expand::Error> {
    if assignment.index.is_some() {
        return Err(2.into());
    }
    let mut index = if assignment.append {
        state
            .borrow()
            .binding(&assignment.name)
            .map_or(Some(0), |old| {
                old.last_index().map_or(Some(0), |i| i.checked_add(1))
            })
            .ok_or(2)?
    } else {
        0
    };
    work.admit_storage(std::mem::size_of::<Indexed>() + 2 * std::mem::size_of::<usize>())?;
    let mut values = Indexed::default();
    let mut bytes = 0usize;
    for word in words {
        if explicit_subscript(word) {
            return Err(2.into());
        }
        let limit = context.limits().expansion_bytes.saturating_sub(bytes);
        let fields = expand::fields(
            word,
            state,
            &context.cancel,
            limit,
            context.limits().arguments,
            limit,
            work,
        )
        .await?;
        bytes = bytes.saturating_add(fields.iter().map(String::len).sum::<usize>());
        insert_fields(&mut values, &mut index, fields, work, &context.cancel).await?;
    }
    if assignment.append {
        Ok(BindingUpdate::Append(values))
    } else {
        Ok(BindingUpdate::Replace(Binding::Indexed(Rc::new(values))))
    }
}

async fn insert_fields(
    values: &mut Indexed,
    index: &mut i64,
    mut fields: Vec<String>,
    work: &mut expand::Work,
    cancel: &Cancel,
) -> Result<(), expand::Error> {
    let next = index
        .checked_add(i64::try_from(fields.len()).map_err(|_| 2)?)
        .ok_or(2)?;
    while let Some(value) = fields.pop() {
        work.checkpoint(cancel).await?;
        let current = *index + i64::try_from(fields.len()).map_err(|_| 2)?;
        work.admit_storage(values.insertion_bytes(current))?;
        values.insert(current, value);
        compact_fields(&mut fields, work)?;
    }
    *index = next;
    Ok(())
}

fn compact_fields(fields: &mut Vec<String>, work: &mut expand::Work) -> Result<(), expand::Error> {
    if fields.len() > fields.capacity() / 2 {
        return Ok(());
    }
    let old_bytes = fields.capacity() * std::mem::size_of::<String>();
    let mut compact = Vec::new();
    work.admit_storage(fields.len() * std::mem::size_of::<String>())?;
    compact.try_reserve_exact(fields.len()).map_err(|_| 2)?;
    compact.append(fields);
    drop(std::mem::replace(fields, compact));
    work.release_storage(old_bytes);
    Ok(())
}

fn explicit_subscript(word: &Word) -> bool {
    parse::array_element(word).is_some()
}
