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
    let value = state.borrow().case_value(&place.name, value)?;
    let update = BindingUpdate::Element {
        index: place.index.unwrap(),
        value,
    };
    State::write_element(state, place, update, cancel, work).await
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
    let place = select(reference, state, cancel, max, work).await?;
    let state = state.borrow();
    Ok(state.dynamic_parameter(&place.name) || state.place_value(&place).is_some())
}
