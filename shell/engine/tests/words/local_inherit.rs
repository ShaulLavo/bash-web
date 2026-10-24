use super::*;

#[test]
fn local_inherit_value_append_and_absent_creation_preserve_outer_bindings() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=base; f() { local -I v+=' +more' fresh=new; printf '[%s]:%s\\n' \"$v\" \"$fresh\"; v=changed; }; f; printf '[%s]:%s\\n' \"$v\" \"${fresh-unset}\""), 0);
    assert_eq!(rig.output.bytes(), b"[base +more]:new\n[base]:unset\n");
}

#[test]
fn local_inherit_uses_caller_value_and_current_local_unset_is_not_refilled() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=global; inner() { local -I v; printf '%s\\n' \"$v\"; v=inner; }; outer() { local v=caller; inner; printf '%s\\n' \"$v\"; unset v; local -I v; printf '%s\\n' \"${v-unset}\"; local -I v+=new; printf '%s\\n' \"$v\"; }; outer; printf '%s\\n' \"$v\""), 0);
    assert_eq!(rig.output.bytes(), b"caller\ncaller\nunset\nnew\nglobal\n");
}

#[test]
fn local_inherit_keeps_export_ownership_and_unset_creation() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("export v=outer; f() { local -I v; local -Ix absent; declare -p v absent; v=inner; }; f; declare -p v; declare -p absent 2>/dev/null"), 1);
    assert_eq!(
        rig.output.bytes(),
        b"declare -x v=\"outer\"\ndeclare -x absent\ndeclare -x v=\"outer\"\n"
    );
}

#[test]
fn local_inherit_distinguishes_function_prefix_from_ordinary_caller_locals() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=global; inner() { local -I v+=tail; printf '%s\\n' \"$v\"; }; outer() { local v=caller; v=prefix inner; printf '%s\\n' \"$v\"; }; outer; printf '%s\\n' \"$v\""), 0);
    assert_eq!(rig.output.bytes(), b"prefixtail\ncaller\nglobal\n");
}

#[test]
fn local_inherit_target_errors_continue_but_nameref_append_stays_fatal() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("readonly v=outer; f() { local -I v=bad 1bad=x after=yes; printf '%s:%s:%s\\n' \"$?\" \"$after\" \"$v\"; }; f 2>/dev/null"), 0);
    assert_eq!(rig.output.bytes(), b"1:yes:outer\n");
    assert_eq!(rig.run("f() { local -In r+=target after=yes; }; f"), 2);
    assert_eq!(rig.value("after"), None);
}
