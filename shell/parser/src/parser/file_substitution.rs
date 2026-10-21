//! Original eligibility metadata for GNU Bash's input-only substitution shortcut.
use super::{Command, RedirectKind, Script, WordPart};

pub(super) fn part(script: Script, backtick: Option<&str>) -> WordPart {
    if !eligible(&script) || backtick.is_some_and(|body| !backtick_complete(body, &script)) {
        return WordPart::CommandSubstitution(script.commands);
    }
    WordPart::FileSubstitution(script.commands)
}

fn eligible(script: &Script) -> bool {
    let [Command::Simple(simple)] = script.commands.as_slice() else {
        return false;
    };
    let [redirect] = simple.redirects.as_slice() else {
        return false;
    };
    !simple.name.quoted
        && matches!(simple.name.parts.as_slice(), [WordPart::Literal(text)] if text.is_empty())
        && simple.args.is_empty()
        && simple.assignments.is_empty()
        && redirect.kind == RedirectKind::Input
        && redirect.fd.unwrap_or(0) == 0
        && redirect.fd_var.is_none()
}

fn backtick_complete(body: &str, script: &Script) -> bool {
    let body_start = body.trim_start_matches([' ', '\t', '\n']);
    if !body_start.starts_with('<') {
        return false;
    }
    let [Command::Simple(simple)] = script.commands.as_slice() else {
        return false;
    };
    let Some(raw) = simple.redirects[0].target.raw.as_deref() else {
        return false;
    };
    let mut target = &body_start[1..];
    loop {
        target = target.trim_start_matches([' ', '\t']);
        let Some(rest) = target.strip_prefix("\\\n") else {
            break;
        };
        target = rest;
    }
    let Some(suffix) = target.strip_prefix(raw) else {
        return false;
    };
    complete_suffix(suffix)
}

pub(super) fn remap_offsets(offsets: &mut [usize], ranges: &[(usize, usize)]) {
    let mut index = 0;
    let mut added = 0;
    for offset in offsets {
        while ranges.get(index).is_some_and(|&(_, end)| end <= *offset) {
            added += 2;
            index += 1;
        }
        let inside = usize::from(
            ranges
                .get(index)
                .is_some_and(|&(start, _)| start <= *offset),
        );
        *offset += added + inside;
    }
}

pub(super) fn slice_offsets(offsets: &[usize], start: usize, end: usize) -> Vec<usize> {
    offsets
        .iter()
        .copied()
        .filter(|&offset| offset >= start && offset < end)
        .map(|offset| offset - start)
        .collect()
}

fn complete_suffix(suffix: &str) -> bool {
    let mut escaped = false;
    let mut comment = false;
    for (offset, ch) in suffix.char_indices() {
        if ch == '\n' && (comment || !escaped) {
            return offset + 1 == suffix.len();
        }
        comment |= ch == '#' && !escaped;
        escaped = ch == '\\' && !escaped;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Parser;

    fn shortcut(source: &str) -> bool {
        let script = Parser::new(source).parse().unwrap();
        let Command::Simple(simple) = &script.commands[0] else {
            panic!("simple");
        };
        matches!(simple.args[0].parts[0], WordPart::FileSubstitution(_))
    }

    #[test]
    fn input_only_syntax_keeps_legacy_eligibility() {
        for source in [
            "args $(<f)",
            "args $(0<f)",
            "args $(<f\n\n)",
            "args `<f`",
            "args `<f;`",
            "args `<f\n`",
            "args `<f #comment\n`",
        ] {
            assert!(shortcut(source), "{source}");
        }
        for source in [
            "args `0<f`",
            "args `<f\n\n`",
            "args `<f\n#comment\n`",
            "args $(<f <f)",
            "args $(<f 2>err)",
            "args $(x=y <f)",
            "args $(:; <f)",
            "args $(<f; :)",
            "args $({ <f; })",
        ] {
            assert!(!shortcut(source), "{source}");
        }
    }

    #[test]
    fn legacy_offsets_survive_quotes_assignments_and_identical_bodies() {
        for source in [
            "args \"`0<f`\"",
            "args prefix\"`0<f`\"",
            "args 'prefix'`0<f`",
            "args \"`<f\n\n`\"tail",
        ] {
            assert!(!shortcut(source), "{source}");
        }
        let script = Parser::new("x=`0<f`\nargs $(0<f)`0<f`$(0<f)")
            .parse()
            .unwrap();
        let Command::Simple(first) = &script.commands[0] else {
            panic!("simple");
        };
        let super::super::AssignmentValue::Scalar(word) = &first.assignments[0].value else {
            panic!("scalar");
        };
        assert!(matches!(word.parts[0], WordPart::CommandSubstitution(_)));
        let Command::Simple(second) = &script.commands[1] else {
            panic!("simple");
        };
        assert!(matches!(
            second.args[0].parts.as_slice(),
            [
                WordPart::FileSubstitution(_),
                WordPart::CommandSubstitution(_),
                WordPart::FileSubstitution(_)
            ]
        ));
    }
}
