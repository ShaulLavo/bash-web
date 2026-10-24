//! Reference spelling and selected storage. Evaluation belongs to the feature layer.
use super::{MAX_NAMEREF_DEPTH, ScalarResolution, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Reference<'a> {
    pub(crate) name: &'a str,
    pub(crate) subscript: Option<&'a str>,
}
impl<'a> Reference<'a> {
    pub(crate) fn parse(text: &'a str) -> Option<Self> {
        let end = text.find('[').unwrap_or(text.len());
        let name = &text[..end];
        let mut bytes = name.bytes();
        if !bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return None;
        }
        if end == text.len() {
            return Some(Self {
                name,
                subscript: None,
            });
        }
        let close = Self::end(text, end)?;
        if close != text.len() || close == end + 2 {
            return None;
        }
        Some(Self {
            name,
            subscript: Some(&text[end + 1..close - 1]),
        })
    }

    /// End of one balanced selector. Shared by builtin operands and arithmetic lexing.
    pub(crate) fn end(text: &str, start: usize) -> Option<usize> {
        let mut depth = 0usize;
        let mut quote = None;
        let mut escaped = false;
        for (offset, ch) in text[start..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' && quote != Some('\'') {
                escaped = true;
                continue;
            }
            if quote == Some(ch) {
                quote = None;
                continue;
            }
            if quote.is_some() {
                continue;
            }
            if matches!(ch, '\'' | '"') {
                quote = Some(ch);
                continue;
            }
            depth += usize::from(ch == '[');
            if ch != ']' {
                continue;
            }
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(start + offset + 1);
            }
        }
        None
    }
}

#[derive(Debug)]
pub(crate) struct Place {
    pub(crate) name: String,
    pub(crate) index: Option<i64>,
    /// A phase observation, not a lease. RHS code may reveal/recreate an owner.
    pub(crate) scope: Option<usize>,
}

impl State {
    pub(crate) fn reference<'a>(
        &'a self,
        mut reference: Reference<'a>,
    ) -> Result<Reference<'a>, ScalarResolution<'a>> {
        let mut seen = [""; MAX_NAMEREF_DEPTH];
        for depth in 0..MAX_NAMEREF_DEPTH {
            if seen[..depth].contains(&reference.name) {
                return Err(ScalarResolution::Cycle);
            }
            seen[depth] = reference.name;
            let Some(target) = self.namerefs.get(reference.name) else {
                return Ok(reference);
            };
            let Some(target) = Reference::parse(target) else {
                return Err(ScalarResolution::Cycle);
            };
            if reference.subscript.is_some() && target.subscript.is_some() {
                return Err(ScalarResolution::Cycle);
            }
            reference = Reference {
                name: target.name,
                subscript: reference.subscript.or(target.subscript),
            };
        }
        if self.namerefs.contains_key(reference.name) {
            return Err(ScalarResolution::DepthExceeded);
        }
        Ok(reference)
    }
    pub(crate) fn reference_scope(&self, name: &str) -> Option<usize> {
        self.locals
            .iter()
            .rposition(|frame| frame.contains_key(name))
    }
    pub(crate) fn place_value(&self, place: &Place) -> Option<&str> {
        match place.index {
            Some(index) => self
                .variables
                .get(&place.name)
                .and_then(|v| v.element(index)),
            None => self.scalar_parameter(&place.name),
        }
    }
    pub(crate) fn place_index(&self, name: &str, index: i64) -> Option<i64> {
        self.variables
            .get(name)
            .map_or((index >= 0).then_some(index), |v| v.resolve_index(index))
    }
}

impl State {
    pub(crate) async fn write_element(
        state: &super::SharedState,
        place: &Place,
        update: super::BindingUpdate,
        cancel: &crate::executor::Cancel,
        work: &mut crate::exec::Work,
    ) -> Result<(), crate::exec::Error> {
        work.checkpoint(cancel).await?;
        let bytes = state.borrow().element_effect_bytes(&place.name, &update);
        work.admit_storage(bytes)?;
        super::snapshot_steps(bytes, cancel, work).await?;
        let mut state = state.borrow_mut();
        if state.is_readonly(&place.name) {
            work.admit_storage(place.name.len().saturating_add(160))?;
            return Err(crate::exec::Error::Readonly {
                name: place.name.clone(),
                line: None,
                expansion: false,
            });
        }
        // Rebinding/recreation is legal: preserve the evaluated selector and
        // select the current owner, rather than reporting a stale-place error.
        let _owner_changed = place.scope != state.reference_scope(&place.name);
        state.commit_element_effect(&place.name, &update)
    }

    fn element_effect_bytes(&self, name: &str, update: &super::BindingUpdate) -> usize {
        let image = |binding: Option<&super::Binding>| {
            binding
                .map_or(0, super::Binding::storage_bytes)
                .saturating_add(update.staged_bytes())
                .saturating_add(super::Binding::node_bytes())
        };
        let mut bytes = image(self.variables.get(name)).saturating_add(name.len());
        for saved in &self.prefixes {
            if let Some(binding) = saved.get(name) {
                bytes = bytes.saturating_add(image(binding.as_ref()));
            }
        }
        if let Some(changes) = self.assignment_undo.0.upgrade() {
            let changes = changes.borrow();
            for (target, undo) in &changes.undo {
                if target != name {
                    continue;
                }
                bytes = bytes.saturating_add(image(self.variables.get(name)).saturating_mul(2));
                if let super::BindingUndo::Restore(Some(binding)) = undo {
                    bytes = bytes.saturating_add(image(Some(binding)).saturating_mul(2));
                }
            }
        }
        bytes.saturating_mul(2).saturating_add(512)
    }

    fn commit_element_effect(
        &mut self,
        name: &str,
        update: &super::BindingUpdate,
    ) -> Result<(), crate::exec::Error> {
        let changes = self.assignment_undo.0.upgrade();
        let bytes = self.element_effect_bytes(name, update);
        if let Some(changes) = &changes {
            changes.borrow_mut().grow(bytes)?;
        }
        let image = update.image(self.variables.get(name));
        let held = image.as_ref().map_or(0, super::Binding::storage_bytes);
        self.reserve_local_value(name, held.max(self.held_local_value(name)))?;
        // Build every amended rollback image before publishing any of them.
        let mut inverses = Vec::new();
        if let Some(changes) = &changes {
            let changes = changes.borrow();
            inverses.reserve_exact(changes.undo.len());
            let mut prior = self.variables.get(name).cloned();
            for (target, undo) in changes.undo.iter().rev() {
                if target != name {
                    continue;
                }
                prior = undo.clone().restore(prior);
                inverses.push(update.image(prior.as_ref()));
            }
        }
        if let Some(changes) = changes {
            let mut changes = changes.borrow_mut();
            for (target, undo) in &mut changes.undo {
                if target == name {
                    *undo = super::BindingUndo::Restore(inverses.pop().unwrap());
                }
            }
        }
        for saved in &mut self.prefixes {
            if let Some(binding) = saved.get_mut(name) {
                *binding = update.image(binding.as_ref());
            }
        }
        match image {
            Some(binding) => {
                self.variables.insert(name.to_owned(), binding);
            }
            None => {
                self.variables.remove(name);
            }
        }
        Ok(())
    }
}
