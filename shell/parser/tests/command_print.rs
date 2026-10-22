//! Allocation controls for the public, bounded command-label adapter.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use shell_parser::limits::{ExecutionBudget, ExecutionLimits};
use shell_parser::{
    Command, ParameterOp, Parser, Word, WordPart, command_string, function_string,
    function_string_bounded,
};

thread_local! {
    static ALLOCATIONS: Cell<Option<(usize, usize)>> = const { Cell::new(None) };
}

struct TrackedAllocator;

fn record_allocation(bytes: usize) {
    let _ = ALLOCATIONS.try_with(|counter| {
        if let Some((largest, total)) = counter.get() {
            counter.set(Some((largest.max(bytes), total.saturating_add(bytes))));
        }
    });
}

unsafe impl GlobalAlloc for TrackedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation(size);
        unsafe { System.realloc(ptr, layout, size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: TrackedAllocator = TrackedAllocator;

fn command(source: &str) -> Command {
    Parser::new(source)
        .parse()
        .unwrap_or_else(|error| panic!("{source:?}: {error:?}"))
        .commands
        .remove(0)
}

fn with_argument(word: Word) -> Command {
    let mut command = command("echo value");
    let Command::Simple(simple) = &mut command else {
        unreachable!()
    };
    simple.args[0] = word;
    command
}

fn assert_bounded(command: &Command, budget: Option<&ExecutionBudget>, fuel: usize) {
    ALLOCATIONS.with(|counter| counter.set(Some((0, 0))));
    let result = command_string(command, &Cell::new(fuel), fuel, budget);
    let (largest, total) = ALLOCATIONS.with(|counter| counter.replace(None).unwrap());
    assert!(
        result.is_err(),
        "the bounded adapter must refuse this command"
    );
    assert!(largest <= 4096, "allocated {largest} bytes before refusing");
    assert!(total <= 8192, "allocated {total} bytes before refusing");
}

#[test]
fn tiny_label_fuel_refuses_large_ast_before_copying_it() {
    let large = "x".repeat(128 * 1024);
    for word in [
        Word::literal(&large),
        Word::quoted_literal(&large),
        Word {
            parts: vec![WordPart::Variable(large.clone())],
            ..Word::literal("")
        },
        Word {
            parts: vec![WordPart::ParameterExpansion {
                name: "x".into(),
                operator: ParameterOp::UseDefault,
                operand: large.clone(),
                colon_variant: true,
            }],
            ..Word::literal("")
        },
        Word {
            raw: Some(format!("$'{large}'")),
            ..Word::literal("")
        },
        Word {
            raw: Some(large.clone()),
            ..Word::literal("")
        },
        Word {
            parts: vec![WordPart::CompoundAssignment {
                name: "a".into(),
                append: false,
                elements: vec![Word::literal(&large)],
            }],
            ..Word::literal("")
        },
    ] {
        assert_bounded(&with_argument(word), None, 16);
    }

    for raw in [false, true] {
        let mut heredoc = command("cat <<EOF\nbody\nEOF");
        let Command::Simple(simple) = &mut heredoc else {
            unreachable!()
        };
        simple.redirects[0].target = Word::literal(&large);
        if raw {
            simple.redirects[0].target.raw = Some(large.clone());
        }
        assert_bounded(&heredoc, None, 16);
    }

    let mut wide = command("echo value");
    let Command::Simple(simple) = &mut wide else {
        unreachable!()
    };
    simple.args = vec![Word::literal(""); 10_000];
    assert_bounded(&wide, None, 16);
}

#[test]
fn request_work_cancellation_and_deadlines_precede_reconstruction() {
    let huge = with_argument(Word::literal("x".repeat(128 * 1024)));
    let cancelled = Arc::new(AtomicBool::new(false));
    let work = ExecutionBudget::new(
        &ExecutionLimits {
            max_work_units: 16,
            ..ExecutionLimits::default()
        },
        cancelled.clone(),
    );
    assert_bounded(&huge, Some(&work), usize::MAX);
    assert!(
        work.check()
            .unwrap_err()
            .to_string()
            .contains("work exhausted")
    );

    let timeout = ExecutionBudget::new(
        &ExecutionLimits {
            timeout: Duration::ZERO,
            ..ExecutionLimits::default()
        },
        cancelled.clone(),
    );
    assert_bounded(&huge, Some(&timeout), usize::MAX);
    assert!(timeout.check().unwrap_err().to_string().contains("timeout"));

    let polls = Rc::new(Cell::new(0));
    let probe_polls = polls.clone();
    let interrupted = ExecutionBudget::new(&ExecutionLimits::default(), cancelled)
        .with_cancellation_probe(Rc::new(move || {
            probe_polls.set(probe_polls.get() + 1);
            probe_polls.get() >= 3
        }));
    assert_bounded(&huge, Some(&interrupted), usize::MAX);
    assert!(
        interrupted
            .check()
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
}

#[test]
fn bounded_function_layout_matches_existing_printer_for_all_body_shapes() {
    for source in [
        "f() { :; }",
        "f() { echo 'a b' \"$x\" \\$y >out; }",
        "f() { if :; then echo yes; else echo no; fi; } 2>err",
        "f() ( echo subshell )",
        "f() { cat <<EOF\nbody\nEOF\n}",
        "f() { g() { :; }; g; }",
    ] {
        let definition = command(source);
        let Command::Function(function) = definition else {
            unreachable!()
        };
        for name in ["f", "if", "unicode_λ"] {
            let fuel = Cell::new(4096);
            let bounded = function_string_bounded(name, &function.body, &fuel, 4096, None).unwrap();
            assert_eq!(bounded, function_string(name, &function.body), "{source}");
            assert!(
                fuel.get() < 4096,
                "printing must charge its caller's shared fuel"
            );
        }
    }
}

fn assert_function_bounded(
    name: &str,
    body: &Command,
    budget: Option<&ExecutionBudget>,
    fuel: usize,
) {
    ALLOCATIONS.with(|counter| counter.set(Some((0, 0))));
    let result = function_string_bounded(name, body, &Cell::new(fuel), fuel, budget);
    let (largest, total) = ALLOCATIONS.with(|counter| counter.replace(None).unwrap());
    assert!(
        result.is_err(),
        "bounded function rendering must refuse before copying"
    );
    assert!(largest <= 4096, "allocated {largest} bytes before refusing");
    assert!(total <= 8192, "allocated {total} bytes before refusing");
}

#[test]
fn bounded_function_names_and_bodies_are_admitted_before_copying() {
    let huge = "x".repeat(128 * 1024);
    let body = with_argument(Word::literal(&huge));
    assert_function_bounded("f", &body, None, 32);
    assert_function_bounded(&huge, &command(":"), None, 32);
    let mut wide = command("echo value");
    let Command::Simple(simple) = &mut wide else {
        unreachable!()
    };
    simple.args = vec![Word::literal(""); 10_000];
    assert_function_bounded("f", &wide, None, 32);

    let cancelled = Arc::new(AtomicBool::new(false));
    let work = ExecutionBudget::new(
        &ExecutionLimits {
            max_work_units: 32,
            ..ExecutionLimits::default()
        },
        cancelled.clone(),
    );
    assert_function_bounded("f", &body, Some(&work), usize::MAX);
    assert!(
        work.check()
            .unwrap_err()
            .to_string()
            .contains("work exhausted")
    );
    let timeout = ExecutionBudget::new(
        &ExecutionLimits {
            timeout: Duration::ZERO,
            ..ExecutionLimits::default()
        },
        cancelled.clone(),
    );
    assert_function_bounded("f", &body, Some(&timeout), usize::MAX);
    assert!(timeout.check().unwrap_err().to_string().contains("timeout"));
    let interrupted = ExecutionBudget::new(&ExecutionLimits::default(), cancelled)
        .with_cancellation_probe(Rc::new(|| true));
    assert_function_bounded("f", &body, Some(&interrupted), usize::MAX);
    assert!(
        interrupted
            .check()
            .unwrap_err()
            .to_string()
            .contains("cancelled")
    );
}

#[test]
fn function_declaration_spelling_survives_parse_clone_and_print() {
    for (header, name, printed) in [
        (r#"function foo"bar""#, r#"foo"bar""#, r#"foo"bar""#),
        ("function foo'bar'", "foo'bar'", "foo'bar'"),
        (r"function f\oo", r"f\oo", r"f\oo"),
        ("function `echo $x`", "`echo $x`", "`echo $x`"),
        ("function foo\\\nbar", "foo\\\nbar", "foobar"),
        (r#"foo"bar"()"#, r#"foo"bar""#, r#"foo"bar""#),
        ("foo'bar'()", "foo'bar'", "foo'bar'"),
        ("`echo $x`()", "`echo $x`", "`echo $x`"),
        ("foo\\\nbar()", "foo\\\nbar", "foobar"),
        (
            "function `echo\\\\\nhi`",
            "`echo\\\\\nhi`",
            "`echo\\\\\nhi`",
        ),
        ("`echo\\\\\nhi`()", "`echo\\\\\nhi`", "`echo\\\\\nhi`"),
        ("function `echo 'a\\\nb'`", "`echo 'a\\\nb'`", "`echo 'ab'`"),
    ] {
        let source = format!("{header} {{ :; }}");
        let parsed = command(&source);
        let Command::Function(function) = parsed.clone() else {
            panic!("expected function: {source}");
        };
        assert_eq!(function.name, name);
        let rendered = command_string(&parsed, &Cell::new(100_000), 100_000, None).unwrap();
        assert!(
            rendered.starts_with(&format!("function {printed} ()")),
            "{rendered}"
        );
        assert_bounded(&parsed, None, 1);
    }
}

#[test]
fn function_name_printer_preserves_single_quoted_continuations() {
    let mut parsed = command("function foo { :; }");
    let Command::Function(function) = &mut parsed else {
        unreachable!()
    };
    function.name = "foo'a\\\nb'".into();
    let rendered = command_string(&parsed, &Cell::new(100_000), 100_000, None).unwrap();
    assert!(rendered.starts_with("function foo'a\\\nb' ()"));
    assert_bounded(&parsed, None, 1);
}

#[test]
fn alias_function_names_retain_the_expanded_token_not_the_alias_source() {
    let options = shell_parser::ParseOptions {
        aliases: Some(Arc::new(std::collections::HashMap::from([
            ("def".into(), "function".into()),
            ("make".into(), "function `echo $x` { :; }".into()),
        ]))),
        ..Default::default()
    };
    for source in ["def `echo $x` { :; }", "make"] {
        let script = Parser::new(source)
            .with_options(options.clone())
            .parse()
            .unwrap();
        let Command::Function(function) = &script.commands[0] else {
            panic!("expected alias function: {source}");
        };
        assert_eq!(function.name, "`echo $x`");
        let rendered =
            command_string(&script.commands[0], &Cell::new(100_000), 100_000, None).unwrap();
        assert!(rendered.starts_with("function `echo $x` ()"));
    }
}
