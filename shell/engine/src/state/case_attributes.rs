use super::{
    AssignmentKind, CASE_ATTRIBUTES, CaseLocale, NAMEREFS, ScalarResolution, SnapshotValue, State,
    snapshot_node_bytes,
};
use crate::exec::Work;
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CaseMapping {
    #[default]
    Unchanged,
    Lower,
    Upper,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct CaseOptions {
    set: u8,
    clear: u8,
}
impl CaseOptions {
    pub(crate) fn flag(&mut self, upper: bool, enabled: bool) {
        let bit = if upper { 2 } else { 1 };
        if enabled {
            self.set |= bit;
        } else {
            self.clear |= bit;
        }
    }
    pub(crate) fn specified(self) -> bool {
        self.set != 0 || self.clear != 0
    }
    fn apply(self, previous: CaseMapping) -> CaseMapping {
        let mapping = match self.set {
            1 => CaseMapping::Lower,
            2 => CaseMapping::Upper,
            3 => CaseMapping::Unchanged,
            _ => previous,
        };
        match mapping {
            CaseMapping::Lower if self.clear & 1 != 0 => CaseMapping::Unchanged,
            CaseMapping::Upper if self.clear & 2 != 0 => CaseMapping::Unchanged,
            _ => mapping,
        }
    }
}

impl SnapshotValue for CaseMapping {
    fn snapshot_bytes(&self) -> usize {
        0
    }
}

impl State {
    pub(crate) fn case_mapping(&self, name: &str) -> CaseMapping {
        self.case_attributes.get(name).copied().unwrap_or_default()
    }
    pub(crate) fn case_value(&self, name: &str, value: String) -> Result<String, i32> {
        let name = self.scalar_target(name)?.ok_or(1)?;
        if self.is_readonly(name) {
            return Ok(value);
        }
        self.map_case_value(self.case_mapping(name), value)
    }

    fn map_case_value(&self, mapping: CaseMapping, value: String) -> Result<String, i32> {
        self.map_case_in_locale(mapping, value, || CaseLocale::from_state(self))
    }

    pub(crate) fn map_case_in_locale(
        &self,
        mapping: CaseMapping,
        mut value: String,
        locale: impl FnOnce() -> Result<CaseLocale, crate::exec::Error>,
    ) -> Result<String, i32> {
        if mapping == CaseMapping::Unchanged {
            return Ok(value);
        }
        let locale = locale().map_err(|_| 2)?;
        let upper = mapping == CaseMapping::Upper;
        if value.is_ascii() {
            if upper {
                value.make_ascii_uppercase();
            } else {
                value.make_ascii_lowercase();
            }
            return Ok(value);
        }
        for ch in value.chars() {
            locale.map(ch, upper).map_err(|_| 2)?;
        }
        let _temporary = self.admit_temporary(value.len())?;
        let mut mapped = String::with_capacity(value.len());
        for ch in value.chars() {
            mapped.push(locale.map(ch, upper).map_err(|_| 2)?);
        }
        Ok(mapped)
    }
    pub(crate) fn declare_case(
        &mut self,
        name: String,
        value: Option<String>,
        local: bool,
        options: CaseOptions,
        work: &mut Work,
    ) -> Result<(), i32> {
        let name = if local {
            name
        } else {
            self.assignment_name(name)?
        };
        if self.is_readonly(&name) {
            return Err(1);
        }
        let bytes = name
            .len()
            .saturating_add(snapshot_node_bytes::<CaseMapping>().map_err(|_| 2)?);
        work.admit_storage(bytes).map_err(|_| 2)?;
        let current_local = self.is_current_local(&name);
        let mapping = if local && !current_local {
            CaseMapping::Unchanged
        } else {
            self.case_mapping(&name)
        };
        let mapping = options.apply(mapping);
        let value = value
            .map(|value| {
                self.map_case_in_locale(mapping, value, || {
                    if local {
                        self.case_locale_after_local(&name, current_local)
                    } else {
                        CaseLocale::from_state(self)
                    }
                })
            })
            .transpose()?;
        if local && !(current_local && value.is_some()) {
            self.install_local(name.clone(), value, false, true, CASE_ATTRIBUTES)?;
        } else {
            self.apply_case_assignment(&name, value, local)?;
        }
        self.case_attributes.insert(name, mapping);
        Ok(())
    }

    // Assignment case conversion runs after the bare local shadows its outer binding.
    fn case_locale_after_local(
        &self,
        name: &str,
        current_local: bool,
    ) -> Result<CaseLocale, crate::exec::Error> {
        let keeps_value = current_local || self.inherits_function_prefix(name);
        CaseLocale::from_parameters(|parameter| {
            let ScalarResolution::Target(target) = Self::resolve_scalar_with(parameter, |key| {
                (key != name).then(|| self.nameref_at(key, None)).flatten()
            }) else {
                return None;
            };
            if target == name
                && !keeps_value
                && target != "PWD"
                && !self.special_stack_array(target)
            {
                return None;
            }
            self.scalar_value(target)
        })
    }

    fn apply_case_assignment(
        &mut self,
        name: &str,
        value: Option<String>,
        local: bool,
    ) -> Result<(), i32> {
        if local && self.readonly.contains(name) {
            return Err(1);
        }
        let changes =
            CASE_ATTRIBUTES | (u8::from(local) * (self.binding_removals(name) & NAMEREFS));
        let copies = self.reserve_binding_changes(name, changes)?;
        let Some(value) = value else {
            copies.install(self, name);
            return Ok(());
        };
        let assignment = self.admit_scalar_write(name, value.capacity())?;
        copies.install(self, name);
        if local {
            self.namerefs.remove(name);
            if name == "OPTIND" {
                self.getopts_numeric = false;
                self.getopts = Default::default();
            }
        }
        self.write_scalar(
            Cow::Borrowed(name),
            value,
            AssignmentKind::Explicit,
            assignment,
        );
        Ok(())
    }
    pub(super) fn saved_case_storage(&self, name: &str) -> usize {
        if !self.case_attributes.contains_key(name) {
            return 0;
        }
        name.len()
            .saturating_add(snapshot_node_bytes::<CaseMapping>().unwrap_or(usize::MAX))
    }
    pub(super) fn restore_case(&mut self, name: &str, mapping: Option<CaseMapping>) {
        match mapping {
            Some(mapping) => {
                self.case_attributes.insert(name.to_owned(), mapping);
            }
            None => {
                self.case_attributes.remove(name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{RESOURCE_STATUS, StorageBudget};
    use crate::state::FunctionFrame;

    #[test]
    fn case_declaration_uses_locale_after_shadowing() {
        for name in ["LC_ALL", "LC_CTYPE", "LANG"] {
            let state = State::default().shared();
            state
                .borrow_mut()
                .assign_parameter(name.into(), "unsupported".into())
                .unwrap();
            let frame = FunctionFrame::enter(state.clone(), Vec::new(), 8).unwrap();
            let mut options = CaseOptions::default();
            options.flag(true, true);
            let mut work = Work::new(100, 4096, 0);
            assert_eq!(
                state.borrow_mut().declare_case(
                    name.into(),
                    Some("C".into()),
                    true,
                    options,
                    &mut work,
                ),
                Ok(())
            );
            assert_eq!(state.borrow().parameter(name), "C");
            drop(frame);
            assert_eq!(state.borrow().parameter(name), "unsupported");
        }
    }

    #[test]
    fn case_declaration_uses_fallback_when_shadowing_a_locale_nameref_target() {
        let mut state = State::default();
        state
            .assign_parameter("locale".into(), "unsupported".into())
            .unwrap();
        state
            .assign_parameter("LANG".into(), "C.UTF-8".into())
            .unwrap();
        state
            .declare_nameref("LC_ALL".into(), "locale".into(), false)
            .unwrap();
        let state = state.shared();
        let _frame = FunctionFrame::enter(state.clone(), Vec::new(), 8).unwrap();
        let mut options = CaseOptions::default();
        options.flag(true, true);
        let mut work = Work::new(100, 4096, 0);
        state
            .borrow_mut()
            .declare_case("locale".into(), Some("é".into()), true, options, &mut work)
            .unwrap();
        assert_eq!(state.borrow().parameter("LC_ALL"), "É");
    }

    #[test]
    fn case_attribute_admission_precedes_mutation() {
        let mut state = State::default();
        let mut options = CaseOptions::default();
        options.flag(true, true);
        let mut work = Work::new(100, 0, 0);
        assert_eq!(
            state.declare_case("x".into(), Some("mixed".into()), false, options, &mut work),
            Err(2)
        );
        assert!(!state.case_attributes.contains_key("x"));
        assert!(!state.variables.contains_key("x"));
    }

    #[test]
    fn case_mapping_temporary_storage_is_admitted_and_refunded() {
        let memory = StorageBudget::new(256);
        let mut state = State::with_memory(memory.clone());
        state
            .assign_parameter("LC_ALL".into(), "C.UTF-8".into())
            .unwrap();
        state.case_attributes.insert("x".into(), CaseMapping::Upper);
        let pressure = memory.admit(256).unwrap();
        assert_eq!(
            state.assign_parameter("x".into(), "é".into()),
            Err(RESOURCE_STATUS)
        );
        assert!(!state.variables.contains_key("x"));
        assert_eq!(memory.observation().0, 256);
        drop(pressure);
        state.assign_parameter("x".into(), "é".into()).unwrap();
        assert_eq!(state.parameter("x"), "É");
        assert_eq!(memory.observation().0, 0);
    }
}
