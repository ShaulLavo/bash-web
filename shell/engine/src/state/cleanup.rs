use crate::exec::Error;

use super::{BindingCopies, CASE_ATTRIBUTES, EXPORTED, LocalVariable, NAMEREFS, State, VARIABLES};

impl State {
    pub(super) fn local_restore_changes(&self, name: &str, local: &LocalVariable) -> u8 {
        let variables = local.previous.is_some() || self.variables.contains_key(name);
        let exported = local.exported != self.exported.contains(name);
        let case = local.case_mapping.as_ref() != self.case_attributes.get(name);
        let nameref = local.nameref.as_ref() != self.namerefs.get(name);
        (u8::from(variables) * VARIABLES)
            | (u8::from(exported) * EXPORTED)
            | (u8::from(case) * CASE_ATTRIBUTES)
            | (u8::from(nameref) * NAMEREFS)
    }

    fn pending_cleanup(&self) -> u8 {
        let mut changes = 0;
        for (name, local) in self.locals[self.inherited_locals..].iter().flatten() {
            let mut local_changes = self.local_restore_changes(name, local);
            if name == "_" {
                local_changes &= !VARIABLES;
            }
            changes |= local_changes;
        }
        if self.external_restores != 0 || self.has_pending_prefix_restore() {
            changes |= VARIABLES;
        }
        changes
    }

    fn has_pending_prefix_restore(&self) -> bool {
        self.prefixes
            .iter()
            .skip(self.inherited_prefixes)
            .flatten()
            .any(|(name, saved)| {
                name != "_" && (saved.value.is_some() || self.variables.contains_key(name))
            })
    }

    pub(super) fn reserve_snapshot_cleanup(&self) -> Result<(), Error> {
        let Some(memory) = &self.memory else {
            return Ok(());
        };
        let changes = self.pending_cleanup();
        let variables = (changes & VARIABLES != 0)
            .then(|| self.variables.ordinary.reserve_cleanup(memory))
            .transpose()?
            .flatten();
        let exported = (changes & EXPORTED != 0)
            .then(|| self.exported.reserve_cleanup(memory))
            .transpose()?
            .flatten();
        let case = (changes & CASE_ATTRIBUTES != 0)
            .then(|| self.case_attributes.reserve_cleanup(memory))
            .transpose()?
            .flatten();
        let namerefs = (changes & NAMEREFS != 0)
            .then(|| self.namerefs.reserve_cleanup(memory))
            .transpose()?
            .flatten();
        self.variables.ordinary.install_cleanup(variables);
        self.exported.install_cleanup(exported);
        self.case_attributes.install_cleanup(case);
        self.namerefs.install_cleanup(namerefs);
        Ok(())
    }

    pub(super) fn prepare_binding_restore(&mut self, name: &str, changes: u8) {
        let budgeted = self.memory.is_some();
        if changes & VARIABLES != 0 && name != "_" {
            self.variables.ordinary.require_cleanup_copy(budgeted);
        }
        if changes & EXPORTED != 0 {
            self.exported.require_cleanup_copy(budgeted);
        }
        if changes & CASE_ATTRIBUTES != 0 {
            self.case_attributes.require_cleanup_copy(budgeted);
        }
        if changes & NAMEREFS != 0 {
            self.namerefs.require_cleanup_copy(budgeted);
        }
        BindingCopies {
            changes,
            ..BindingCopies::default()
        }
        .install(self, name);
    }

    pub(super) fn release_unused_cleanup(&self) {
        let held = (u8::from(self.variables.ordinary.has_cleanup_copy()) * VARIABLES)
            | (u8::from(self.exported.has_cleanup_copy()) * EXPORTED)
            | (u8::from(self.case_attributes.has_cleanup_copy()) * CASE_ATTRIBUTES)
            | (u8::from(self.namerefs.has_cleanup_copy()) * NAMEREFS);
        if held == 0 {
            return;
        }
        let unused = held & !self.pending_cleanup();
        if unused & VARIABLES != 0 {
            self.variables.ordinary.take_cleanup_copy();
        }
        if unused & EXPORTED != 0 {
            self.exported.take_cleanup_copy();
        }
        if unused & CASE_ATTRIBUTES != 0 {
            self.case_attributes.take_cleanup_copy();
        }
        if unused & NAMEREFS != 0 {
            self.namerefs.take_cleanup_copy();
        }
    }
}
