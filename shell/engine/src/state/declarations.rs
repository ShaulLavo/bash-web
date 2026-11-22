use super::{Binding, CaseOptions, EXPORTED, LocalOrigin, READONLY, State};
use crate::exec::Work;

#[derive(Clone, Copy)]
pub(crate) enum DeclarationKind {
    Scalar,
    Local,
    InheritedLocal,
    Case { local: bool, options: CaseOptions },
}

impl DeclarationKind {
    fn is_local(self) -> bool {
        match self {
            Self::Scalar => false,
            Self::Local | Self::InheritedLocal => true,
            Self::Case { local, .. } => local,
        }
    }

    fn check_write(self, state: &State, target: &str, assigned: bool) -> Result<(), i32> {
        match self {
            Self::Local => state.check_local_declaration(target),
            Self::InheritedLocal => state.check_inherited_declaration(target),
            Self::Scalar if !assigned => Ok(()),
            _ if state.is_readonly(target) => Err(1),
            Self::Case { local: true, .. } => state.check_local_declaration(target),
            Self::Scalar | Self::Case { .. } => Ok(()),
        }
    }

    fn apply(
        self,
        state: &mut State,
        name: String,
        value: Option<String>,
        work: &mut Work,
    ) -> Result<(), i32> {
        match self {
            Self::Local => state.declare_local(name, value),
            Self::InheritedLocal => state.declare_inherited_local(name, value, work),
            Self::Case { local, options } => state.declare_case(name, value, local, options, work),
            Self::Scalar => value.map_or(Ok(()), |value| state.assign_parameter(name, value)),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) struct DeclarationView<'a> {
    pub(crate) value: Option<&'a str>,
    pub(crate) nameref: bool,
    pub(crate) readonly: bool,
    pub(crate) exported: bool,
    pub(crate) case: super::CaseMapping,
}

impl State {
    pub(crate) fn declare_with_attributes(
        &mut self,
        name: String,
        value: Option<String>,
        kind: DeclarationKind,
        exported: bool,
        readonly: bool,
        work: &mut Work,
    ) -> Result<(), i32> {
        if !exported && !readonly {
            return kind.apply(self, name, value, work);
        }
        let target = if kind.is_local() {
            name.clone()
        } else {
            self.assignment_name(name.clone())?
        };
        kind.check_write(self, &target, value.is_some())?;
        let local = kind.is_local()
            || self
                .locals
                .iter()
                .any(|locals| locals.contains_key(&target));
        let changes = (u8::from(exported && !self.exported.contains(&target)) * EXPORTED)
            | (u8::from(readonly && !local && !self.readonly.contains(&target)) * READONLY);
        let copies = self.reserve_binding_changes(&target, changes)?;
        kind.apply(self, name, value, work)?;
        copies.install(self, &target);
        if exported {
            self.exported.insert(target.clone());
        }
        if readonly {
            self.mark_readonly(target);
        }
        Ok(())
    }

    pub(super) fn check_local_declaration(&self, name: &str) -> Result<(), i32> {
        if self.readonly.contains(name)
            || self.current_local_readonly(name)
            || self.locals.is_empty()
        {
            return Err(1);
        }
        Ok(())
    }

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
        work: &mut Work,
    ) -> Result<(), i32> {
        self.check_inherited_declaration(&name)?;
        if self.is_current_local(&name) {
            return self.declare_local(name, value);
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

    fn check_inherited_declaration(&self, name: &str) -> Result<(), i32> {
        if self.namerefs.contains_key(name)
            || matches!(self.variables.get(name), Some(Binding::Indexed(_)))
            || self.stack_array(name)
            || self.dynamic_parameter(name)
            || name == "OPTIND"
        {
            return Err(2);
        }
        if self.is_readonly(name) {
            return Err(1);
        }
        self.check_local_declaration(name)
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
        executor::Cancel,
        state::{CaseMapping, FunctionFrame},
    };
    use futures::FutureExt;

    #[test]
    fn readonly_assignment_is_rejected_before_copying_exports() {
        const LIMIT: usize = 64 * 1024;
        let memory = StorageBudget::new(LIMIT);
        let mut state = State::with_memory(memory.clone());
        state.readonly("dst".into(), Some("old".into())).unwrap();
        state
            .declare_nameref("ref".into(), "dst".into(), false)
            .unwrap();
        for index in 0..60 {
            state
                .export(format!("v{index}{}", "x".repeat(512)), None)
                .unwrap();
        }
        let state = state.shared();
        let mut work = Work::new(65536, 128 * 1024, 0);
        let snapshot = State::snapshot(&state, &Cancel::new(), &mut work)
            .now_or_never()
            .expect("short snapshot does not yield")
            .unwrap_or_else(|_| panic!("snapshot fits"));
        let pressure = memory.admit(LIMIT / 2).unwrap();
        let before = memory.observation().0;
        let mut state = state.borrow_mut();
        for name in ["dst", "ref"] {
            assert_eq!(
                state.declare_with_attributes(
                    name.into(),
                    Some("new".into()),
                    DeclarationKind::Scalar,
                    true,
                    false,
                    &mut work,
                ),
                Err(1)
            );
        }
        assert_eq!(state.parameter("dst"), "old");
        assert!(!state.declaration("dst").unwrap().exported);
        assert_eq!(memory.observation().0, before);
        drop(pressure);
        state
            .declare_with_attributes(
                "ref".into(),
                None,
                DeclarationKind::Scalar,
                true,
                false,
                &mut work,
            )
            .unwrap();
        assert!(state.declaration("dst").unwrap().exported);
        assert!(!snapshot.declaration("dst").unwrap().exported);
    }

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
