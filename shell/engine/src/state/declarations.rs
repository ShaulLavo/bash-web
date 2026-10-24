use super::{Binding, LocalOrigin, State};

#[derive(Clone, Copy)]
pub(crate) struct DeclarationView<'a> {
    pub(crate) value: Option<&'a str>,
    pub(crate) nameref: bool,
    pub(crate) readonly: bool,
    pub(crate) exported: bool,
    pub(crate) case: super::CaseMapping,
    pub(crate) integer: bool,
}

impl State {
    pub(crate) fn declaration_append_base(&self, name: &str, local: bool) -> Option<&str> {
        if !local {
            return self.scalar_parameter(name);
        }
        if !self.is_current_local(name) && !self.inherits_function_prefix(name) {
            return None;
        }
        self.variables
            .get(name)
            .and_then(Binding::scalar)
            .map(String::as_str)
    }

    pub(super) fn inherits_function_prefix(&self, name: &str) -> bool {
        self.locals
            .iter()
            .rev()
            .find_map(|scope| scope.get(name))
            .is_some_and(|binding| binding.origin != LocalOrigin::Declaration)
    }

    /// Inspect the named declaration, not the value reached through a nameref.
    pub(crate) fn declaration(&self, name: &str) -> Result<Option<DeclarationView<'_>>, ()> {
        let reference = self.namerefs.get(name);
        let binding = self.variables.get(name);
        if reference.is_none() && matches!(binding, Some(Binding::Indexed(_))) {
            return Err(());
        }
        let value = reference.or_else(|| binding.and_then(Binding::scalar));
        let local = self.locals.iter().rev().find_map(|scope| scope.get(name));
        let readonly = local.map_or_else(|| self.readonly.contains(name), |local| local.readonly);
        let exported = self.exported.contains(name);
        if value.is_none()
            && local.is_none()
            && !readonly
            && !exported
            && !self.case_attributes.contains_key(name)
            && !self.integers.contains(name)
        {
            return Ok(None);
        }
        Ok(Some(DeclarationView {
            value: value.map(String::as_str),
            nameref: reference.is_some(),
            readonly,
            exported,
            case: self.case_mapping(name),
            integer: self.integers.contains(name),
        }))
    }
}
