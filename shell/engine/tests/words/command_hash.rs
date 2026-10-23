use super::*;

#[test]
fn command_hash_frozen_bash_recordings() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-command-hash.json"
    ))
    .unwrap();
    assert_eq!(fixture["bash"], "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)");
    for case in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        assert_eq!(rig.run(case["script"].as_str().unwrap()), case["status"].as_i64().unwrap() as i32, "{}", case["id"]);
        assert_eq!(rig.output.bytes(), case["stdout"].as_str().unwrap().as_bytes(), "{}", case["id"]);
        assert!(rig.calls.borrow().is_empty());
        assert_eq!(rig.host.active_count(), 0);
    }
}
