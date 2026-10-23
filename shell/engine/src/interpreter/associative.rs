//! Element assignments stage one key. Compounds stage one replacement.
use super::*;
use crate::state::{Associative, Binding, BindingUpdate};

pub(super) async fn scalar(
    assignment: &Assignment,
    value: String,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<BindingUpdate, expand::Error> {
    let limit = context.limits().expansion_bytes;
    let key = expand::associative::subscript(
        assignment.index.as_deref().unwrap_or("0"),
        state,
        &context.cancel,
        limit,
        work,
    )
    .await?;
    if key.is_empty() {
        return Err(expand::Error::BadArraySubscript {
            name: assignment.name.clone(),
            line: None,
        });
    }
    let state = state.borrow();
    let previous = match state.binding(&assignment.name) {
        Some(Binding::Associative(values)) => values.get(&key),
        _ => None,
    };
    let value = indexed::append(previous, value, assignment.append, limit, work)?;
    Ok(BindingUpdate::AssociativeElement {
        key,
        value: Some(value),
    })
}

pub(super) async fn compound(
    name: &str,
    append: bool,
    words: &[Word],
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<BindingUpdate, expand::Error> {
    let mut values = if append {
        Associative::snapshot(state, name, &context.cancel, work).await?
    } else {
        let values = match state.borrow().binding(name) {
            Some(Binding::Associative(values)) => values.empty_replacement(),
            _ => Associative::default().empty_replacement(),
        };
        work.admit_storage(values.storage_bytes())?;
        values
    };
    values.initialize();
    let result = elements(&mut values, name, words, state, context, work).await;
    let update = BindingUpdate::Replace(Binding::Associative(Rc::new(values)));
    if matches!(
        result,
        Err(expand::Error::BadArraySubscript { .. } | expand::Error::AssociativeAssignment { .. })
    ) {
        commit(name, update, state, context, work).await?;
        return result.map(|()| unreachable!());
    }
    result?;
    Ok(update)
}

async fn elements(
    values: &mut Associative,
    name: &str,
    words: &[Word],
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let keyed = words
        .first()
        .is_some_and(|word| parse::array_element(word).is_some());
    let mut pending = None;
    for word in words {
        work.checkpoint(&context.cancel).await?;
        if keyed {
            keyed_element(values, name, word, state, context, work).await?;
            continue;
        }
        let limit = context.limits().expansion_bytes;
        let value = expand::assignment(word, state, &context.cancel, limit, limit, work).await?;
        alternating_element(values, &mut pending, value, limit, work)?;
    }
    if let Some(key) = pending {
        insert(
            values,
            key,
            String::new(),
            false,
            context.limits().expansion_bytes,
            work,
        )?;
    }
    Ok(())
}

async fn keyed_element(
    values: &mut Associative,
    name: &str,
    word: &Word,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let Some((source, value, append)) = parse::array_element(word) else {
        return Err(expand::Error::AssociativeAssignment {
            name: name.to_owned(),
            word: word.raw.clone().unwrap_or_default(),
            line: None,
        });
    };
    let limit = context.limits().expansion_bytes;
    let key = expand::associative::subscript(source, state, &context.cancel, limit, work).await?;
    if key.is_empty() {
        return Err(expand::Error::BadArraySubscript {
            name: word.raw.clone().unwrap_or_default(),
            line: None,
        });
    }
    let value =
        expand::associative::scalar_word(value, false, state, &context.cancel, limit, work).await?;
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
        return Err(expand::Error::BadArraySubscript {
            name: "[]".into(),
            line: None,
        });
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
    work.admit_storage(values.growth_bytes(&key))?;
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

async fn commit(
    name: &str,
    update: BindingUpdate,
    state: &SharedState,
    context: &Context,
    work: &mut expand::Work,
) -> Result<(), expand::Error> {
    let (copy, storage) = state.borrow().admit_binding_update(name, &update, work)?;
    let mut completed = crate::state::AssignmentFrame::enter(state.clone())?;
    completed.reserve(name, update.undo_bytes(state.borrow().binding(name)))?;
    let frame = PrefixFrame::enter(state.clone());
    frame.reserve(name, storage)?;
    for _ in 0..copy {
        work.checkpoint(&context.cancel).await?;
    }
    frame.commit_update(name.to_owned(), update, &mut completed)?;
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
    let key = match expand::associative::subscript(
        subscript,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await
    {
        Ok(key) => key,
        Err(expand::Error::Status(2)) => return Ok(()),
        Err(error) => return Err(error),
    };
    if key.is_empty() {
        return Err(expand::Error::BadArraySubscript {
            name: name.to_owned(),
            line: None,
        });
    }
    let update = BindingUpdate::AssociativeElement { key, value: None };
    commit(name, update, state, context, work).await
}

pub(crate) async fn declaration_failure(
    error: expand::Error,
    fds: &io::FdTable,
    context: &Context,
    line: Option<usize>,
) -> Outcome {
    let descriptors = Rc::new(RefCell::new(fds.clone()));
    super::expansion_failure(error.at_line(line).into(), &descriptors, context).await
}
