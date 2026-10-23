use super::*;

#[test]
fn associative_quoted_keys_and_declaration_substitutions() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"key=expanded; declare -A h=(['$key']=literal ["$key"]=$(echo value) ['a b']='with spaces'); args "${h['$key']}" "${h["$key"]}" "${h['a b']}"; unset 'h[$(echo expanded)]'; args "${#h[@]}""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["literal", "value", "with spaces"], vec!["2"]]
    );
}

#[test]
fn associative_local_readonly_and_subshell_lifetimes() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"declare -A h=([key]=outer); f() { local -A h=([key]=local); args "${h[key]}"; }; f; (h[key]=child); args "${h[key]}"; readonly h; h[key]=blocked
args "$?" "${h[key]}""#), 0);
    assert_eq!(
        *rig.calls.borrow(),
        vec![vec!["local"], vec!["outer"], vec!["1", "outer"]]
    );
}

#[test]
fn associative_failed_staging_is_atomic_and_refunds_invocations() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("declare -A h=([key]=saved)"), 0);
    for source in [
        "h=([key]=new [next]=$(while true; do :; done))",
        "h[key]=new b=$(while true; do :; done)",
        "h+=([key]+=tail) b=$(while true; do :; done)",
    ] {
        cancel_indexed_assignment(&rig, source);
        assert_eq!(rig.run("args \"${h[key]}\" \"${#h[@]}\""), 0);
    }
    assert_indexed_calls(&rig, &["saved", "1"]);
}

#[test]
fn associative_later_resource_failure_restores_completed_assignments() {
    let rig = Rig::new(Limits {
        expansion_bytes: 8192,
        ..Limits::default()
    });
    assert_eq!(rig.run("declare -A h=([key]=saved)"), 0);
    rig.variable("VALUE", &"x".repeat(8190));
    for source in ["h[key]=new b=$VALUE", "h+=([key]+=tail) b=$VALUE"] {
        assert_eq!(rig.run(source), 2, "{source}");
        assert_eq!(rig.run("args \"${h[key]}\" \"${#h[@]}\""), 0);
    }
    assert_indexed_calls(&rig, &["saved", "1"]);
}

#[test]
fn associative_snapshot_copy_yields_before_mutation() {
    let rig = Rig::new(Limits::default());
    rig.variable("VALUE", &"x".repeat(12000));
    assert_eq!(rig.run("declare -A h=([key]=$VALUE)"), 0);
    let job = rig.shell.start("h[next]=new").unwrap();
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.run("args \"${#h[key]}\" \"${#h[@]}\""), 0);
    assert_indexed_calls(&rig, &["12000", "1"]);
}

#[test]
fn associative_scalar_effect_survives_assignment_journal_rollback() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("declare -A h=([key]=saved)"), 0);
    cancel_indexed_assignment(
        &rig,
        "h[key]=new x=${h:=durable} b=$(while true; do :; done)",
    );
    assert_eq!(rig.run("args \"${h[key]}\" \"$h\""), 0);
    assert_indexed_calls(&rig, &["saved", "durable"]);
}

#[test]
fn associative_iteration_keeps_empty_elements_and_key_value_alignment() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"declare -A h=([one]=''); args "${!h[@]}" "${h[@]}" "${#h[@]}"; unset 'h[one]'; args "${!h[@]}" "${h[@]}" "${#h[@]}""#), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["one", "", "1"], vec!["0"]]);
}

#[test]
fn associative_rejects_empty_keys_without_mutating_existing_entries() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("declare -A h=([key]=saved); h['']=bad\nargs \"${h[key]}\" \"${#h[@]}\""),
        0
    );
    assert_indexed_calls(&rig, &["saved", "1"]);
}

#[test]
fn associative_r2_incremental_stress() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("declare -A h; for ((i=0;i<2000;i++)); do h[k$i]=$i; done; args ${#h[@]}"), 0);
    assert_indexed_calls(&rig, &["2000"]);
}

#[test]
fn associative_r2_hash_order_and_space_keys() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"declare -A h=([a]=A [b]=B [c]=C); args "${!h[@]}" "${h[@]}"; h[a b]=space; args "${h[a b]}"; unset 'h[a b]'; args ${#h[@]}"#), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["c", "b", "a", "C", "B", "A"], vec!["space"], vec!["3"]]);
}

#[test]
fn associative_r2_partial_declaration() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"declare -A h=([a]=A plain tail [b]=B)
args $? "${h[a]}" ${#h[@]}"#), 0);
    assert_indexed_calls(&rig, &["1", "A", "1"]);
}

#[test]
fn associative_r2_empty_read_continues() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"declare -A h=([a]=1); k=; x=${h[$k]}; args "$?" "$x"; args next"#), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["0", ""], vec!["next"]]);
}

#[test]
fn associative_r2_nounset_lengths() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run(r#"set -u; declare -A h=([a]=A); args "${#h[missing]}"; args next"#), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["0"], vec!["next"]]);
    assert_eq!(rig.run("declare -A uninitialized; args ${#uninitialized[@]}"), 1);
}
