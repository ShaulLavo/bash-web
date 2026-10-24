//! Operation recipes evaluate selectors once at the caller's chosen phase.
use super::{Error, Work};
use crate::{
    arithmetic,
    executor::Cancel,
    state::{BindingUpdate, Place, Reference, ScalarResolution, SharedState, State},
};

pub(crate) async fn select(
    reference: Reference<'_>,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<Place, Error> {
    State::admit_scalar_access(state, reference.name, cancel, work).await?;
    let (name, subscript) = {
        let state = state.borrow();
        let reference = state.reference(reference).map_err(|error| match error {
            ScalarResolution::DepthExceeded => Error::AssignmentDepth,
            _ => Error::Status(1),
        })?;
        work.admit_storage(
            reference
                .name
                .len()
                .saturating_add(reference.subscript.map_or(0, str::len)),
        )?;
        (
            reference.name.to_owned(),
            reference.subscript.map(str::to_owned),
        )
    };
    if matches!(subscript.as_deref(), Some("@" | "*")) {
        return Err(2.into());
    }
    let index = match subscript {
        Some(ref subscript) => {
            Some(arithmetic::evaluate(subscript, state, cancel, max, work).await?)
        }
        None => None,
    };
    let state = state.borrow();
    let index = match index {
        Some(index) => Some(resolve_index(
            &state,
            &name,
            index,
            subscript.as_deref(),
            work,
        )?),
        None => None,
    };
    let owner = state.reference_owner(&name);
    Ok(Place { name, index, owner })
}

/// Lazy scalar operators retain the ordinary scalar path's admission costs.
/// Only an explicit or referenced element needs an evaluated place.
pub(crate) async fn parameter_place(
    text: &str,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<Option<Place>, Error> {
    let Some(reference) = Reference::parse(text) else {
        return Ok(None);
    };
    let indexed = match state.borrow().reference(reference) {
        Ok(target) => target.subscript.is_some(),
        // Bare-name cycles and depth overflow keep the scalar adapter's unset
        // reads. Its separate assignment admission still rejects writes.
        Err(_) if reference.subscript.is_none() => return Ok(None),
        Err(ScalarResolution::DepthExceeded) => return Err(Error::AssignmentDepth),
        Err(_) => return Err(Error::Status(1)),
    };
    if !indexed {
        return Ok(None);
    }
    select(reference, state, cancel, max, work).await.map(Some)
}

fn resolve_index(
    state: &State,
    name: &str,
    index: i64,
    subscript: Option<&str>,
    work: &mut Work,
) -> Result<i64, Error> {
    if let Some(index) = state.place_index(name, index) {
        return Ok(index);
    }
    let subscript = subscript.unwrap_or("0");
    work.admit_storage(
        name.len()
            .saturating_add(subscript.len())
            .saturating_add(160),
    )?;
    Err(Error::BadArraySubscript {
        name: format!("{name}[{subscript}]"),
        line: None,
    })
}

pub(crate) fn syntax(text: &str) -> Result<Reference<'_>, Error> {
    Reference::parse(text).ok_or(Error::Status(2))
}

pub(crate) async fn read(
    place: &Place,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<Option<String>, Error> {
    work.checkpoint(cancel).await?;
    let state = state.borrow();
    if place.name == "PIPESTATUS"
        && let Some(index) = place.index
    {
        work.admit_storage(20)?;
        let value = usize::try_from(index)
            .ok()
            .and_then(|index| state.pipeline_status().get(index))
            .map(i32::to_string);
        if value.as_ref().is_some_and(|value| value.len() > max) {
            return Err(2.into());
        }
        return Ok(value);
    }
    let Some(value) = state.place_value(place) else {
        return Ok(None);
    };
    if value.len() > max {
        return Err(2.into());
    }
    work.admit_storage(value.len())?;
    Ok(Some(value.to_owned()))
}

pub(crate) async fn write(
    place: &Place,
    value: String,
    state: &SharedState,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<(), Error> {
    if place.index.is_none() {
        State::admit_place_assignment(state, &place.name, value.len(), cancel, work).await?;
        work.admit_storage(place.name.len().saturating_mul(2).saturating_add(208))?;
        return state
            .borrow_mut()
            .assign_place_scalar(place.name.clone(), value)
            .map_err(|code| {
                if code == 1 {
                    Error::Readonly {
                        name: place.name.clone(),
                        line: None,
                        expansion: false,
                    }
                } else {
                    code.into()
                }
            });
    }
    if place.name == "PIPESTATUS" || state.borrow().stack_array(&place.name) {
        return Err(2.into());
    }
    let value = state.borrow().case_value(&place.name, value)?;
    let update = BindingUpdate::Element {
        index: place.index.unwrap(),
        value,
    };
    State::write_element(state, place, update, cancel, work).await
}

/// Unbound bare keys remain outside the indexed removal adapter. In particular,
/// a rejected associative declaration must not make `unset a[key]` delete zero.
pub(crate) async fn removal_place(
    reference: Reference<'_>,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<Option<Place>, Error> {
    if let Some(subscript) = reference.subscript {
        for _ in subscript.bytes() {
            work.checkpoint(cancel).await?;
        }
        let bare_key = Reference::parse(subscript).is_some_and(|key| key.subscript.is_none());
        if bare_key && !state.borrow().scalar_is_set(subscript) {
            return Ok(None);
        }
    }
    select(reference, state, cancel, max, work).await.map(Some)
}

pub(crate) async fn is_set(
    text: &str,
    state: &SharedState,
    cancel: &Cancel,
    max: usize,
    work: &mut Work,
) -> Result<bool, Error> {
    let Some(reference) = Reference::parse(text) else {
        return Ok(false);
    };
    if reference.subscript.is_none() {
        State::admit_scalar_access(state, reference.name, cancel, work).await?;
        return Ok(state.borrow().scalar_is_set(reference.name));
    }
    let place = match select(reference, state, cancel, max, work).await {
        Ok(place) => place,
        Err(Error::BadArraySubscript { .. }) => return Ok(false),
        Err(error) => return Err(error),
    };
    let state = state.borrow();
    Ok(state.dynamic_parameter(&place.name) || state.place_value(&place).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::StorageBudget;
    use futures::FutureExt;

    #[test]
    fn typed_reference_projected_array_store_never_creates_an_ordinary_binding() {
        for name in ["PIPESTATUS", "FUNCNAME", "BASH_SOURCE", "BASH_ARGV"] {
            let memory = StorageBudget::new(65_536);
            let state = State::with_memory(memory.clone()).shared();
            let place = Place {
                name: name.into(),
                index: Some(9),
                owner: state.borrow().reference_owner(name),
            };
            let before = memory.observation().0;
            let mut work = Work::new(65_536, 65_536, 0);
            assert!(matches!(
                write(&place, "ignored".into(), &state, &Cancel::new(), &mut work).now_or_never(),
                Some(Err(Error::Status(2)))
            ));
            assert!(!state.borrow().raw_bindings().contains_key(name));
            assert_eq!(memory.observation().0, before);
            drop(state);
            assert_eq!(memory.observation().0, 0);
        }
    }
}
