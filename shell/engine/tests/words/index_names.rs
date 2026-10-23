use super::{Limits, Rig, check};

#[test]
fn index_names_sparse_order_and_empty_scalar() {
    check(
        "a[20]=x; a[2]=y; a[10]=z; s=''; args \"${!a[@]}\" \"${!s[@]}\"",
        &[&["2", "10", "20", "0"]],
    );
}

#[test]
fn index_names_empty_and_unset_obey_at_star_quoting() {
    check(
        "set -u; a=(); args \"${!a[@]}\" \"${!missing[@]}\"; args \"${!a[*]}\" \"${!missing[*]}\"",
        &[&[], &["", ""]],
    );
}

#[test]
fn index_names_nameref_and_pipeline_keys() {
    check(
        "a[5]=x; a[1]=y; declare -n r=a; declare -n s=r; args \"${!s[@]}\"; false | true; args \"${!PIPESTATUS[@]}\" \"${PIPESTATUS[@]}\"",
        &[&["1", "5"], &["0", "1", "1", "0"]],
    );
}

#[test]
fn index_names_expansion_limits_prevent_dispatch() {
    let rig = Rig::new(Limits {
        arguments: 2,
        ..Limits::default()
    });
    assert_eq!(rig.run("a[1]=x; a[2]=y; a[3]=z"), 0);
    assert_eq!(rig.run("args \"${!a[@]}\""), 2);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn index_names_cancelled_expansion_preserves_array() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=(saved kept)"), 0);
    let job = rig
        .shell
        .start("while true; do : \"${!a[@]}\"; done")
        .unwrap();
    rig.ex.drive(64);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("args \"${a[@]}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["saved", "kept"]]);
}

#[test]
fn index_names_cancelled_large_enumeration_never_dispatches_partial_fields() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=({0..8191})"), 0);
    let job = rig.shell.start("args \"${!a[@]}\"").unwrap();
    rig.ex.drive(32);
    assert!(!job.is_finished());
    assert!(
        rig.calls.borrow().is_empty(),
        "no dispatch before cancellation"
    );
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args \"${#a[@]}\" \"${a[8191]}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["8192", "8191"]]);
}
