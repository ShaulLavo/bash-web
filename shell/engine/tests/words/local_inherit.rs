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

#[test]
fn local_inherit_keeps_case_mapping_and_restores_export_flags() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("declare -u v=outer; f() { local -Ix v+=more; v=mixed; declare -p v; }; f; declare -p v; f() { local -I v; unset v; local -I v; printf '%s\\n' \"${v-unset}\"; }; f; declare -p v"), 0);
    assert_eq!(
        rig.output.bytes(),
        b"declare -xu v=\"MIXED\"\ndeclare -u v=\"OUTER\"\nunset\ndeclare -u v=\"OUTER\"\n"
    );
}

#[test]
fn local_inherit_prefix_owner_is_not_an_ordinary_unset_declaration() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("v=global; inner() { local -I v; printf '%s\\n' \"$v\"; }; outer() { local v; inner; unset v; local -I v; inner; }; v=prefix outer; printf '%s\\n' \"$v\""), 0);
    assert_eq!(rig.output.bytes(), b"prefix\n\nglobal\n");
}

#[test]
fn inherited_local_cancellation_and_dropped_observer_restore_the_caller() {
    for drop_observer in [false, true] {
        let rig = Rig::new(Limits::default());
        register_inherited_park(&rig.host);
        let job = rig.shell.start("export v=outer; n=0; f() { local -I v+=x; n=$((n+1)); case $n in 32) park_inherited;; *) f;; esac; }; f").unwrap();
        rig.drive_until_value(10_000, "n", "32");
        if drop_observer {
            drop(job);
            rig.shell.interrupt();
        } else {
            rig.interrupt_without_calls(job);
        }
        rig.ex.drive(10_000);
        assert_eq!(rig.run("declare -p v; unset -f f"), 0);
        assert_eq!(rig.output.bytes(), b"declare -x v=\"outer\"\n");
        assert_eq!(rig.host.active_count(), 0);
        assert_eq!(rig.host.retained_count(), 0);
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

#[test]
fn inherited_local_copy_yields_before_mutation_and_can_be_cancelled() {
    let rig = Rig::new(Limits::default());
    let outer = "x".repeat(128 * 1024);
    rig.variable("v", &outer);
    let job = rig.start_until_value(
        "f() { ready=yes; local -I v; v=changed; }; f; args bad",
        10_000,
        "ready",
        "yes",
    );
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.value("v"), Some(outer));
    assert_eq!(rig.ex.drive(64).pending, 0);
}

fn register_inherited_park(host: &InProcessHost) {
    host.register("/home/guest/park_inherited", |_, cancel| {
        async move {
            cancel.cancelled().await;
            130
        }
        .boxed_local()
    });
}

#[test]
fn local_inherit_ifs_restores_the_caller_separator() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run(r#"IFS=:; f() { local -I IFS; IFS=,; set -- a b; printf '<%s>\n' "$*"; }; f; set -- a b; printf '<%s>\n' "$*""#),
        0
    );
    assert_eq!(rig.output.bytes(), b"<a,b>\n<a:b>\n");
}

#[test]
fn declaration_bridge_inherited_copy_cancellation_publishes_no_requested_attributes() {
    let rig = Rig::new(Limits::default());
    let outer = "x".repeat(128 * 1024);
    rig.variable("v", &outer);
    let job = rig.start_until_value(
        "f() { ready=yes; local -Ixr v; }; f; args bad",
        10_000,
        "ready",
        "yes",
    );
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.value("v"), Some(outer));
    assert!(!rig.shell.state().borrow().exported_bindings().contains("v"));
    assert!(!rig.shell.state().borrow().readonly_bindings().contains("v"));
    assert_eq!(rig.ex.drive(64).pending, 0);
}

#[test]
fn declaration_bridge_refused_operand_keeps_earlier_operand_and_caller_metadata() {
    let rig = Rig::new(Limits::default());
    assert_eq!(rig.run("readonly locked=outer; f() { local -Ixr before=kept locked=bad after=last; printf '%s:%s:%s:%s\n' \"$?\" \"$before\" \"$locked\" \"$after\"; }; f 2>/dev/null; declare -p locked; printf '%s:%s\n' \"${before-unset}\" \"${after-unset}\""), 0);
    assert_eq!(
        rig.output.bytes(),
        b"1:kept:outer:last\ndeclare -r locked=\"outer\"\nunset:unset\n"
    );
}
