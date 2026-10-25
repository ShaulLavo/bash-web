//! Original invalid-target status controls from GNU Bash 5.3.15 observations.
use super::*;

#[test]
fn invalid_nameref_scalar_targets_return_one_without_creating_bindings() {
    for target in [
        "123",
        "1",
        "1x",
        "a-b",
        "not-a-name",
        "a.b",
        "a+b",
        "a b",
        "@",
        "*",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!("declare -n ref='{target}'")),
            1,
            "{target}"
        );
        assert_eq!(rig.run("test -R ref"), 1);
        let state = rig.shell.state();
        let state = state.borrow();
        assert!(!state.bindings().contains_key("ref"));
        assert!(!state.bindings().contains_key(target));
    }
}

#[test]
fn invalid_nameref_redeclarations_leave_values_and_targets_unchanged() {
    check_output(
        r#"ref=kept; declare -n ref='a b'; echo "$?:$ref"; ref=ordinary; echo "$ref"; target=kept; declare -n alias=target; declare -n alias='1x'; echo "$?:$alias:${!alias}"; alias=written; echo "$target""#,
        "1:kept\nordinary\n1:kept:target\nwritten\n",
    );
    check_output(
        r#"ref='a b'; typeset -n ref; echo "$?:$ref"; ref=ordinary; echo "$ref""#,
        "1:a b\nordinary\n",
    );
}

#[test]
fn invalid_nameref_operands_allow_later_valid_operands() {
    check_output(
        r#"target=kept; declare -n bad='a b' good=target other='1x' last=target; echo "$?:${bad+set}:$good:${other+set}:$last"; last=written; echo "$target""#,
        "1::kept::kept\nwritten\n",
    );
}

#[test]
fn invalid_nameref_local_declarations_preserve_outer_binding_and_continue() {
    check_output(
        r#"target=kept; ref=outer; f() { local -n ref='a b' good=target; echo "$?:$ref:$good"; good=written; }; f; echo "$ref:$target:${good+set}"; declare -n ref=target; g() { declare -n ref='1x'; echo "$?:$ref:${!ref}"; }; g; echo "$ref:${!ref}""#,
        "1:outer:kept\nouter:written:\n1:written:target\nwritten:target\n",
    );
}

#[test]
fn invalid_nameref_target_does_not_change_readonly_bindings() {
    check_output(
        r#"readonly ref=kept; declare -n ref='a b'; echo "$?:$ref"; readonly target=old; declare -n alias=target; declare -n alias='a.b'; echo "$?:$alias:${!alias}"; alias=written
echo "$?:$target""#,
        "1:kept\n1:old:target\n1:old\n",
    );
}

#[test]
fn nameref_empty_unset_subscript_and_pipestatus_targets_stay_unsupported() {
    for operand in [
        "ref=",
        "ref",
        "ref=array[",
        "ref=array]",
        "ref=PIPESTATUS",
        "PIPESTATUS=target",
    ] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(&format!("declare -n {operand} later=target")), 2);
        assert_eq!(rig.run("test -R ref"), 1);
        assert_eq!(rig.run("test -R later"), 1);
    }
}

#[test]
fn invalid_nameref_admission_failure_stays_status_two_without_mutation() {
    let rig = Rig::new(Limits {
        expansion_bytes: 128,
        ..Limits::default()
    });
    assert_eq!(rig.run("declare -n ref='a b'"), 2);
    assert_eq!(rig.run("test -R ref"), 1);
    assert!(!rig.shell.state().borrow().bindings().contains_key("ref"));
}

#[test]
fn invalid_nameref_work_cancellation_stays_status_130_without_mutation() {
    let rig = Rig::new(Limits::default());
    rig.variable("large", &"!".repeat(300_000));
    let job = rig.shell.start("declare -n ref=$large").unwrap();
    rig.ex.drive(4);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert_eq!(rig.run("test -R ref"), 1);
    assert!(!rig.shell.state().borrow().bindings().contains_key("ref"));
    assert_eq!(rig.ex.drive(64).pending, 0);
    assert_eq!(rig.run("echo recovered"), 0);
    assert_eq!(rig.output.bytes(), b"recovered\n");
}
