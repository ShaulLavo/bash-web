use super::{Binding, State};

#[derive(Clone, Copy)]
pub(crate) struct DeclarationView<'a> {
    pub(crate) value: Option<&'a str>,
    pub(crate) nameref: bool,
    pub(crate) readonly: bool,
    pub(crate) exported: bool,
    pub(crate) case: super::CaseMapping,
}

impl State {
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
        {
            return Ok(None);
        }
        Ok(Some(DeclarationView {
            value: value.map(String::as_str),
            nameref: reference.is_some(),
            readonly,
            exported,
            case: self.case_mapping(name),
        }))
    }
}
