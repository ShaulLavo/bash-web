use super::{Limits, Rig, check};

#[test]
fn array_slicing_sparse_offsets_count_present_elements() {
    check(
        "a[0]=zero; a[2]='two words'; a[5]=five; a[9]=nine; args \"${a[@]:1:2}\"; args \"${a[@]: -5:2}\"; args \"${a[@]: -11:2}\"",
        &[&["two words", "five"], &["five", "nine"], &[]],
    );
}

#[test]
fn array_slicing_at_star_and_empty_fields() {
    check(
        "a=(zero '' 'two words'); IFS=:; args \"pre${a[@]:1:2}post\"; args \"${a[*]:1:2}\"; args \"${a[@]:1:0}\"; args \"${a[*]:1:0}\"; args \"${missing[@]:0}\"",
        &[&["pre", "two wordspost"], &[":two words"], &[], &[""], &[]],
    );
}

#[test]
fn array_slicing_bounds_are_lazy_and_share_side_effects() {
    check(
        "a=(zero one two); i=0; args \"${a[@]:i++:++i}\" \"$i\"; args \"${a[@]:9:1/0}\"; args \"${missing[@]:i++:++i}\" \"$i\"",
        &[&["zero", "one", "2"], &[], &["2"]],
    );
}

#[test]
fn array_slicing_output_limits_reject_before_dispatch() {
    let rig = Rig::new(Limits {
        arguments: 2,
        ..Limits::default()
    });
    assert_eq!(rig.run("a=(a b c)"), 0);
    assert_eq!(rig.run("args \"${a[@]:0}\""), 2);
    assert!(rig.calls.borrow().is_empty());
    assert_eq!(rig.run("args \"${a[@]:1:1}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["b"]]);
}

#[test]
fn array_slicing_cancelled_large_slice_never_dispatches_partial_fields() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=({0..8191})"), 0);
    let job = rig.shell.start("args \"${a[@]:0}\"").unwrap();
    rig.ex.drive(32);
    assert!(!job.is_finished());
    assert!(rig.calls.borrow().is_empty());
    rig.shell.interrupt();
    let cancelled = rig.finish(job);
    assert_eq!((cancelled, rig.calls.borrow().len()), (130, 0));
    assert_eq!(rig.run("args \"${#a[@]}\" \"${a[8191]}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["8192", "8191"]]);
}

#[test]
fn array_slicing_skips_unselected_values_under_the_output_limit() {
    let rig = Rig::new(Limits {
        expansion_bytes: 65_536,
        ..Limits::default()
    });
    assert_eq!(rig.run("a=(first)"), 0);
    let append = format!("a+=({})", "unselected".repeat(512));
    for _ in 0..32 {
        assert_eq!(rig.run(&append), 0);
    }
    assert_eq!(rig.run("args \"${a[@]:0:1}\""), 0);
    assert_eq!(*rig.calls.borrow(), vec![vec!["first"]]);
    assert_eq!(rig.run("args \"${a[@]:0}\""), 2);
    assert_eq!(rig.calls.borrow().len(), 1);
}

#[test]
fn array_slicing_negative_length_aborts_before_dispatch() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("a=(a b c); args \"${a[@]:1:-1}\"; args after"), 1);
    assert!(rig.calls.borrow().is_empty());
}

#[test]
fn array_slicing_end_offset_skips_length_arithmetic() {
    check(
        "a=(a b c); i=0; args \"${a[@]:3:i++}\" \"$i\"; a[5]=five; args \"${a[@]:6:i++}\" \"$i\"",
        &[&["0"], &["0"]],
    );
}

#[test]
fn array_slicing_negative_offsets_reject_an_overflowed_exclusive_upper_bound() {
    check(
        "a[0]=zero; a[9223372036854775807]=last; args \"${a[@]: -1}\"; args \"${a[@]:9223372036854775807:1}\"",
        &[&[], &["last"]],
    );
}

#[test]
fn array_slicing_bound_side_effects_select_from_the_live_array() {
    let cases: [(&str, &[&[&str]]); 4] = [
        (
            "a[3]=x; a[5]=y; args \"${a[@]:(a=7,0)}\"",
            &[&["7", "x", "y"]],
        ),
        (
            "a[3]=x; a[5]=y; args \"${a[@]:0:(a=7,3)}\"",
            &[&["7", "x", "y"]],
        ),
        ("a[3]=x; a[5]=y; args \"${a[*]:(a=7,0)}\"", &[&["7 x y"]]),
        ("a[5]=five; args \"${a[@]:(a=1,-6):3}\"", &[&["1", "five"]]),
    ];
    for (source, expected) in cases {
        check(source, expected);
    }
}

#[test]
fn array_slicing_quoted_at_scalar_out_of_range_yields_no_word() {
    check(
        "s=abc; args \"${s[@]:5}\"; args \"${s[@]: -9}\"; args \"x${s[@]:5}\"; args \"${s[*]:5}\"; args \"${s[@]:3}\"",
        &[&[], &[], &["x"], &[""], &[""]],
    );
}
