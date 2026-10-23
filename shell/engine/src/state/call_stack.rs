//! Immutable call facts shared by isolated shells. The live vectors contain only
//! Rc slots, so entering a function never copies its ancestors' array contents.
use super::{FunctionFrame, SharedState, SnapshotValue, State, snapshot_steps, snapshot_vec};
use crate::exec::{Error, RetainedStorage, StorageAllocation, StorageBudget, Work};
use crate::executor::Cancel;
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Debug, Default)]
pub(super) struct CallStack {
    frames: Vec<Rc<CallSite>>,
    arguments: Vec<Rc<CallArguments>>,
    slots: Option<Rc<RefCell<StorageAllocation>>>,
}

#[derive(Debug)]
pub(crate) struct CallSite {
    pub(crate) name: String,
    pub(crate) source: String,
    pub(crate) line: String,
    arguments: bool,
    _storage: Option<RetainedStorage>,
}

#[derive(Debug)]
struct CallArguments {
    count: String,
    values: Vec<String>,
    end: usize,
    _storage: Option<RetainedStorage>,
}

impl SnapshotValue for Rc<CallSite> {
    fn snapshot_bytes(&self) -> usize {
        0
    }
}
impl SnapshotValue for Rc<CallArguments> {
    fn snapshot_bytes(&self) -> usize {
        0
    }
}

