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
    for source in ["args ~", "args ${u:-~}"] {
        let rig = Rig::new(Limits {
            expansion_bytes: 4096,
            ..Limits::default()
        });
        rig.variable("HOME", &"x".repeat(5000));
        assert_eq!(rig.run(source), 2);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.run("args recovered"), 0);
        assert_eq!(*rig.calls.borrow(), [vec!["recovered".to_owned()]]);
    }
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

#[test]
fn tilde_home_frozen_parameter_operands() {
    let rig = Rig::new(Limits::default());
    let source = "HOME=/home/tt\necho ${undef:-~} \"${undef:-~}\" ${HOME:+~/z} ${undef:-\"~\"}\nx=/home/tt/a\necho ${x//~/z} \"${x#~}\" \"${x/#~/Z}\"\n";
    assert_eq!(rig.run(source), 0);
    assert_eq!(
        rig.output.bytes(),
        b"/home/tt ~ /home/tt/z ~\nz/a /a /home/tt/a\n"
    );
}

#[test]
fn tilde_home_operand_protects_fields_and_patterns() {
    let rig = Rig::new(Limits::default());
    let source = "HOME='/a b*[x]?'; IFS=' /:'; args ${u:-~} ${u:-~/tail}; x='/a b*[x]?/tail'; args \"${x#~}\"";
    assert_eq!(rig.run(source), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["/a b*[x]?", "/a b*[x]?", "tail"], vec!["/tail"]]
    );
}

#[test]
fn tilde_home_operand_reads_current_scope() {
    let rig = Rig::new(Limits::default());
    let source = "HOME=/global; f() { args ${u:-~}; local HOME=/local; args ${u:-~}; }; HOME=/prefix f; args ${u:-~}; (HOME=/child; args ${u:-~}); args ${u:-~}";
    assert_eq!(rig.run(source), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["/prefix"],
            vec!["/local"],
            vec!["/global"],
            vec!["/child"],
            vec!["/global"]
        ]
    );
}

#[test]
fn tilde_home_operand_lookup_follows_side_effects() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("HOME=; args x${u:-~}:${HOME:=/next}:${u:-~}"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["x:/next:/next"]]);
}

#[test]
fn tilde_home_operands_leave_unowned_spellings_closed() {
    for source in [
        "args ${u:-word~}",
        "args ${u:-~account}",
        "case x in ~) args forbidden;; esac",
    ] {
        let rig = Rig::new(Limits::default());
        rig.variable("HOME", "/owned");
        assert_eq!(rig.run(source), 2, "{source}");
        assert!(rig.calls.borrow().is_empty());
    }
}

#[test]
fn tilde_home_operand_value_walk_is_cancellable() {
    let rig = Rig::new(Limits::default());
    rig.variable("HOME", &"h".repeat(100_000));
    let job = rig.shell.start("args ${u:-~/suffix}").unwrap();
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.run("args recovered"), 0);
}
