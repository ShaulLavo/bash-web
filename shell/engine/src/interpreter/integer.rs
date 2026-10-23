use super::{Context, SharedState};
use crate::{
    arithmetic,
    expand::{Error, Work},
};

pub(crate) async fn coerce(
    name: &str,
    value: String,
    state: &SharedState,
    context: &Context,
    work: &mut Work,
) -> Result<String, Error> {
    if !state.borrow().integer_assignment(name) {
        return Ok(value);
    }
    if state.borrow().is_readonly(name) {
        work.admit_storage(name.len().saturating_add(160))?;
        return Err(Error::Readonly {
            name: name.to_owned(),
            line: None,
            expansion: false,
        });
    }
    let number = arithmetic::evaluate_literal(
        &value,
        state,
        &context.cancel,
        context.limits().expansion_bytes,
        work,
    )
    .await?;
    work.checkpoint(&context.cancel).await?;
    let digits = if number == 0 {
        1
    } else {
        number.unsigned_abs().ilog10() as usize + 1
    } + usize::from(number < 0);
    if digits > context.limits().expansion_bytes {
        return Err(2.into());
    }
    work.admit_storage(digits)?;
    Ok(number.to_string())
}
