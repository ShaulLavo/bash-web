//! Scalar indirection adapted from Bashkit's IndirectExpansion/indirect_target
//! at 491c3281. This original adapter resolves typed names directly; it never
//! desugars a target string into syntax. Generic IndirectSuffix stays unsupported.
//! Bare positional and special targets reuse the direct `$1`/`$?`/`$@` adapters.
use super::{Error, Expansion, OperandContext, Protection, operand};
use crate::state::SharedState;
use shell_parser::parser::{ParameterOp, WordPart};

#[derive(Clone, Copy, PartialEq)]
enum TargetKind {
    Scalar,
    /// Positional digits and the scalar specials `#`, `?`, `$`, `!` and `-`.
    Special,
    /// `@` and `*`, which expand as the positional list.
    List,
    Unsupported,
    Invalid,
}

impl Expansion<'_> {
    pub(super) async fn indirect(
        &mut self,
        name: &str,
        operator: Option<&ParameterOp>,
        source: &str,
        colon: bool,
        context: OperandContext<'_>,
    ) -> Result<(), Error> {
        let OperandContext {
            state,
            quoted,
            scalar,
            depth,
        } = context;
        if depth >= operand::MAX_DEPTH || operator.is_some_and(|op| !operand::indirect_operator(op))
        {
            return Err(2.into());
        }
        if self.indirect_kind(name).await? != TargetKind::Scalar {
            return Err(2.into());
        }
        let Some(target) = self.indirect_snapshot(name, state, true).await? else {
            return Err(self.invalid_indirect(name, true)?);
        };
        let kind = self.indirect_kind(&target).await?;
        if kind == TargetKind::Invalid {
            return Err(self.invalid_indirect(&target, false)?);
        }
        let nameref = state.borrow().is_nameref(name);
        if matches!(kind, TargetKind::Special | TargetKind::List) && !nameref {
            return self
                .special_target(name, &target, kind, operator, context)
                .await;
        }
        if kind != TargetKind::Scalar {
            return Err(2.into());
        }
        if operator.is_none() && nameref {
            return self
                .segment(
                    &target,
                    Protection::expansion(scalar || quoted, state),
                    scalar || quoted,
                )
                .await;
        }
        let Some(operator) = operator else {
            // A bare indirection reads its resolved target. Lazy operators
            // below only test target presence; their selected operands enforce
            // nounset through ordinary expansion instead.
            self.bound_target(name, &target, state).await?;
            let value = self
                .indirect_snapshot(&target, state, false)
                .await?
                .unwrap_or_default();
            return self
                .segment(
                    &value,
                    Protection::expansion(scalar || quoted, state),
                    scalar || quoted,
                )
                .await;
        };
        // The pointer must coexist with snapshots retained by a selected scalar
        // operator, including diagnostics and enclosing trim patterns.
        let snapshots = self.pattern_snapshots;
        self.pattern_snapshots = true;
        let result = self
            .parameter(&target, operator, source, colon, context, Some(name))
            .await;
        self.pattern_snapshots = snapshots;
        result
    }

    /// A bare read of `${!p}` whose target is a positional or special
    /// parameter is exactly the direct read of that parameter, so it shares
    /// the ordinary adapters' quoting, IFS, list and limit semantics. Operators
    /// select scalar names only; nested operands and patterns expand `$@`
    /// through their own adapters, so those combinations stay unsupported.
    async fn special_target(
        &mut self,
        name: &str,
        target: &str,
        kind: TargetKind,
        operator: Option<&ParameterOp>,
        context: OperandContext<'_>,
    ) -> Result<(), Error> {
        let OperandContext {
            state,
            quoted,
            scalar,
            depth,
        } = context;
        if operator.is_some() {
            return Err(2.into());
        }
        let (nounset, no_async, no_positionals) = {
            let state = state.borrow();
            (
                state.nounset,
                state.last_async().is_none(),
                state.positional().is_empty(),
            )
        };
        if kind == TargetKind::Special {
            // Bash reports an unset `!` target with a second bad-substitution
            // diagnostic; that combined error has no adapter here.
            if target == "!" && nounset && no_async {
                return Err(2.into());
            }
            self.bound_target(name, target, state).await?;
            return self.variable(target, state, quoted, scalar).await;
        }
        if depth > 0 || self.pattern.is_some() || self.replacement.is_some() {
            return Err(2.into());
        }
        // Unlike direct `$*`, Bash treats an empty `*` target as unset.
        if target == "*" && nounset && no_positionals {
            return Err(self.unbound_indirect(name, None)?);
        }
        self.work.admit_storage(target.len())?;
        let part = WordPart::Variable(target.to_owned());
        self.elements(&part, state, quoted, scalar).await
    }

    async fn bound_target(
        &mut self,
        name: &str,
        target: &str,
        state: &SharedState,
    ) -> Result<(), Error> {
        let Err(error) = self.require_bound(target, state).await else {
            return Ok(());
        };
        let Error::Unbound { line, .. } = error else {
            return Err(error);
        };
        Err(self.unbound_indirect(name, line)?)
    }

    fn unbound_indirect(&mut self, name: &str, line: Option<usize>) -> Result<Error, Error> {
        // Bash names the indirect expression (`!p`), not its resolved target.
        // Admit both diagnostic spellings before allocating this replacement.
        self.work
            .admit_storage(name.len().saturating_add(1).saturating_mul(2))?;
        Ok(Error::Unbound {
            name: format!("!{name}"),
            line,
        })
    }

    async fn indirect_kind(&mut self, name: &str) -> Result<TargetKind, Error> {
        let mut valid = !name.is_empty();
        let mut digits = !name.is_empty();
        let mut subscript = false;
        for (index, byte) in name.bytes().enumerate() {
            self.work.checkpoint(self.cancel).await?;
            valid &=
                byte == b'_' || byte.is_ascii_alphabetic() || index > 0 && byte.is_ascii_digit();
            digits &= byte.is_ascii_digit();
            subscript |= byte == b'[';
        }
        if name == "PIPESTATUS" {
            return Ok(TargetKind::Unsupported);
        }
        if valid {
            return Ok(TargetKind::Scalar);
        }
        if digits || matches!(name, "#" | "?" | "$" | "!" | "-") {
            return Ok(TargetKind::Special);
        }
        if matches!(name, "@" | "*") {
            return Ok(TargetKind::List);
        }
        // Subscripts need typed array semantics, never target-string reparsing.
        if subscript {
            return Ok(TargetKind::Unsupported);
        }
        Ok(TargetKind::Invalid)
    }

    async fn indirect_snapshot(
        &mut self,
        name: &str,
        state: &SharedState,
        pointer: bool,
    ) -> Result<Option<String>, Error> {
        self.work.checkpoint(self.cancel).await?;
        crate::state::State::admit_scalar_access(state, name, self.cancel, self.work).await?;
        let value = {
            let state = state.borrow();
            let value = if state.dynamic_parameter(name) {
                Some(super::parameter_snapshot(
                    &state,
                    name,
                    self.raw_remaining.min(self.work.remaining),
                    true,
                    self.work,
                )?)
            } else if pointer {
                let value = state.indirect_parameter(name)?;
                if value
                    .is_some_and(|value| value.len() > self.raw_remaining.min(self.work.remaining))
                {
                    return Err(2.into());
                }
                self.work.admit_storage(value.map_or(0, str::len))?;
                value.map(str::to_owned)
            } else if state.scalar_is_set(name) {
                Some(super::parameter_snapshot(
                    &state,
                    name,
                    self.raw_remaining.min(self.work.remaining),
                    true,
                    self.work,
                )?)
            } else {
                None
            };
            let Some(value) = value else {
                return Ok(None);
            };
            value
        };
        for _ in value.bytes() {
            self.work.checkpoint(self.cancel).await?;
        }
        Ok(Some(value))
    }

    fn invalid_indirect(&mut self, name: &str, unset: bool) -> Result<Error, Error> {
        // Same owning diagnostic layer and bounded allocation as scalar errors,
        // but GNU Bash invalid indirection has unconditional fatal status 1.
        self.work
            .admit_storage(name.len().saturating_mul(2).saturating_add(96))?;
        Ok(Error::Indirect {
            name: name.to_owned(),
            unset,
            line: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;

    fn expand_indirect(
        steps: usize,
        storage: usize,
        raw: usize,
    ) -> Result<(Vec<String>, usize, usize), Error> {
        let state = crate::state::State::default().shared();
        state
            .borrow_mut()
            .assign_parameter("p".into(), "target".into())
            .unwrap();
        state
            .borrow_mut()
            .assign_parameter("target".into(), "v".into())
            .unwrap();
        let token = shell_parser::Parser::parse_word_string_with_limits("${!p}", 10, 1000);
        let mut work = Work::new(steps, storage, 1);
        let cancel = Cancel::new();
        let value = fields(&token, &state, &cancel, 64, 1, raw, &mut work)
            .now_or_never()
            .expect("the tiny expansion uses fewer than 64 checkpoints")?;
        Ok((value, steps - work.remaining, work.storage_remaining))
    }

    #[test]
    fn indirect_pointer_and_value_share_exact_snapshot_storage_and_work() {
        assert!(matches!(expand_indirect(64, 6, 64), Err(Error::Status(2))));
        let (value, used, remaining) = expand_indirect(64, 7, 64)
            .unwrap_or_else(|_| panic!("six pointer bytes and one value byte fit exactly"));
        assert_eq!(value, ["v"]);
        assert_eq!(remaining, 0);
        assert!(matches!(
            expand_indirect(used - 1, 7, 64),
            Err(Error::Status(2))
        ));
        assert!(expand_indirect(used, 7, 64).is_ok());
        assert!(matches!(expand_indirect(64, 7, 5), Err(Error::Status(2))));
    }

    #[test]
    fn indirect_cancel_before_snapshot_spends_no_storage() {
        let state = crate::state::State::default().shared();
        state
            .borrow_mut()
            .assign_parameter("p".into(), "target".into())
            .unwrap();
        let token = shell_parser::Parser::parse_word_string_with_limits("${!p}", 10, 1000);
        let cancel = Cancel::new();
        cancel.cancel();
        let mut work = Work::new(64, 7, 1);
        assert!(matches!(
            fields(&token, &state, &cancel, 64, 1, 64, &mut work).now_or_never(),
            Some(Err(Error::Status(130)))
        ));
        assert_eq!(work.storage_remaining, 7);
    }

    fn special_state(ifs: Option<&str>) -> crate::state::SharedState {
        let state = crate::state::State::default().shared();
        state
            .borrow_mut()
            .replace_positional(vec!["a b".into(), String::new(), "c".into()])
            .unwrap();
        state.borrow_mut().publish_status(7);
        if let Some(ifs) = ifs {
            state
                .borrow_mut()
                .assign_parameter("IFS".into(), ifs.into())
                .unwrap();
        }
        state
    }

    /// Parse the source as a command argument so quotes are real syntax.
    fn command_word(source: &str) -> Word {
        let script = shell_parser::Parser::new(&format!("x {source}"))
            .parse()
            .expect("fixture word parses");
        let Some(shell_parser::parser::Command::Simple(command)) = script.commands.first() else {
            panic!("fixture must be a simple command: {source}");
        };
        command.args[0].clone()
    }

    fn special_fields(
        state: &crate::state::SharedState,
        target: &str,
        source: &str,
    ) -> Result<Vec<String>, Error> {
        state
            .borrow_mut()
            .assign_parameter("r".into(), target.into())
            .unwrap();
        let token = command_word(source);
        let mut work = Work::new(65536, 1 << 20, 16);
        let cancel = Cancel::new();
        fields(&token, state, &cancel, 4096, 16, 4096, &mut work)
            .now_or_never()
            .expect("short fixture must not suspend")
    }

    fn special_word(
        state: &crate::state::SharedState,
        target: &str,
        source: &str,
    ) -> Result<String, Error> {
        state
            .borrow_mut()
            .assign_parameter("r".into(), target.into())
            .unwrap();
        let token = command_word(source);
        let mut work = Work::new(65536, 1 << 20, 16);
        let cancel = Cancel::new();
        word(&token, state, &cancel, 4096, 4096, &mut work)
            .now_or_never()
            .expect("short fixture must not suspend")
    }

    #[test]
    fn bare_special_targets_match_their_direct_parameters() {
        // Each indirect form must equal the direct spelling of its target in
        // the same field and scalar contexts, including list IFS joins.
        let targets = ["1", "2", "3", "4", "01", "#", "?", "@", "*"];
        let shapes = [
            ("${!r}", "${T}"),
            ("\"${!r}\"", "\"${T}\""),
            ("x${!r}y", "x${T}y"),
        ];
        for ifs in [None, Some(""), Some(":")] {
            let state = special_state(ifs);
            for target in targets {
                let direct = if target == "01" { "1" } else { target };
                for (indirect, plain) in shapes {
                    let plain = plain.replace('T', direct);
                    let expected = special_fields(&state, target, &plain)
                        .unwrap_or_else(|_| panic!("direct {plain} must expand"));
                    let actual = special_fields(&state, target, indirect)
                        .unwrap_or_else(|_| panic!("{indirect} with r={target} must expand"));
                    assert_eq!(actual, expected, "{indirect} r={target} IFS={ifs:?}");
                    let expected = special_word(&state, target, &plain).ok();
                    let actual = special_word(&state, target, indirect).ok();
                    assert_eq!(actual, expected, "scalar {indirect} r={target} IFS={ifs:?}");
                }
            }
        }
        let state = special_state(None);
        assert_eq!(
            special_fields(&state, "@", "${!r}").ok(),
            Some(vec!["a".into(), "b".into(), "c".into()])
        );
        assert_eq!(
            special_fields(&state, "@", "\"${!r}\"").ok(),
            Some(vec!["a b".into(), String::new(), "c".into()])
        );
        assert_eq!(
            special_fields(&state, "2", "\"${!r}\"").ok(),
            Some(vec![String::new()])
        );
        assert_eq!(
            special_fields(&state, "?", "${!r}").ok(),
            Some(vec!["7".into()])
        );
    }

    #[test]
    fn special_targets_outside_bare_reads_stay_unsupported() {
        let state = special_state(None);
        for (target, source) in [
            ("1", "${!r:-d}"),
            ("1", "${!r#a}"),
            ("@", "${!r:-d}"),
            ("@", "${u:-${!r}}"),
            ("*", "${u:-${!r}}"),
            ("PIPESTATUS", "${!r}"),
            ("a[0]", "${!r}"),
        ] {
            assert!(
                matches!(
                    special_fields(&state, target, source),
                    Err(Error::Status(2))
                ),
                "{source} r={target}"
            );
        }
        // Positional pointers keep their existing unsupported status.
        assert!(matches!(
            special_fields(&state, "x", "${!1}"),
            Err(Error::Status(2))
        ));
    }

    #[test]
    fn special_targets_report_the_indirect_expression_when_unbound() {
        let state = special_state(None);
        state.borrow_mut().nounset = true;
        assert!(matches!(
            special_fields(&state, "4", "${!r}"),
            Err(Error::Unbound { name, .. }) if name == "!r"
        ));
        assert_eq!(
            special_fields(&state, "3", "${!r}").ok(),
            Some(vec!["c".into()])
        );
        assert_eq!(
            special_fields(&state, "#", "${!r}").ok(),
            Some(vec!["3".into()])
        );
        assert!(matches!(
            special_fields(&state, "!", "${!r}"),
            Err(Error::Status(2))
        ));
        state.borrow_mut().replace_positional(Vec::new()).unwrap();
        assert_eq!(
            special_fields(&state, "@", "\"${!r}\"").ok(),
            Some(Vec::new())
        );
        assert!(matches!(
            special_fields(&state, "*", "\"${!r}\""),
            Err(Error::Unbound { name, .. }) if name == "!r"
        ));
    }
}
