//! Pathname expansion is a prerequisite of executable for-word lists.
use super::*;

#[test]
fn for_globs_use_live_filesystem_entries_and_sorted_names() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir -p /tmp/glob-live; cd /tmp/glob-live; : >b.txt; : >a.txt; : >.hidden.txt; for f in *.txt; do args \"$f\"; done"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["a.txt"], vec!["b.txt"]]);
}

#[test]
fn for_nullglob_removes_only_unquoted_unmatched_patterns() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir -p /tmp/glob-empty; cd /tmp/glob-empty; for f in *.missing; do args \"$f\"; done; shopt -s nullglob; for f in *.missing '/tmp/no_*.txt' \\*.missing '['; do args \"$f\"; done; echo done"), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["*.missing"],
            vec!["/tmp/no_*.txt"],
            vec!["*.missing"],
            vec!["["]
        ]
    );
    assert_eq!(rig.output.bytes(), b"done\n");
    assert!(rig.errors.is_empty());
}

#[test]
fn original_relative_and_absolute_nullglob_regressions_end_successfully() {
    for source in [
        "mkdir -p /tmp/ng_on; cd /tmp/ng_on; shopt -s nullglob; for f in *.nonexistent; do echo \"got: $f\"; done; echo done",
        "shopt -s nullglob; for f in /tmp/nonexistent_pattern_xyz_*.txt; do echo \"found: $f\"; done; echo done",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0);
        assert_eq!(rig.output.bytes(), b"done\n", "{source}");
        assert!(rig.errors.is_empty());
    }
}

#[test]
fn for_globs_keep_mixed_quote_escape_and_parameter_protection() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir -p /tmp/glob-quotes; cd /tmp/glob-quotes; : >a.txt; : >'prefix*one'; : >prefixXone; pattern='*.txt'; for f in \"$pattern\" $pattern \"prefix*\"* prefix\\**; do args \"$f\"; done"), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["*.txt"],
            vec!["a.txt"],
            vec!["prefix*one"],
            vec!["prefix*one"]
        ]
    );
}

#[test]
fn literal_ifs_glob_characters_are_split_protected_but_not_glob_quoted() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir -p /tmp/glob-ifs; cd /tmp/glob-ifs; : >a.txt; : >b.txt; IFS='*'; for f in *.txt; do args \"$f\"; done"), 0);
    assert_eq!(*rig.calls.borrow(), [vec!["a.txt"], vec!["b.txt"]]);
}

#[test]
fn for_globs_traverse_directory_components_and_filter_trailing_slashes() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir -p /tmp/glob-path/a /tmp/glob-path/b; : >/tmp/glob-path/a/z.txt; : >/tmp/glob-path/b/y.txt; : >/tmp/glob-path/file; for f in /tmp/glob-path/*/?.txt; do args \"$f\"; done; for f in /tmp/glob-path/*/; do args \"$f\"; done"), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["/tmp/glob-path/a/z.txt"],
            vec!["/tmp/glob-path/b/y.txt"],
            vec!["/tmp/glob-path/a/"],
            vec!["/tmp/glob-path/b/"]
        ]
    );
}

#[test]
fn for_globs_handle_bracket_patterns_and_explicit_dot_names() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("mkdir -p /tmp/glob-classes; cd /tmp/glob-classes; : >a.txt; : >b.txt; : >.dot; for f in [ab].txt .*; do args \"$f\"; done"), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [vec!["a.txt"], vec!["b.txt"], vec![".dot"]]
    );
}

#[test]
fn unsupported_extended_pathname_patterns_fail_instead_of_becoming_literals() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("shopt -s extglob; pattern='@(a|b)'; for f in $pattern; do args \"$f\"; done"),
        2
    );
    assert!(rig.calls.borrow().is_empty());
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("shopt -s extglob; pattern='@(a|b)'; for f in \"$pattern\"; do args \"$f\"; done"),
        0
    );
    assert_eq!(*rig.calls.borrow(), [vec!["@(a|b)"]]);
}

#[test]
fn shell_pattern_quote_boundaries_are_distinct_from_scalar_patterns() {
    let rig = Rig::new(Limits::default());
    let source = r#"p='\'; case a in $p"a") args case-a;; esac; case ax in $p"a"x) args case-ax;; esac; value="${p}a"; case "$value" in $p"*") args case-slash;; esac; case a in $p"*") args forbidden;; esac; [[ a == $p"a" ]]; args "$?"; [[ a != $p"a" ]]; args "$?"; [[ ax == $p"a"x ]]; args "$?"; [[ ax != $p"a"x ]]; args "$?"; [[ "$value" == $p"*" ]]; args "$?"; [[ "$value" != $p"*" ]]; args "$?"; [[ a == $p"*" ]]; args "$?"; [[ a != $p"*" ]]; args "$?"; value=a; args "${value#$p"a"}" "${value^^$p"a"}""#;
    assert_eq!(rig.run(source), 0);
    assert_eq!(
        *rig.calls.borrow(),
        [
            vec!["case-a"],
            vec!["case-ax"],
            vec!["case-slash"],
            vec!["0"],
            vec!["1"],
            vec!["0"],
            vec!["1"],
            vec!["0"],
            vec!["1"],
            vec!["1"],
            vec!["0"],
            vec!["a", "a"],
        ]
    );
    assert!(rig.errors.is_empty());
}

#[test]
fn repeated_glob_matches_preserve_quote_boundary_escape_semantics() {
    for (source, expected) in [
        (
            ": >aa; : >ab; : >z; p='\\'; shopt -s nullglob; case a in $p\"a\") args case-no;; esac; [[ a == $p\"a\" ]] && args cond-no; case aa in $p\"a\"*) args case-a;; esac; [[ aa == $p\"a\"* ]] && args cond-a; for f in $p\"a\"*; do args \"$f\"; done",
            vec![
                vec!["case-no"],
                vec!["cond-no"],
                vec!["case-a"],
                vec!["cond-a"],
                vec!["aa"],
                vec!["ab"],
            ],
        ),
        (
            ": >'\\first'; : >'\\second'; : >z; p='\\'; shopt -s nullglob; for f in $p\"*\"*; do args \"$f\"; done",
            vec![vec!["\\first"], vec!["\\second"]],
        ),
        (
            ": >aa; p='\\'; shopt -s nullglob; for f in $p\"\\\\\"*; do args \"$f\"; done",
            vec![vec!["\\\\*"]],
        ),
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(source), 0, "{source}");
        assert_eq!(*rig.calls.borrow(), expected, "{source}");
        assert!(rig.errors.is_empty(), "{source}");
    }
}
