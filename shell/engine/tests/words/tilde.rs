//! Original resource and scheduling controls for HOME-only tilde expansion.
use super::*;

#[test]
fn tilde_home_is_snapshotted_before_parameter_side_effects() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("HOME=; args x=~:${HOME:=/next}:~"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["x=:/next:".to_owned()]]);
}

#[test]
fn tilde_expansion_bytes_fail_before_dispatch() {
    let rig = Rig::new(Limits {
        expansion_bytes: 4096,
        ..Limits::default()
    });
    rig.variable("HOME", &"x".repeat(5000));
    assert_eq!(rig.run("args ~"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args recovered"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["recovered".to_owned()]]);
}

#[test]
fn tilde_repeated_prefixes_share_raw_budget() {
    let rig = Rig::new(Limits {
        expansion_bytes: 4096,
        ..Limits::default()
    });
    rig.variable("HOME", &"x".repeat(2000));
    assert_eq!(rig.run("args x=~:~:~"), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn tilde_prefix_and_value_walks_are_cancellable() {
    let rig = Rig::new(Limits::default());
    rig.variable("HOME", &"h".repeat(100_000));
    let job = rig.shell.start("args ~/suffix").unwrap();
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.run("args recovered"), 0);
}

#[test]
fn tilde_literal_search_is_cancellable() {
    let rig = Rig::new(Limits::default());
    let source = format!("args x={}:~", "a".repeat(100_000));
    let job = rig.shell.start(&source).unwrap();
    rig.interrupt_after_counting_yields(job);
}
