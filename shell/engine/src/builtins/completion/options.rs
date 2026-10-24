//! Bashkit completion option names and ordering, adapted to borrowed argv.
use crate::state::completion::{Spec, Special};

pub(super) const ACTIONS: &[(&str, Option<u8>)] = &[
    ("alias", Some(b'a')),
    ("builtin", Some(b'b')),
    ("command", Some(b'c')),
    ("directory", Some(b'd')),
    ("export", Some(b'e')),
    ("file", Some(b'f')),
    ("group", Some(b'g')),
    ("job", Some(b'j')),
    ("keyword", Some(b'k')),
    ("service", Some(b's')),
    ("user", Some(b'u')),
    ("variable", Some(b'v')),
    ("arrayvar", None),
    ("binding", None),
    ("disabled", None),
    ("enabled", None),
    ("function", None),
    ("helptopic", None),
    ("hostname", None),
    ("running", None),
    ("setopt", None),
    ("shopt", None),
    ("signal", None),
    ("stopped", None),
];
pub(super) const OPTIONS: &[&str] = &[
    "bashdefault",
    "default",
    "dirnames",
    "filenames",
    "fullquote",
    "noquote",
    "nosort",
    "nospace",
    "plusdirs",
];
pub(super) const TEXT_FLAGS: &[u8; 7] = b"GWPSXCF";
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::builtins) enum Kind {
    Generate,
    Complete,
    Options,
}
impl Kind {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Generate => "compgen",
            Self::Complete => "complete",
            Self::Options => "compopt",
        }
    }
}
pub(super) struct Arguments<'a> {
    pub(super) spec: Spec<'a>,
    pub(super) unset_options: u16,
    pub(super) print: bool,
    pub(super) remove: bool,
    pub(super) special: Option<Special>,
    pub(super) operands: &'a [String],
    pub(super) supplied: bool,
}
impl Arguments<'_> {
    fn selector(&mut self, flag: u8) {
        let kind = match flag {
            b'D' => Special::Default,
            b'E' => Special::Empty,
            _ => Special::Initial,
        };
        self.special = match (self.special, kind) {
            (Some(Special::Default), _) | (_, Special::Default) => Some(Special::Default),
            (Some(Special::Empty), _) | (_, Special::Empty) => Some(Special::Empty),
            _ => Some(Special::Initial),
        };
    }
    fn switch(&mut self, kind: Kind, flag: u8) -> Result<(), i32> {
        if flag == b'p' && kind == Kind::Complete {
            self.print = true;
            return Ok(());
        }
        if flag == b'r' && kind == Kind::Complete {
            self.remove = true;
            return Ok(());
        }
        if b"DEI".contains(&flag) && kind != Kind::Generate {
            self.selector(flag);
            return Ok(());
        }
        if kind == Kind::Options {
            return Err(2);
        }
        let index = ACTIONS
            .iter()
            .position(|(_, letter)| *letter == Some(flag))
            .ok_or(2)?;
        self.spec.actions |= 1 << index;
        self.supplied = true;
        Ok(())
    }
    fn value(&mut self, kind: Kind, flag: u8, positive: bool, value: &str) -> Result<(), i32> {
        if flag == b'o' {
            let index = OPTIONS.iter().position(|name| *name == value).ok_or(2)?;
            if positive {
                self.spec.options |= 1 << index;
            } else {
                self.unset_options |= 1 << index;
            }
            self.supplied = true;
            return Ok(());
        }
        if kind == Kind::Options {
            return Err(2);
        }
        if flag == b'A' {
            let index = ACTIONS
                .iter()
                .position(|(name, _)| *name == value)
                .ok_or(2)?;
            self.spec.actions |= 1 << index;
        }
        self.supplied = true;
        Ok(())
    }
}
pub(super) fn parse(kind: Kind, args: &[String]) -> Result<Arguments<'_>, i32> {
    let mut parsed = Arguments {
        spec: Spec::default(),
        unset_options: 0,
        print: false,
        remove: false,
        special: None,
        operands: &[],
        supplied: false,
    };
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        if arg == "--" {
            index += 1;
            break;
        }
        let positive = arg.starts_with('-');
        let option = positive || kind == Kind::Options && arg.starts_with('+');
        if !option || arg.len() == 1 {
            break;
        }
        index += 1;
        parse_cluster(kind, arg, args, &mut index, positive, &mut parsed)?;
    }
    parsed.operands = &args[index..];
    Ok(parsed)
}
fn parse_cluster<'a>(
    kind: Kind,
    arg: &'a str,
    args: &'a [String],
    index: &mut usize,
    positive: bool,
    parsed: &mut Arguments<'a>,
) -> Result<(), i32> {
    for (offset, flag) in arg[1..].char_indices() {
        let flag = u8::try_from(flag).map_err(|_| 2)?;
        let text_index = TEXT_FLAGS.iter().position(|value| *value == flag);
        let takes_value =
            flag == b'o' || kind != Kind::Options && (flag == b'A' || text_index.is_some());
        if !takes_value {
            parsed.switch(kind, flag)?;
            continue;
        }
        let attached = &arg[offset + 2..];
        let value = argument_value(attached, args, index)?;
        if let Some(slot) = text_index {
            parsed.spec.text[slot] = Some(value);
            parsed.supplied = true;
        } else {
            parsed.value(kind, flag, positive, value)?;
        }
        break;
    }
    Ok(())
}
fn argument_value<'a>(
    attached: &'a str,
    args: &'a [String],
    index: &mut usize,
) -> Result<&'a str, i32> {
    if !attached.is_empty() {
        return Ok(attached);
    }
    let value = args.get(*index).ok_or(2)?;
    *index += 1;
    Ok(value)
}
pub(super) fn has(spec: Spec<'_>, action: &str) -> bool {
    ACTIONS
        .iter()
        .position(|(name, _)| *name == action)
        .is_some_and(|index| spec.actions & (1 << index) != 0)
}
pub(super) fn option(spec: Spec<'_>, option: &str) -> bool {
    OPTIONS
        .iter()
        .position(|name| *name == option)
        .is_some_and(|index| spec.options & (1 << index) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }
    #[test]
    fn clustered_and_attached_values_keep_option_boundaries() {
        let values = args(&["-abWone two", "-Ffunction", "--", "-command"]);
        let parsed = parse(Kind::Complete, &values).unwrap();
        assert!(has(parsed.spec, "alias"));
        assert!(has(parsed.spec, "builtin"));
        assert_eq!(parsed.spec.text[1], Some("one two"));
        assert_eq!(parsed.spec.text[6], Some("function"));
        assert_eq!(parsed.operands, ["-command"]);
    }
    #[test]
    fn invalid_or_missing_option_arguments_fail_before_registration() {
        for values in [
            &["-A", "no_action"][..],
            &["-o", "no_option"],
            &["-W"],
            &["-Z"],
        ] {
            assert!(parse(Kind::Complete, &args(values)).is_err());
        }
        assert!(parse(Kind::Options, &args(&["-p"])).is_err());
    }
    #[test]
    fn special_selector_precedence_is_not_argument_order() {
        for values in [&["-I", "-E", "-D"][..], &["-DEI"]] {
            assert_eq!(
                parse(Kind::Complete, &args(values)).unwrap().special,
                Some(Special::Default)
            );
        }
    }
}
