//! Allocation controls for the public, bounded command-label adapter.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use shell_parser::limits::{ExecutionBudget, ExecutionLimits};
use shell_parser::{Command, ParameterOp, Parser, Word, WordPart, command_string};

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
    Parser::new(source).parse().unwrap().commands.remove(0)
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
