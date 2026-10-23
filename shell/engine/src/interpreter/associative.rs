//! Associative assignment stages a complete, admitted binding. The state layer
//! retains and restores it through the same journal as every other assignment.
use super::*;
use crate::state::{Associative, Binding, BindingUpdate};

pub(super) async fn value(
    assignment: &Assignment,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<BindingUpdate, expand::Error> {
    let values = match &assignment.value {
        AssignmentValue::Scalar(word) => scalar(assignment, word, state, context, work).await?,
        AssignmentValue::Array(words) => compound(assignment, words, state, context, work).await?,
    };
    Ok(BindingUpdate::Replace(Binding::Associative(Rc::new(
        values,
    ))))
}

async fn scalar(
    assignment: &Assignment,
    word: &Word,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Associative, expand::Error> {
    let limit = context.limits().expansion_bytes;
    let value = expand::assignment(word, state, &context.cancel, limit, limit, work).await?;
    let key = expand::associative::subscript(
        assignment.index.as_deref().unwrap_or("0"),
        state,
        &context.cancel,
        limit,
        work,
    )
    .await?;
    let mut values = Associative::snapshot(state, &assignment.name, &context.cancel, work).await?;
    insert(&mut values, key, value, assignment.append, limit, work)?;
    Ok(values)
}

async fn compound(
    assignment: &Assignment,
    words: &[Word],
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<Associative, expand::Error> {
    if assignment.index.is_some() {
        return Err(2.into());
    }
    let mut values = if assignment.append {
        Associative::snapshot(state, &assignment.name, &context.cancel, work).await?
    } else {
        work.admit_storage(std::mem::size_of::<Associative>() + 2 * std::mem::size_of::<usize>())?;
        Associative::default()
    };
    let keyed = words
        .first()
        .is_some_and(|word| parse::array_element(word).is_some());
    let mut pending = None;
    for word in words {
        work.checkpoint(&context.cancel).await?;
        if keyed {
            keyed_element(&mut values, word, state, context, work).await?;
            continue;
        }
        let limit = context.limits().expansion_bytes;
        let value = expand::assignment(word, state, &context.cancel, limit, limit, work).await?;
        alternating_element(&mut values, &mut pending, value, limit, work)?;
    }
    if let Some(key) = pending {
        insert(
            &mut values,
            key,
            String::new(),
            false,
            context.limits().expansion_bytes,
            work,
        )?;
    }
    Ok(values)
}

async fn keyed_element(
    values: &mut Associative,
    word: &Word,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let (key, value, append) = parse::array_element(word).ok_or(2)?;
    let limit = context.limits().expansion_bytes;
    let key = expand::associative::subscript(key, state, &context.cancel, limit, work).await?;
    expand::admit_generated_word(value, &context.cancel, work).await?;
    let word = parse::generated_word(value).map_err(|_| expand::Error::Status(2))?;
    let value = expand::assignment(&word, state, &context.cancel, limit, limit, work).await?;
    insert(values, key, value, append, limit, work)
}

fn alternating_element(
    values: &mut Associative,
    pending: &mut Option<String>,
    value: String,
    limit: usize,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    if let Some(key) = pending.take() {
        return insert(values, key, value, false, limit, work);
    }
    if value.is_empty() {
        return Err(2.into());
    }
    *pending = Some(value);
    Ok(())
}

fn insert(
    values: &mut Associative,
    key: String,
    value: String,
    append: bool,
    limit: usize,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let value = indexed::append(values.get(&key), value, append, limit, work)?;
    work.admit_storage(Associative::node_bytes())?;
    values.insert(key, value);
    Ok(())
}

pub(crate) async fn declare(
    assignment: &Assignment,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let mut completed = crate::state::AssignmentFrame::enter(state.clone())?;
    let frame = PrefixFrame::enter(state.clone());
    indexed::assign(
        assignment,
        state,
        context,
        work,
        frame,
        &mut 0,
        &mut completed,
    )
    .await?;
    completed.keep();
    Ok(())
}

pub(crate) async fn unset(
    name: &str,
    subscript: &str,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let key = expand::associative::subscript(
        subscript,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await?;
    let mut values = Associative::snapshot(state, name, &context.cancel, work).await?;
    values.remove(&key);
    let update = BindingUpdate::Replace(Binding::Associative(Rc::new(values)));
    let (_, storage) = state.borrow().admit_binding_update(name, &update, work)?;
    let mut completed = crate::state::AssignmentFrame::enter(state.clone())?;
    completed.reserve(name, update.undo_bytes(state.borrow().binding(name)))?;
    let frame = PrefixFrame::enter(state.clone());
    frame.reserve(name, storage)?;
    frame.commit_update(name.to_owned(), update, &mut completed)?;
    completed.keep();
    Ok(())
}
