use super::{Binding, LocalOrigin, State};

#[derive(Clone, Copy)]
pub(crate) struct DeclarationView<'a> {
    pub(crate) value: Option<&'a str>,
    pub(crate) nameref: bool,
    pub(crate) readonly: bool,
    pub(crate) exported: bool,
    pub(crate) case: super::CaseMapping,
}

impl State {
    pub(crate) fn declaration_append_base(
        &self,
        name: &str,
        local: bool,
        inherit: bool,
    ) -> Option<&str> {
        if !local {
            return self.scalar_parameter(name);
        }
        if !inherit && !self.is_current_local(name) && !self.inherits_function_prefix(name) {
            return None;
        }
        self.variables
            .get(name)
            .and_then(Binding::scalar)
            .map(String::as_str)
    }

    pub(crate) fn declare_inherited_local(
        &mut self,
        name: String,
        value: Option<String>,
        work: &mut crate::exec::Work,
    ) -> Result<(), i32> {
        if self.namerefs.contains_key(&name)
            || matches!(self.variables.get(&name), Some(Binding::Indexed(_)))
            || self.stack_array(&name)
            || self.dynamic_parameter(&name)
            || name == "OPTIND"
        {
            return Err(2);
        }
        if self.is_current_local(&name) {
            return self.declare_local(name, value);
        }
        if self.is_readonly(&name) {
            return Err(1);
        }
        let mapping = self.case_attributes.get(&name).copied();
        let copied_value = if value.is_none() {
            self.variables.get(&name).map_or(0, Binding::storage_bytes)
        } else {
            0
        };
        let bytes = copied_value
            .checked_add(self.saved_case_storage(&name))
            .ok_or(2)?;
        work.admit_storage(bytes).map_err(|_| 2)?;
        self.declare_local_value(name.clone(), value, true)?;
        self.restore_case(&name, mapping);
        Ok(())
    }

    pub(super) fn inherits_function_prefix(&self, name: &str) -> bool {
        self.locals
            .iter()
            .rev()
            .find_map(|scope| scope.get(name))
            .is_some_and(|binding| binding.origin != LocalOrigin::Declaration)
    }

    /// Inspect the named declaration, not the value reached through a nameref.
    pub(crate) fn declaration(&self, name: &str) -> Option<DeclarationView<'_>> {
        let reference = self.namerefs.get(name);
        let binding = self.variables.get(name);
        let value = reference.or_else(|| binding.and_then(Binding::scalar));
        let local = self.locals.iter().rev().find_map(|scope| scope.get(name));
        let readonly = local.map_or_else(|| self.readonly.contains(name), |local| local.readonly);
        let exported = self.exported.contains(name);
        if binding.is_none()
            && value.is_none()
            && local.is_none()
            && !readonly
            && !exported
            && !self.case_attributes.contains_key(name)
        {
            return None;
        }
        Some(DeclarationView {
            value: value.map(String::as_str),
            nameref: reference.is_some(),
            readonly,
            exported,
            case: self.case_mapping(name),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        exec::{RESOURCE_STATUS, StorageBudget, Work},
        state::{CaseMapping, FunctionFrame},
    };

    #[test]
    fn inherited_local_admission_preserves_outer_attributes_and_refunds_on_return() {
        let memory = StorageBudget::new(64 * 1024);
        let state = State::with_memory(memory.clone()).shared();
        state
            .borrow_mut()
            .assign_parameter("v".into(), "OUTER".into())
            .unwrap();
        state
            .borrow_mut()
            .case_attributes
            .insert("v".into(), CaseMapping::Upper);
        state.borrow_mut().export("v".into(), None).unwrap();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), 8).unwrap();
        let before = memory.observation().0;
        let mut work = Work::new(100, 0, 0);
        assert_eq!(
            state
                .borrow_mut()
                .declare_inherited_local("v".into(), None, &mut work),
            Err(2)
        );
        assert!(!state.borrow().is_current_local("v"));
        assert_eq!(state.borrow().parameter("v"), "OUTER");
        assert_eq!(memory.observation().0, before);
        let pressure = memory.admit(64 * 1024 - before).unwrap();
        let mut work = Work::new(100, 4096, 0);
        assert_eq!(
            state
                .borrow_mut()
                .declare_inherited_local("v".into(), None, &mut work),
            Err(RESOURCE_STATUS)
        );
        assert!(!state.borrow().is_current_local("v"));
        assert_eq!(state.borrow().case_mapping("v"), CaseMapping::Upper);
        drop(pressure);
        state
            .borrow_mut()
            .declare_inherited_local("v".into(), None, &mut work)
            .unwrap();
        state
            .borrow_mut()
            .assign_parameter("v".into(), "mixed".into())
            .unwrap();
        assert_eq!(state.borrow().parameter("v"), "MIXED");
        drop(frame);
        let state = state.borrow();
        let outer = state.declaration("v").unwrap();
        assert_eq!(outer.value, Some("OUTER"));
        assert!(outer.exported);
        assert_eq!(outer.case, CaseMapping::Upper);
        assert_eq!(memory.observation().0, 0);
    }
}