impl CallStack {
    pub(super) async fn snapshot(
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<Self, Error> {
        let slots = {
            let state = state.borrow();
            let count = state
                .call_stack
                .frames
                .len()
                .checked_add(state.call_stack.arguments.len())
                .ok_or(2)?;
            let bytes = count.checked_mul(std::mem::size_of::<usize>()).ok_or(2)?;
            state
                .admit_temporary(bytes)?
                .map(|ticket| Rc::new(RefCell::new(ticket)))
        };
        Ok(Self {
            frames: snapshot_vec(state, |s| &s.call_stack.frames, cancel, work).await?,
            arguments: snapshot_vec(state, |s| &s.call_stack.arguments, cancel, work).await?,
            slots,
        })
    }
    fn reserve(
        &mut self,
        memory: Option<&StorageBudget>,
        frame: bool,
        arguments: bool,
    ) -> Result<(), i32> {
        let frames = self.frames.len().checked_add(usize::from(frame)).ok_or(2)?;
        let args = self
            .arguments
            .len()
            .checked_add(usize::from(arguments))
            .ok_or(2)?;
        let count = frames
            .max(self.frames.capacity())
            .checked_add(args.max(self.arguments.capacity()))
            .ok_or(2)?;
        let bytes = count.checked_mul(std::mem::size_of::<usize>()).ok_or(2)?;
        if let Some(slots) = &self.slots {
            slots
                .borrow_mut()
                .resize(bytes)
                .map_err(|_| crate::exec::RESOURCE_STATUS)?;
        } else if let Some(memory) = memory {
            self.slots = Some(Rc::new(RefCell::new(
                memory
                    .admit(bytes)
                    .map_err(|_| crate::exec::RESOURCE_STATUS)?,
            )));
        }
        if frame {
            self.frames.try_reserve_exact(1).map_err(|_| 2)?;
        }
        if arguments {
            self.arguments.try_reserve_exact(1).map_err(|_| 2)?;
        }
        Ok(())
    }
    pub(super) fn special(name: &str) -> bool {
        matches!(
            name,
            "FUNCNAME" | "BASH_SOURCE" | "BASH_LINENO" | "BASH_ARGC" | "BASH_ARGV"
        )
    }
    pub(super) fn count(&self, name: &str) -> usize {
        match name {
            "BASH_ARGC" => self.arguments.len(),
            "BASH_ARGV" => self.arguments.last().map_or(0, |args| args.end),
            _ => self.frames.len(),
        }
    }
    pub(super) fn element(&self, name: &str, index: i64) -> Option<&str> {
        let count = self.count(name);
        let index = if index < 0 {
            i64::try_from(count).ok()?.checked_add(index)?
        } else {
            index
        };
        let index = usize::try_from(index).ok().filter(|index| *index < count)?;
        match name {
            "BASH_ARGC" => Some(&self.arguments[self.arguments.len() - 1 - index].count),
            "BASH_ARGV" => self.argument(index),
            "FUNCNAME" => Some(&self.frames[count - 1 - index].name),
            "BASH_SOURCE" => Some(&self.frames[count - 1 - index].source),
            "BASH_LINENO" => Some(&self.frames[count - 1 - index].line),
            _ => None,
        }
    }
    fn argument(&self, index: usize) -> Option<&str> {
        let offset = self.count("BASH_ARGV").checked_sub(index + 1)?;
        let frame = self.arguments.partition_point(|args| args.end <= offset);
        let args = self.arguments.get(frame)?;
        let start = args.end - args.values.len();
        args.values.get(offset - start).map(String::as_str)
    }
    pub(super) fn pop(&mut self) {
        if self.frames.pop().is_some_and(|frame| frame.arguments) {
            self.arguments.pop();
        }
        if self.frames.is_empty() && self.arguments.is_empty() {
            self.frames = Vec::new();
            self.arguments = Vec::new();
            self.slots = None;
        }
    }
}

impl State {
    pub(crate) fn stack_array(&self, name: &str) -> bool {
        self.scalar_target(name)
            .ok()
            .flatten()
            .is_some_and(CallStack::special)
    }
    pub(crate) fn caller(&self, index: usize, named: bool) -> Option<(&str, Option<&str>, &str)> {
        let offset = self
            .call_stack
            .frames
            .len()
            .checked_sub(index.checked_add(1)?)?;
        let frame = self.call_stack.frames.get(offset)?;
        let parent = if named {
            Some(
                self.call_stack
                    .frames
                    .get(offset.checked_sub(1)?)?
                    .name
                    .as_str(),
            )
        } else {
            None
        };
        Some((&frame.line, parent, &frame.source))
    }
    pub(crate) async fn initialize_arguments(
        state: &SharedState,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        let needed = {
            let state = state.borrow();
            state.function_calls == 0 && state.call_stack.arguments.is_empty()
        };
        if !needed {
            return Ok(());
        }
        let arguments = record_arguments(state, cancel, work).await?;
        let mut state = state.borrow_mut();
        let memory = state.memory.clone();
        state.call_stack.reserve(memory.as_ref(), false, true)?;
        state.call_stack.arguments.push(arguments);
        Ok(())
    }
}

async fn record_arguments(
    state: &SharedState,
    cancel: &Cancel,
    work: &mut Work,
) -> Result<Rc<CallArguments>, Error> {
    let bytes = {
        let state = state.borrow();
        super::positional_bytes(&state.positional)?.saturating_add(
            std::mem::size_of::<CallArguments>() + 4 * std::mem::size_of::<usize>() + 20,
        )
    };
    work.admit_storage(bytes)?;
    snapshot_steps(bytes, cancel, work).await?;
    let state = state.borrow();
    let storage = state.admit_temporary(bytes)?.map(Rc::new);
    let values = state.positional.clone();
    let end = state
        .call_stack
        .count("BASH_ARGV")
        .checked_add(values.len())
        .ok_or(2)?;
    Ok(Rc::new(CallArguments {
        count: values.len().to_string(),
        values,
        end,
        _storage: storage,
    }))
}

impl FunctionFrame {
    pub(crate) async fn trace(
        &mut self,
        name: String,
        line: usize,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        let bytes = {
            let state = self.state.borrow();
            name.len()
                .saturating_add(state.shell_name.len())
                .saturating_add(
                    std::mem::size_of::<CallSite>() + 4 * std::mem::size_of::<usize>() + 20,
                )
        };
        work.admit_storage(bytes)?;
        snapshot_steps(bytes, cancel, work).await?;
        let record = self.state.borrow().extdebug;
        let arguments = if record {
            Some(record_arguments(&self.state, cancel, work).await?)
        } else {
            None
        };
        let mut state = self.state.borrow_mut();
        let storage = state.admit_temporary(bytes)?.map(Rc::new);
        let memory = state.memory.clone();
        state
            .call_stack
            .reserve(memory.as_ref(), true, arguments.is_some())?;
        let frame = Rc::new(CallSite {
            name,
            source: state.shell_name.clone(),
            line: line.to_string(),
            arguments: arguments.is_some(),
            _storage: storage,
        });
        if let Some(arguments) = arguments {
            state.call_stack.arguments.push(arguments);
        }
        state.call_stack.frames.push(frame);
        self.traced = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::StorageBudget;
    use futures::FutureExt;

    fn finish<T>(future: impl std::future::Future<Output = T>) -> T {
        futures::pin_mut!(future);
        (0..4096)
            .find_map(|_| future.as_mut().now_or_never())
            .expect("bounded stack operation")
    }
    fn work() -> Work {
        Work::new(1 << 20, 1 << 20, 0)
    }
    fn enter(state: &SharedState, name: &str, args: Vec<String>, line: usize) -> FunctionFrame {
        let mut frame = FunctionFrame::enter(state.clone(), args, 64)
            .unwrap_or_else(|_| panic!("stack operation failed"));
        finish(frame.trace(name.into(), line, &Cancel::new(), &mut work()))
            .unwrap_or_else(|_| panic!("stack operation failed"));
        frame
    }

    #[test]
    fn stack_facts_and_entry_arguments_survive_positional_changes_and_isolation() {
        let memory = StorageBudget::new(32_768);
        let state = State::with_memory(memory.clone()).shared();
        state.borrow_mut().extdebug = true;
        finish(State::initialize_arguments(
            &state,
            &Cancel::new(),
            &mut work(),
        ))
        .unwrap_or_else(|_| panic!("stack operation failed"));
        let outer = enter(&state, "outer", vec!["a".into(), "b".into()], 7);
        let inner = enter(&state, "inner", vec!["x".into()], 3);
        assert_eq!(state.borrow().array_element("FUNCNAME", -1), Some("outer"));
        assert_eq!(state.borrow().array_element("BASH_LINENO", 0), Some("3"));
        assert_eq!(state.borrow().array_element("BASH_ARGC", 2), Some("0"));
        assert_eq!(state.borrow().array_element("BASH_ARGV", 1), Some("b"));
        state
            .borrow_mut()
            .replace_positional(vec!["changed".into()])
            .unwrap_or_else(|_| panic!("stack operation failed"));
        assert_eq!(state.borrow().array_element("BASH_ARGV", 0), Some("x"));
        let child = finish(State::snapshot(&state, &Cancel::new(), &mut work()))
            .unwrap_or_else(|_| panic!("stack operation failed"));
        assert!(Rc::ptr_eq(
            &child.call_stack.frames[0],
            &state.borrow().call_stack.frames[0]
        ));
        assert!(Rc::ptr_eq(
            &child.call_stack.arguments[1],
            &state.borrow().call_stack.arguments[1]
        ));
        drop(inner);
        assert_eq!(state.borrow().scalar_parameter("FUNCNAME"), Some("outer"));
        drop(outer);
        assert_eq!(state.borrow().array_count("FUNCNAME"), 0);
        assert_eq!(state.borrow().array_count("BASH_ARGC"), 1);
        assert_eq!(child.array_count("FUNCNAME"), 2);
        assert_eq!(child.array_element("BASH_ARGV", -1), Some("a"));
        drop((state, child));
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn cancelled_and_failed_admission_publish_no_trace_and_drop_restores_positionals() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .replace_positional(vec!["root".into()])
            .unwrap_or_else(|_| panic!("stack operation failed"));
        let mut frame = FunctionFrame::enter(state.clone(), vec!["inner".into()], 64)
            .unwrap_or_else(|_| panic!("stack operation failed"));
        let cancel = Cancel::new();
        let mut work = work();
        let mut trace = Box::pin(frame.trace("x".repeat(128 * 1024), 1, &cancel, &mut work));
        assert!(trace.as_mut().now_or_never().is_none());
        cancel.cancel();
        assert!(finish(trace).is_err());
        assert_eq!(state.borrow().array_count("FUNCNAME"), 0);
        drop(frame);
        assert_eq!(state.borrow().positional(), &["root"]);
        let memory = StorageBudget::new(1);
        let state = State::with_memory(memory.clone()).shared();
        let mut frame = FunctionFrame::enter(state.clone(), Vec::new(), 64)
            .unwrap_or_else(|_| panic!("stack operation failed"));
        assert!(finish(frame.trace("f".into(), 1, &Cancel::new(), &mut self::work())).is_err());
        assert_eq!(state.borrow().array_count("FUNCNAME"), 0);
        drop(frame);
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn nondebug_calls_do_not_record_arguments_and_top_level_access_is_lazy() {
        let state = State::default().shared();
        state
            .borrow_mut()
            .replace_positional(vec!["root".into()])
            .unwrap_or_else(|_| panic!("stack operation failed"));
        let frame = enter(&state, "f", vec!["child".into()], 11);
        finish(State::admit_scalar_access(
            &state,
            "BASH_ARGV",
            &Cancel::new(),
            &mut work(),
        ))
        .unwrap_or_else(|_| panic!("stack operation failed"));
        assert_eq!(state.borrow().array_count("BASH_ARGC"), 0);
        assert_eq!(state.borrow().caller(0, false), Some(("11", None, "bash")));
        assert_eq!(state.borrow().caller(0, true), None);
        drop(frame);
        finish(State::admit_scalar_access(
            &state,
            "BASH_ARGV",
            &Cancel::new(),
            &mut work(),
        ))
        .unwrap_or_else(|_| panic!("stack operation failed"));
        let frame = enter(&state, "f", Vec::new(), 12);
        assert_eq!(state.borrow().array_element("BASH_ARGV", 0), Some("root"));
        drop(frame);
    }

    fn measure_growth(depth: usize, debug: bool) -> (usize, usize) {
        let memory = StorageBudget::new(8 << 20);
        let state = State::with_memory(memory.clone()).shared();
        state.borrow_mut().extdebug = debug;
        let mut guards = Vec::new();
        let mut growths = (0, 0);
        let mut moved_slots = 0;
        for _ in 0..depth {
            let before = state.borrow().call_stack.frames.as_ptr();
            let capacity = state.borrow().call_stack.frames.capacity();
            let arguments = state.borrow().call_stack.arguments.capacity();
            let mut frame = FunctionFrame::enter(state.clone(), vec!["x".into()], 2048)
                .unwrap_or_else(|_| panic!("call fits"));
            finish(frame.trace("f".into(), 1, &Cancel::new(), &mut work()))
                .unwrap_or_else(|_| panic!("trace fits"));
            let stack = &state.borrow().call_stack;
            growths.0 += usize::from(stack.frames.capacity() != capacity);
            growths.1 += usize::from(stack.arguments.capacity() != arguments);
            if before != stack.frames.as_ptr() {
                moved_slots += stack.frames.len() - 1;
            }
            guards.push(frame);
        }
        eprintln!(
            "depth={depth} extdebug={debug} frame_growths={} argument_growths={} moved_frame_slots={moved_slots}",
            growths.0, growths.1
        );
        while let Some(frame) = guards.pop() {
            drop(frame);
        }
        drop(state);
        assert_eq!(memory.observation().0, 0);
        growths
    }

    #[test]
    fn stack_slot_growth_is_amortized_for_ordinary_and_debug_calls() {
        let mut bounded = true;
        for (depth, maximum) in [(64, 5), (128, 6), (256, 7), (512, 8), (1024, 9)] {
            let plain = measure_growth(depth, false);
            let debug = measure_growth(depth, true);
            bounded &= plain.0 <= maximum && plain.1 == 0;
            bounded &= debug.0 <= maximum && debug.1 <= maximum;
        }
        assert!(
            bounded,
            "call slots must grow geometrically, not once per call"
        );
    }

    #[test]
    fn spare_slot_capacity_is_admitted_before_growth_and_refunded_on_drop() {
        let slot = std::mem::size_of::<usize>();
        let memory = StorageBudget::new(8 * slot);
        let mut stack = CallStack::default();
        stack.reserve(Some(&memory), true, true).unwrap();
        assert_eq!(memory.observation().0, 8 * slot);
        assert_eq!(
            (stack.frames.capacity(), stack.arguments.capacity()),
            (4, 4)
        );
        let frame = Rc::new(CallSite {
            name: "f".into(),
            source: "bash".into(),
            line: "1".into(),
            arguments: true,
            _storage: None,
        });
        let args = Rc::new(CallArguments {
            count: "0".into(),
            values: Vec::new(),
            end: 0,
            _storage: None,
        });
        stack.frames.resize(4, frame);
        stack.arguments.resize(4, args);
        assert_eq!(
            stack.reserve(Some(&memory), true, true),
            Err(crate::exec::RESOURCE_STATUS)
        );
        assert_eq!(
            (stack.frames.capacity(), stack.arguments.capacity()),
            (4, 4)
        );
        assert_eq!((stack.frames.len(), stack.arguments.len()), (4, 4));
        assert_eq!(memory.observation().0, 8 * slot);
        drop(stack);
        assert_eq!(memory.observation().0, 0);
    }
}
