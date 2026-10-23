use super::{
    Binding, MAX_NAMEREF_DEPTH, ScalarResolution, SharedState, State, snapshot_node_bytes,
};
use crate::{
    exec::{Error, Work},
    executor::Cancel,
};

impl State {
    pub(crate) async fn disable_nameref(
        state: &SharedState,
        name: String,
        value: Option<String>,
        local: bool,
        cancel: &Cancel,
        work: &mut Work,
    ) -> Result<(), Error> {
        Self::admit_scalar_access(state, &name, cancel, work).await?;
        if local && (!state.borrow().is_current_local(&name) || value.is_some()) {
            return state
                .borrow_mut()
                .declare_local(name, value)
                .map_err(Error::from);
        }
        let key = {
            let state = state.borrow();
            let Some(key) = state.nameref_attribute_key(&name, local) else {
                return Ok(());
            };
            if state.is_readonly(key) && state.is_nameref(key) {
                return Err(1.into());
            }
            work.admit_storage(key.len().saturating_add(snapshot_node_bytes::<Binding>()?))?;
            key.to_owned()
        };
        if let Some(value) = value {
            Self::admit_assignment(state, &name, value.len(), cancel, work).await?;
            state.borrow_mut().assign_parameter(name, value)?;
        }
        state.borrow_mut().detach_nameref(key)?;
        Ok(())
    }

    fn nameref_attribute_key<'a>(&'a self, name: &'a str, local: bool) -> Option<&'a str> {
        if local || !self.is_nameref(name) {
            return Some(name);
        }
        if !matches!(
            self.resolve_scalar_target(name),
            ScalarResolution::Target(_)
        ) {
            return None;
        }
        let mut current = name;
        for _ in 0..MAX_NAMEREF_DEPTH {
            let target = self.namerefs.get(current)?;
            if !self.is_nameref(target) {
                return Some(current);
            }
            current = target;
        }
        None
    }

    fn detach_nameref(&mut self, name: String) -> Result<(), i32> {
        let Some(target) = self.namerefs.get(&name) else {
            return Ok(());
        };
        self.reserve_local_value(&name, target.len())?;
        let target = self.namerefs.remove(&name).expect("bound reference");
        self.variables.insert(name, target.into());
        Ok(())
    }

    pub(crate) fn nameref_attribute_storage(
        name: &str,
        readonly: bool,
        exported: bool,
    ) -> Result<usize, Error> {
        let bytes = snapshot_node_bytes::<()>()?.saturating_add(name.len());
        Ok(bytes.saturating_mul(usize::from(readonly) + usize::from(exported)))
    }

    pub(crate) fn set_nameref_attributes(&mut self, name: &str, readonly: bool, exported: bool) {
        if exported {
            self.exported.insert(name.to_owned());
        }
        if !readonly {
            return;
        }
        let owner = self
            .locals
            .iter_mut()
            .rev()
            .find_map(|scope| scope.get_mut(name));
        if let Some(owner) = owner {
            owner.readonly = true;
            return;
        }
        self.readonly.insert(name.to_owned());
    }
}
