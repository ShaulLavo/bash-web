//! Original resource and scheduling controls for HOME-only tilde expansion.
use super::*;

#[test]
fn tilde_home_lookup_follows_parameter_side_effects() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("HOME=; args x=~:${HOME:=/next}:~"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["x=:/next:/next".to_owned()]]);
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

#[test]
fn tilde_brace_generated_words_keep_only_leading_prefixes() {
    let rig = Rig::new(Limits::default());
    rig.variable("HOME", "/one");
    let source = "args {~,~/tail} ~/{a,b}:~ x={~,~/tail} x=foo{:,/}~ x=~/{a} x=~:~";
    assert_eq!(rig.run(source), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec![
            "/one",
            "/one/tail",
            "/one/a:~",
            "/one/b:~",
            "x=~",
            "x=~/tail",
            "x=foo:~",
            "x=foo/~",
            "x=/one/{a}",
            "x=/one:/one",
        ]]
    );
}

#[test]
fn tilde_brace_generated_prefixes_share_expansion_budget() {
    let rig = Rig::new(Limits {
        expansion_bytes: 4096,
        ..Limits::default()
    });
    rig.variable("HOME", &"x".repeat(3000));
    assert_eq!(rig.run("args {~,~/tail}"), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args x={~,~/tail}"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["x=~", "x=~/tail"]]);
}

#[test]
fn tilde_brace_generated_prefixes_are_cancellable() {
    let rig = Rig::new(Limits::default());
    rig.variable("HOME", &"h".repeat(100_000));
    let job = rig.shell.start("args {~,~/suffix} x={~,~/suffix}").unwrap();
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.run("args recovered"), 0);
}
