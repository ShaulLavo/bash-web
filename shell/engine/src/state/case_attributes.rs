use super::{CaseLocale, SnapshotValue, State, snapshot_node_bytes};
#[cfg(test)]
use crate::exec::Work;

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
    pub(super) fn apply(self, previous: CaseMapping) -> CaseMapping {
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
        let mapping = if self.is_readonly(name) {
            CaseMapping::Unchanged
        } else {
            self.case_mapping(name)
        };
        self.case_value_with_mapping(value, mapping)
    }
    pub(super) fn case_value_with_mapping(
        &self,
        mut value: String,
        mapping: CaseMapping,
    ) -> Result<String, i32> {
        if mapping == CaseMapping::Unchanged {
            return Ok(value);
        }
        let locale = CaseLocale::from_state(self).map_err(|_| 2)?;
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
    #[cfg(test)]
    pub(crate) fn declare_case(
        &mut self,
        name: String,
        value: Option<String>,
        local: bool,
        options: CaseOptions,
        work: &mut Work,
    ) -> Result<(), i32> {
        let request = super::DeclarationRequest {
            key: name,
            value,
            operation: super::DeclarationOperation::Case { local, options },
            attributes: super::DeclarationAttributes::default(),
        };
        let prepared = self.prepare_declaration(request)?;
        let admitted = self.admit_declaration(prepared, work)?;
        self.commit_declaration(admitted);
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
