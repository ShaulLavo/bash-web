//! Original regressions for parse-time conditional structure and operator identity.
use shell_parser::parser::{Command, CompoundCommand, Parser, TestExpr, function_string};

fn expression(source: &str) -> Box<TestExpr> {
    let script = Parser::new(source).parse().unwrap();
    let mut commands = script.commands.into_iter();
    let Some(Command::Compound(CompoundCommand::Test(expression), _)) = commands.next() else {
        panic!("expected a structured conditional");
    };
    expression
}

#[test]
fn conditional_precedence_is_structured_before_expansion() {
    let expression = expression("[[ a || b && ! ( c == d ) ]]");
    let TestExpr::Or(alternatives) = expression.as_ref() else {
        panic!("OR must be the outer node");
    };
    assert_eq!(alternatives.len(), 2);
    assert!(matches!(&alternatives[0], TestExpr::Word(_)));
    let TestExpr::And(terms) = &alternatives[1] else {
        panic!("AND binds more tightly than OR");
    };
    assert_eq!(terms.len(), 2);
    let TestExpr::Not(group) = &terms[1] else {
        panic!("negation must remain structural");
    };
    let TestExpr::Group(binary) = group.as_ref() else {
        panic!("explicit grouping must survive for printing");
    };
    assert!(matches!(binary.as_ref(), TestExpr::Binary { operator, .. } if operator == "=="));
}

#[test]
fn conditional_operator_looking_operands_are_never_reinterpreted() {
    for source in ["[[ '!' ]]", "[[ '(' ]]", "[[ '-z' ]]", "[[ $operator ]]"] {
        assert!(
            matches!(expression(source).as_ref(), TestExpr::Word(_)),
            "{source}"
        );
    }
    for source in [
        "[[ a $operator b ]]",
        "[[ a '==' b ]]",
        "[[ -z ]]",
        "[[ a == ]]",
    ] {
        assert!(Parser::new(source).parse().is_err(), "{source}");
    }
}

#[test]
fn conditional_wide_chains_have_one_flat_logical_node() {
    for (operator, is_and) in [("&&", true), ("||", false)] {
        let source = format!("[[ {}x ]]", format!("x {operator} ").repeat(600));
        let expression = expression(&source);
        let children = match expression.as_ref() {
            TestExpr::And(children) if is_and => children,
            TestExpr::Or(children) if !is_and => children,
            _ => panic!("expected a flat logical chain"),
        };
        assert_eq!(children.len(), 601);
        assert!(
            children
                .iter()
                .all(|child| matches!(child, TestExpr::Word(_)))
        );
    }
}

#[test]
fn conditional_printer_uses_structure_not_rendered_operator_text() {
    let script = Parser::new("f() { [[ '!' || ( a && ! '' ) ]]; }")
        .parse()
        .unwrap();
    let Command::Function(function) = &script.commands[0] else {
        panic!("expected function");
    };
    assert_eq!(
        function_string(&function.name, &function.body),
        "f () \n{ \n    [[ -n '!' || ( -n a && ! -n '' ) ]]\n}",
    );
}

#[test]
fn conditional_static_budget_treats_braces_as_scalar_but_validates_subcommands() {
    let limits = shell_parser::limits::ExecutionLimits::default();
    let scalar = Parser::new("[[ {1..999999999} == '{1..999999999}' ]]")
        .parse()
        .unwrap();
    shell_parser::parser::validate_budget(&scalar, &limits).unwrap();
    let substitution = Parser::new("[[ $(echo {1..999999999}) ]]").parse().unwrap();
    assert!(shell_parser::parser::validate_budget(&substitution, &limits).is_err());
}

#[test]
fn conditional_newlines_follow_grammar_positions_not_blanket_whitespace() {
    for source in [
        "[[ a\n]]",
        "[[ ( a\n) ]]",
        "[[ a\n&& b ]]",
        "[[ ( ! a\n) ]]",
        "[[ a\n== a ]]",
        "[[ -n\na ]]",
        "[[ a ==\na ]]",
        "[[ a <\nb ]]",
    ] {
        assert!(Parser::new(source).parse().is_err(), "{source:?}");
    }
    for source in [
        "[[\na ]]",
        "[[ !\na ]]",
        "[[ (\na ) ]]",
        "[[ a &&\nb ]]",
        "[[ a ||\nb ]]",
        "[[ -n a\n]]",
        "[[ a == a\n]]",
        "[[ ( a )\n]]",
        "[[ -n a\n&&\n-n b\n]]",
        "[[ 'a\nb' == 'a\nb' ]]",
        "[[ a \\\n== a ]]",
    ] {
        assert!(Parser::new(source).parse().is_ok(), "{source:?}");
    }
}
