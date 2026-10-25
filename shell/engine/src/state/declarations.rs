use super::{
    AssignmentKind, Binding, CaseMapping, CaseOptions, LocalOrigin, LocalVariable, Place,
    ScalarPublication, State, snapshot_node_bytes,
};
use crate::exec::{StorageAllocation, Work};
use std::borrow::Cow;

#[derive(Clone, Copy)]
pub(crate) enum DeclarationOperation {
    Local { inherit: bool },
    Assignment,
    Export,
    Readonly,
    Case { local: bool, options: CaseOptions },
    Nameref { local: bool },
}

#[derive(Clone, Copy, Default)]
pub(crate) struct DeclarationAttributes {
    pub(crate) exported: bool,
    pub(crate) readonly: bool,
}

pub(crate) struct DeclarationRequest {
    pub(crate) key: String,
    pub(crate) value: Option<String>,
    pub(crate) operation: DeclarationOperation,
    pub(crate) attributes: DeclarationAttributes,
}

pub(crate) struct PreparedDeclaration {
    key: String,
    place: Place,
    value: Option<String>,
    local: bool,
    inherit: bool,
    nameref: bool,
    case: bool,
    mapping: Option<Option<CaseMapping>>,
    attributes: DeclarationAttributes,
    attribute_storage: usize,
}

pub(crate) struct AdmittedDeclaration {
    prepared: PreparedDeclaration,
    local_save: Option<LocalVariable>,
    local_value: Option<Binding>,
    scalar: Option<ScalarPublication>,
    local_reservation: Option<StorageAllocation>,
    explicit: bool,
}

impl State {
    /// The feature layer has finished all awaits. Select current owners here;
    /// the caller admits and commits under the same mutable State borrow.
    pub(crate) fn prepare_declaration(
        &self,
        request: DeclarationRequest,
    ) -> Result<PreparedDeclaration, i32> {
        let DeclarationRequest {
            key,
            value,
            operation,
            mut attributes,
        } = request;
        attributes.exported |= matches!(operation, DeclarationOperation::Export);
        attributes.readonly |= matches!(operation, DeclarationOperation::Readonly);
        let local = matches!(
            operation,
            DeclarationOperation::Local { .. }
                | DeclarationOperation::Case { local: true, .. }
                | DeclarationOperation::Nameref { local: true }
        );
        let inherit = matches!(operation, DeclarationOperation::Local { inherit: true });
        let nameref = matches!(operation, DeclarationOperation::Nameref { .. });
        if inherit {
            self.validate_inherited_local(&key)?;
        }
        if nameref && (self.readonly.contains(&key) || self.current_local_readonly(&key)) {
            return Err(1);
        }
        if nameref && value.as_deref() == Some(&key) && !local {
            return Err(1);
        }
        let bare = matches!(operation, DeclarationOperation::Assignment)
            && value.is_none()
            && !attributes.exported
            && !attributes.readonly;
        let target = if local || nameref || bare {
            key.clone()
        } else {
            self.assignment_name(key.clone())?
        };
        if matches!(operation, DeclarationOperation::Case { .. }) && self.is_readonly(&target) {
            return Err(1);
        }
        if !local && !nameref && value.is_some() && self.is_readonly(&target) {
            return Err(1);
        }
        let mapping = self.declaration_mapping(&key, &target, operation);
        let effective = mapping
            .map(Option::unwrap_or_default)
            .unwrap_or_else(|| self.case_mapping(&target));
        let value = match value {
            Some(value) if !nameref => Some(self.case_value_with_mapping(value, effective)?),
            value => value,
        };
        // export/readonly's feature preparation already admitted their attribute
        // target before xtrace. Combined declare/local flags use the same sizing.
        let mut attribute_storage = 0usize;
        if attributes.exported && !matches!(operation, DeclarationOperation::Export) {
            attribute_storage = self
                .declaration_attribute_storage(&target, false)
                .map_err(|_| 2)?;
        }
        if attributes.readonly && !matches!(operation, DeclarationOperation::Readonly) {
            attribute_storage = attribute_storage
                .checked_add(
                    self.declaration_attribute_storage(&target, true)
                        .map_err(|_| 2)?,
                )
                .ok_or(2)?;
        }
        let place = Place {
            owner: self.reference_owner(&target),
            name: target,
            index: None,
        };
        Ok(PreparedDeclaration {
            key,
            place,
            value,
            local,
            inherit,
            nameref,
            case: matches!(operation, DeclarationOperation::Case { .. }),
            mapping,
            attributes,
            attribute_storage,
        })
    }

