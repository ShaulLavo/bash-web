//! Trap actions run in the current shell through the admitted eval reader.
use super::{Context, Descriptors, Flow, Outcome, eval};
use crate::{
    executor::Budget,
    state::{SharedState, traps::Event},
};

struct Running {
    state: SharedState,
    event: Event,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.state.borrow_mut().traps.end(self.event);
    }
}

#[inline(never)]
pub(super) fn run(
    event: Event,
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> eval::Frame<'static, Outcome> {
    context.evaluation.clone().frame(
        run_body(event, result, state, fds, context),
        Outcome::status,
    )
}

async fn run_body(
    event: Event,
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    if context.cancel.is_cancelled() {
        return result;
    }
    let action = state.borrow_mut().traps.begin(event);
    let Some(action) = action else { return result };
    let _running = Running {
        state: state.clone(),
        event,
    };
    let pipeline_storage = state.borrow().pipeline_status().len() * std::mem::size_of::<i32>();
    let _storage = match context
        .evaluation
        .admit_storage(action.text.len() + pipeline_storage)
    {
        Ok(storage) => storage,
        Err(code) => return Outcome::status(code),
    };
    let pipeline = state.borrow().pipeline_status().to_vec();
    let mut budget = Budget::default();
    for _ in action.text.bytes() {
        if context
            .evaluation
            .checkpoint(&mut budget, &context.cancel)
            .await
            .is_err()
        {
            return Outcome::status(context.cancel_status());
        }
    }
    let handler = eval::run(vec![action.text.clone()], state.clone(), fds, context).await;
    let outcome = if handler.flow == Flow::Normal {
        result
    } else {
        handler
    };
    let mut state = state.borrow_mut();
    state.publish_status(outcome.code);
    state.publish_pipeline_status(pipeline);
    outcome
}

pub(super) async fn function_return(
    result: Outcome,
    state: SharedState,
    fds: Descriptors,
    context: Context,
) -> Outcome {
    if !matches!(result.flow, Flow::Normal | Flow::Return) {
        return result;
    }
    run(Event::Return, result, state, fds, context).await
}
