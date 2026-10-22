use super::*;

#[test]
fn named_declarations_match_recorded_bash_5_3_15() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-declare-print.json"
    ))
    .unwrap();
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
    rig.ex.drive(1);
    assert!(!job.is_finished());
    rig.shell.interrupt();
    assert_eq!(rig.finish(job), 130);
    assert!(rig.output.bytes().is_empty());
    assert_eq!(
        rig.shell.state().borrow().bindings()["v"],
        "$".repeat(12000)
    );
}