    fn declaration_mapping(
        &self,
        key: &str,
        target: &str,
        operation: DeclarationOperation,
    ) -> Option<Option<CaseMapping>> {
        match operation {
            DeclarationOperation::Case { local, options } => {
                let previous = if local && !self.is_current_local(key) {
                    CaseMapping::Unchanged
                } else {
                    self.case_mapping(target)
                };
                Some(Some(options.apply(previous)))
            }
            DeclarationOperation::Local { inherit: false } if !self.is_current_local(key) => {
                Some(None)
            }
            DeclarationOperation::Local { inherit: true } if !self.is_current_local(key) => {
                Some(self.case_attributes.get(key).copied())
            }
            _ => None,
        }
    }

    fn validate_inherited_local(&self, name: &str) -> Result<(), i32> {
        if self.namerefs.contains_key(name)
            || matches!(self.variables.get(name), Some(Binding::Indexed(_)))
            || self.stack_array(name)
            || self.dynamic_parameter(name)
            || name == "OPTIND"
        {
            return Err(2);
        }
        if !self.is_current_local(name) && self.is_readonly(name) {
            return Err(1);
        }
        Ok(())
    }

    /// Reserve whole-operand work and the existing local/inverse tickets.
    /// Dropping a refused or abandoned plan publishes no binding or metadata.
    pub(crate) fn admit_declaration(
        &self,
        mut prepared: PreparedDeclaration,
        work: &mut Work,
    ) -> Result<AdmittedDeclaration, i32> {
        let key = &prepared.key;
        work.admit_storage(prepared.attribute_storage)
            .map_err(|_| 2)?;
        let current = self.is_current_local(key);
        if prepared.inherit && !current {
            let copied = if prepared.value.is_none() {
                self.variables.get(key).map_or(0, Binding::storage_bytes)
            } else {
                0
            };
            work.admit_storage(copied.checked_add(self.saved_case_storage(key)).ok_or(2)?)
                .map_err(|_| 2)?;
        }
        if prepared.case {
            work.admit_storage(
                key.len()
                    .saturating_add(snapshot_node_bytes::<CaseMapping>().map_err(|_| 2)?),
            )
            .map_err(|_| 2)?;
        }
        let bytes = self.declaration_value_bytes(&prepared);
        let local_save = if prepared.local {
            self.prepare_local_save(key, bytes)?
        } else {
            None
        };
        let local_reservation = if prepared.local && current && prepared.value.is_some() {
            self.admit_temporary(self.getopts_local_growth(key, bytes)?)?
        } else {
            None
        };
        let scalar = if !prepared.local && !prepared.nameref {
            prepared
                .value
                .as_ref()
                .map(|value| self.prepare_scalar_publication(&prepared.place.name, value))
                .transpose()?
        } else {
            None
        };
        let explicit = prepared.value.is_some();
        let value = self.declaration_local_value(&mut prepared);
        Ok(AdmittedDeclaration {
            prepared,
            local_save,
            local_value: value,
            scalar,
            local_reservation,
            explicit,
        })
    }

