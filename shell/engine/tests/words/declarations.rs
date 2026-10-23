use super::*;

#[test]
fn named_declarations_match_recorded_bash_5_3_15() {
    declarations_match_recording(include_str!(
        "../../../../scripts/fixtures/shell-declare-print.json"
    ));
}

#[test]
fn declaration_appends_match_recorded_bash_5_3_15() {
    declarations_match_recording(include_str!(
        "../../../../scripts/fixtures/shell-declaration-append.json"
    ));
}

#[test]
fn declaration_scope_appends_match_recorded_bash_5_3_15() {
    declarations_match_recording(include_str!(
        "../../../../scripts/fixtures/shell-declaration-append-scope.json"
    ));
}

fn declarations_match_recording(recording: &str) {
    let fixture: serde_json::Value = serde_json::from_str(recording).unwrap();
    assert_eq!(
        fixture["bash"],
        "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)"
    );
    for item in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", "C.UTF-8");
        let code = item["code"].as_str().unwrap();
        assert_eq!(
            rig.run(code),
            item["status"].as_i64().unwrap() as i32,
            "{code}"
        );
        assert_eq!(
            rig.output.bytes(),
            decode_base64(item["stdout"].as_str().unwrap()),
            "{code}"
        );
    }
}

fn decode_base64(encoded: &str) -> Vec<u8> {
    let mut bits = 0u32;
    let mut length = 0;
    let mut result = Vec::new();
    for byte in encoded.bytes().take_while(|byte| *byte != b'=') {
        let value = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
            .iter()
            .position(|digit| *digit == byte)
            .unwrap() as u32;
        bits = (bits << 6) | value;
        length += 6;
        if length >= 8 {
            length -= 8;
            result.push((bits >> length) as u8);
        }
    }
    result
}

#[test]
fn declaration_inspection_limits_do_not_modify_bindings() {
    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        ..Limits::default()
    });
    rig.variable("v", &"$".repeat(2048));
    assert_eq!(rig.run("declare -p v"), 2);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.shell.state().borrow().bindings()["v"], "$".repeat(2048));
}

#[test]
fn declaration_inspection_yields_and_cancels_without_mutation() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", &"$".repeat(12000));
    let job = rig.shell.start("declare -p v").unwrap();
    rig.interrupt_after_counting_yields(job);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(
        rig.shell.state().borrow().bindings()["v"],
        "$".repeat(12000)
    );
}

#[test]
fn indexed_declarations_reject_without_scalar_projection_or_mutation() {
    for setup in ["a=(zero one)", "a=()", "a=(); a[7]=seven"] {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(setup), 0, "{setup}");
        let before = rig.shell.state().borrow().bindings()["a"].clone();
        assert_eq!(rig.run("declare -p a"), 2, "{setup}");
        assert!(rig.output.bytes().is_empty(), "{setup}");
        assert_eq!(rig.shell.state().borrow().bindings()["a"], before);
    }
}

#[test]
fn indexed_declaration_rejection_preserves_local_and_raw_reference() {
    let rig = Rig::new(Limits::default());
    assert_eq!(
        rig.run("a=(global); f() { local a; a=(local); declare -p a; }; f"),
        2
    );
    assert_eq!(rig.run("printf '%s\\n' \"${a[@]}\""), 0);
    assert_eq!(rig.output.bytes(), b"global\n");
    assert_eq!(rig.run("declare -n r=a; declare -p r"), 0);
    assert_eq!(rig.output.bytes(), b"global\ndeclare -n r=\"a\"\n");
}

#[test]
fn declaration_append_limits_reject_before_mutating_the_binding() {
    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        ..Limits::default()
    });
    rig.variable("v", &"a".repeat(256));
    assert_eq!(rig.run("export v+=x"), 2);
    assert_eq!(rig.value("v"), Some("a".repeat(256)));
}

#[test]
fn declaration_append_scanning_yields_and_cancels_before_mutation() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", &"a".repeat(12000));
    let job = rig.shell.start("export v+=x").unwrap();
    rig.interrupt_after_counting_yields(job);
    assert_eq!(rig.value("v"), Some("a".repeat(12000)));
    assert!(rig.output.bytes().is_empty());
}

#[test]
fn local_declaration_append_limit_restores_target_and_reference() {
    let rig = Rig::new(Limits {
        expansion_bytes: 256,
        ..Limits::default()
    });
    rig.variable("v", &"a".repeat(256));
    assert_eq!(rig.run("t=outer; declare -n r=t"), 0);
    assert_eq!(
        rig.run("f(){ local t=$v; local -n r=t; local r+=x; }; f"),
        2
    );
    assert_eq!(rig.value("t"), Some("outer".into()));
    assert_eq!(rig.run("declare -p r"), 0);
    assert_eq!(rig.output.bytes(), b"declare -n r=\"t\"\n");
}

#[test]
fn local_declaration_append_cancellation_restores_array_and_reference() {
    let rig = Rig::new(Limits::default());
    rig.variable("v", &"a".repeat(12000));
    assert_eq!(rig.run("a=(outer keep); declare -n r=a"), 0);
    let job = rig
        .shell
        .start("f(){ local a; a=(\"$v\" keep); local -n r=a; ready=yes; local r+=x; }; f")
        .unwrap();
    rig.drive_until_variable("ready", "yes");
    rig.interrupt_after_counting_yields(job);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(rig.run("declare -p r; printf '<%s>\\n' \"${a[@]}\""), 0);
    assert_eq!(rig.output.bytes(), b"declare -n r=\"a\"\n<outer>\n<keep>\n");
}
