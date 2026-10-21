//! Original indexed assignment execution; binding storage stays state-owned.
use super::*;
use crate::state::{Binding, Indexed};

pub(super) async fn assign(
    assignment: &Assignment,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
    frame: &PrefixFrame,
    bytes: &mut usize,
) -> Result<(), expand::Error> {
    let value = value(assignment, state, context, work).await?;
    *bytes = bytes
        .saturating_add(value.value_bytes())
        .saturating_add(assignment.name.len() + 1);
    if *bytes > context.limits().expansion_bytes {
        return Err(2.into());
    }
    frame
        .reserve(&assignment.name, value.storage_bytes())
        .map_err(expand::Error::from)?;
    work.admit_storage(assignment.name.len().saturating_add(160))?;
    frame
        .set_binding(assignment.name.clone(), value)
        .map_err(|name| expand::Error::Readonly {
            name,
            line: None,
            expansion: true,
        })
}

async fn value(
    assignment: &Assignment,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Binding, expand::Error> {
    work.admit_storage(std::mem::size_of::<Indexed>() + 2 * std::mem::size_of::<usize>())?;
    match &assignment.value {
        AssignmentValue::Scalar(word) => scalar(assignment, word, state, context, work).await,
        AssignmentValue::Array(words) => compound(assignment, words, state, context, work).await,
    }
}

async fn previous(
    name: &str,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Option<Binding>, expand::Error> {
    State::admit_scalar_access(state, name, &context.cancel, work).await?;
    let bytes = state
        .borrow()
        .binding(name)
        .map_or(0, Binding::storage_bytes);
    work.admit_storage(bytes)?;
    for _ in 0..bytes {
        work.checkpoint(&context.cancel).await?;
    }
    Ok(state.borrow().binding(name).cloned())
}

async fn scalar(
    assignment: &Assignment,
    word: &Word,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Binding, expand::Error> {
    let limit = context.limits().expansion_bytes;
    let value = expand::word(word, state, &context.cancel, limit, limit, work).await?;
    let index = match &assignment.index {
        Some(index) => {
            crate::arithmetic::evaluate(index, state, &context.cancel, limit, work).await?
        }
        None => 0,
    };
    let old = previous(&assignment.name, state, context, work).await?;
    let Some(index) = old.as_ref().map_or((index >= 0).then_some(index), |value| {
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
    if assignment.index.is_none() && !matches!(old, Some(Binding::Indexed(_))) {
        return Ok(append(
            old.as_ref().and_then(Binding::scalar),
            value,
            assignment.append,
            limit,
            work,
        )?
        .into());
    }
    if matches!(old, Some(Binding::Scalar(_))) {
        work.admit_storage(Binding::node_bytes())?;
    }
    let mut values = old.map(Binding::into_indexed).unwrap_or_default();
    let value = append(values.get(index), value, assignment.append, limit, work)?;
    work.admit_storage(Binding::node_bytes())?;
    values.insert(index, value);
    Ok(Binding::Indexed(Rc::new(values)))
}

fn append(
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
) -> Result<Binding, expand::Error> {
    if assignment.index.is_some() {
        return Err(2.into());
    }
    let old = if assignment.append {
        previous(&assignment.name, state, context, work).await?
    } else {
        None
    };
    if matches!(old, Some(Binding::Scalar(_))) {
        work.admit_storage(Binding::node_bytes())?;
    }
    let mut values = old.map(Binding::into_indexed).unwrap_or_default();
    let mut index = values.next_index().ok_or(2)?;
    let mut bytes = 0usize;
    for word in words {
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
        insert_fields(&mut values, &mut index, fields, work)?;
    }
    Ok(Binding::Indexed(Rc::new(values)))
}

fn insert_fields(
    values: &mut Indexed,
    index: &mut i64,
    fields: Vec<String>,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    for value in fields {
        work.admit_storage(Binding::node_bytes())?;
        values.insert(*index, value);
        *index = index.checked_add(1).ok_or(2)?;
    }
    Ok(())
}