    fn declaration_value_bytes(&self, prepared: &PreparedDeclaration) -> usize {
        if let Some(value) = &prepared.value {
            if prepared.case && prepared.local && self.is_current_local(&prepared.key) {
                return self.scalar_assignment_value_bytes(&prepared.key, value.len());
            }
            return value.len();
        }
        if prepared.local
            && !self.is_current_local(&prepared.key)
            && (prepared.inherit || self.inherits_function_prefix(&prepared.key))
        {
            return self
                .variables
                .get(&prepared.key)
                .map_or(0, Binding::storage_bytes);
        }
        0
    }

    fn declaration_local_value(&self, prepared: &mut PreparedDeclaration) -> Option<Binding> {
        if !prepared.local || prepared.nameref {
            return None;
        }
        let current = self.is_current_local(&prepared.key);
        if let Some(value) = prepared.value.take() {
            if prepared.case && current {
                let mut binding = self
                    .variables
                    .get(&prepared.key)
                    .cloned()
                    .unwrap_or_else(|| "".into());
                binding.set_scalar(value);
                return Some(binding);
            }
            return Some(value.into());
        }
        if current || !(prepared.inherit || self.inherits_function_prefix(&prepared.key)) {
            return None;
        }
        self.variables.get(&prepared.key).cloned()
    }

    /// No await, name resolution, admission, or fallible step after publication.
    pub(crate) fn commit_declaration(&mut self, admitted: AdmittedDeclaration) {
        let AdmittedDeclaration {
            prepared,
            local_save,
            local_value,
            scalar,
            local_reservation,
            explicit,
        } = admitted;
        let PreparedDeclaration {
            key,
            place,
            value,
            local,
            nameref,
            mapping,
            attributes,
            ..
        } = prepared;
        debug_assert_eq!(place.owner, self.reference_owner(&place.name));
        let current = self.is_current_local(&key);
        self.commit_local_save(&key, local_save);
        drop(local_reservation);
        if local && current && explicit {
            let bytes = if nameref {
                value.as_ref().map_or(0, String::len)
            } else {
                local_value.as_ref().map_or(0, Binding::storage_bytes)
            };
            self.reserve_local_value(&key, bytes)
                .expect("admitted declaration local growth");
        }
        if nameref {
            self.variables.remove(&key);
            self.namerefs
                .insert(key.clone(), value.expect("prepared reference target"));
        } else if local {
            self.commit_local_declaration(&key, local_value, explicit);
        } else if let (Some(value), Some(scalar)) = (value, scalar) {
            self.commit_scalar_publication(
                Cow::Borrowed(&place.name),
                value,
                AssignmentKind::Explicit,
                scalar,
            );
        }
        if let Some(mapping) = mapping {
            self.restore_case(&place.name, mapping);
        }
        self.commit_declaration_attributes(&place.name, attributes);
        if (local || nameref) && key == "IFS" {
            self.refresh_star_separator();
        }
    }

    fn commit_local_declaration(&mut self, name: &str, value: Option<Binding>, explicit: bool) {
        self.namerefs.remove(name);
        if name == "OPTIND" {
            self.getopts_numeric = false;
            self.getopts = if explicit {
                value
                    .as_ref()
                    .and_then(Binding::scalar)
                    .map(|value| super::GetoptsState::assigned(value))
                    .unwrap_or_default()
            } else {
                super::GetoptsState::default()
            };
        }
        if let Some(value) = value {
            self.variables.insert(name.to_owned(), value);
        }
    }

