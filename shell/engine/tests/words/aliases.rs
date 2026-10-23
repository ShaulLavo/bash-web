//! Original alias reader resource-diagnostic controls.
use super::*;

#[test]
fn alias_refresh_reports_parser_limits_instead_of_silent_status_two() {
    let rig = Rig::new(Limits::default());
    let source = format!(
        "shopt -s expand_aliases\nalias x=': {}'\necho before\nx; x\necho BAD\n",
        "a".repeat(60_000)
    );
    assert_eq!(rig.run(&source), 2);
    assert_eq!(rig.output.bytes(), b"before\n");
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("parser fuel exhausted"),
        "a parser limit must have a diagnostic"
    );
}

#[test]
fn eval_reports_its_initial_parser_limit() {
    let rig = Rig::new(Limits::default());
    let setup = format!(
        "shopt -s expand_aliases\nalias x=': {}'\n",
        "a".repeat(60_000)
    );
    assert_eq!(rig.run(&setup), 0);
    assert_eq!(rig.run("eval 'x; x'\necho after"), 2);
    assert!(
        String::from_utf8(rig.errors.bytes())
            .unwrap()
            .contains("parser fuel exhausted"),
        "eval's initial parser limit must have a diagnostic"
    );
}