    fn commit_declaration_attributes(&mut self, name: &str, attributes: DeclarationAttributes) {
        if attributes.exported {
            self.exported.insert(name.to_owned());
        }
        if !attributes.readonly {
            return;
        }
        if let Some(local) = self
            .locals
            .iter_mut()
            .rev()
            .find_map(|locals| locals.get_mut(name))
        {
            local.readonly = true;
        } else {
            self.readonly.insert(name.to_owned());
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
    #[cfg(test)]
    pub(super) fn test_declaration(&mut self, request: DeclarationRequest) -> Result<(), i32> {
        let mut work = Work::new(usize::MAX, usize::MAX, usize::MAX);
        let prepared = self.prepare_declaration(request)?;
        let admitted = self.admit_declaration(prepared, &mut work)?;
        self.commit_declaration(admitted);
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

    #[cfg(test)]
    pub(crate) fn declare_inherited_local(
        &mut self,
        name: String,
        value: Option<String>,
        work: &mut Work,
    ) -> Result<(), i32> {
        let request = DeclarationRequest {
            key: name,
            value,
            operation: DeclarationOperation::Local { inherit: true },
            attributes: DeclarationAttributes::default(),
        };
        let prepared = self.prepare_declaration(request)?;
        let admitted = self.admit_declaration(prepared, work)?;
        self.commit_declaration(admitted);
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

    fn request(value: Option<&str>, operation: DeclarationOperation) -> DeclarationRequest {
        DeclarationRequest {
            key: "v".into(),
            value: value.map(str::to_owned),
            operation,
            attributes: DeclarationAttributes {
                exported: true,
                readonly: true,
            },
        }
    }

    #[test]
    fn declaration_bridge_drop_and_refusal_publish_no_local_or_attributes() {
        let memory = StorageBudget::new(64 * 1024);
        let state = State::with_memory(memory.clone()).shared();
        state
            .borrow_mut()
            .assign_parameter("v".into(), "outer".into())
            .unwrap();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), 8).unwrap();
        let before = memory.observation().0;
        let operation = DeclarationOperation::Local { inherit: true };
        let prepared = state
            .borrow()
            .prepare_declaration(request(None, operation))
            .unwrap_or_else(|_| panic!("valid request"));
        let mut short = Work::new(100, 0, 0);
        assert!(matches!(
            state.borrow().admit_declaration(prepared, &mut short),
            Err(2)
        ));
        let pressure = memory.admit(64 * 1024 - before).unwrap();
        let prepared = state
            .borrow()
            .prepare_declaration(request(None, operation))
            .unwrap_or_else(|_| panic!("valid request"));
        let mut work = Work::new(100, 4096, 0);
        assert!(matches!(
            state.borrow().admit_declaration(prepared, &mut work),
            Err(RESOURCE_STATUS)
        ));
        drop(pressure);
        let prepared = state
            .borrow()
            .prepare_declaration(request(None, operation))
            .unwrap_or_else(|_| panic!("valid request"));
        let admitted = state
            .borrow()
            .admit_declaration(prepared, &mut work)
            .unwrap_or_else(|_| panic!("admitted local"));
        assert!(memory.observation().0 > before);
        assert!(!state.borrow().is_current_local("v"));
        drop(admitted);
        assert_eq!(memory.observation().0, before);
        let view = state.borrow();
        assert_eq!(view.parameter("v"), "outer");
        assert!(!view.declaration("v").unwrap().exported);
        assert!(!view.declaration("v").unwrap().readonly);
        drop(view);
        drop(frame);
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn declaration_bridge_commit_restores_named_local_metadata_and_refunds() {
        let memory = StorageBudget::new(64 * 1024);
        let state = State::with_memory(memory.clone()).shared();
        state
            .borrow_mut()
            .assign_parameter("v".into(), "outer".into())
            .unwrap();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), 8).unwrap();
        let mut work = Work::new(100, 4096, 0);
        let mut borrowed = state.borrow_mut();
        let prepared = borrowed
            .prepare_declaration(request(
                Some("inner"),
                DeclarationOperation::Local { inherit: false },
            ))
            .unwrap_or_else(|_| panic!("valid request"));
        let admitted = borrowed
            .admit_declaration(prepared, &mut work)
            .unwrap_or_else(|_| panic!("admitted local"));
        assert_eq!(borrowed.parameter("v"), "outer");
        borrowed.commit_declaration(admitted);
        assert_eq!(borrowed.parameter("v"), "inner");
        assert!(borrowed.declaration("v").unwrap().exported);
        assert!(borrowed.declaration("v").unwrap().readonly);
        drop(borrowed);
        drop(frame);
        let borrowed = state.borrow();
        assert_eq!(borrowed.parameter("v"), "outer");
        assert!(!borrowed.declaration("v").unwrap().exported);
        assert!(!borrowed.declaration("v").unwrap().readonly);
        assert_eq!(memory.observation().0, 0);
    }

    #[test]
    fn declaration_bridge_combined_flag_admission_precedes_value_and_attributes() {
        let mut state = State::default();
        state.assign_parameter("v".into(), "outer".into()).unwrap();
        let bytes = state.declaration_attribute_storage("v", false).unwrap()
            + state.declaration_attribute_storage("v", true).unwrap();
        let prepared = state
            .prepare_declaration(request(Some("inner"), DeclarationOperation::Assignment))
            .unwrap_or_else(|_| panic!("valid request"));
        let mut short = Work::new(100, bytes - 1, 0);
        assert!(matches!(
            state.admit_declaration(prepared, &mut short),
            Err(2)
        ));
        assert_eq!(state.parameter("v"), "outer");
        assert!(!state.declaration("v").unwrap().exported);
        assert!(!state.declaration("v").unwrap().readonly);
        let prepared = state
            .prepare_declaration(request(Some("inner"), DeclarationOperation::Assignment))
            .unwrap_or_else(|_| panic!("valid request"));
        let mut exact = Work::new(100, bytes, 0);
        let admitted = state
            .admit_declaration(prepared, &mut exact)
            .unwrap_or_else(|_| panic!("exact flags fit"));
        state.commit_declaration(admitted);
        assert_eq!(state.parameter("v"), "inner");
        assert!(state.declaration("v").unwrap().exported);
        assert!(state.declaration("v").unwrap().readonly);
    }

    #[test]
    fn declaration_bridge_plain_locals_keep_absent_case_metadata_absent() {
        let state = State::default().shared();
        let frame = FunctionFrame::enter(state.clone(), Vec::new(), 8).unwrap();
        let mut work = Work::new(100, 4096, 0);
        for inherit in [false, true] {
            let mut borrowed = state.borrow_mut();
            let prepared = borrowed
                .prepare_declaration(DeclarationRequest {
                    key: "v".into(),
                    value: None,
                    operation: DeclarationOperation::Local { inherit },
                    attributes: DeclarationAttributes::default(),
                })
                .unwrap_or_else(|_| panic!("valid local"));
            let admitted = borrowed
                .admit_declaration(prepared, &mut work)
                .unwrap_or_else(|_| panic!("admitted local"));
            borrowed.commit_declaration(admitted);
            assert!(!borrowed.case_attributes.contains_key("v"));
        }
        drop(frame);
        assert!(state.borrow().declaration("v").is_none());
    }

    #[test]
    fn declaration_bridge_case_refusal_preserves_value_mapping_and_attributes() {
        let memory = StorageBudget::new(4096);
        let mut state = State::with_memory(memory.clone());
        state.assign_parameter("v".into(), "outer".into()).unwrap();
        state
            .assign_parameter("LC_ALL".into(), "C.UTF-8".into())
            .unwrap();
        let mut options = super::CaseOptions::default();
        options.flag(true, true);
        let pressure = memory.admit(4096).unwrap();
        let prepared = state.prepare_declaration(request(
            Some("é"),
            DeclarationOperation::Case {
                local: false,
                options,
            },
        ));
        assert!(matches!(prepared, Err(RESOURCE_STATUS)));
        assert_eq!(state.parameter("v"), "outer");
        assert_eq!(state.case_mapping("v"), CaseMapping::Unchanged);
        assert!(!state.declaration("v").unwrap().exported);
        assert!(!state.declaration("v").unwrap().readonly);
        drop(pressure);
        assert_eq!(memory.observation().0, 0);
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
