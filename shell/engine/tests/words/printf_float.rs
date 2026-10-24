use super::{Limits, Rig, printf};

#[test]
fn printf_float_matches_recorded_bash() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/fixtures/shell-printf-float.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        rig.variable("LC_ALL", "C.UTF-8");
        let code = case["code"].as_str().unwrap();
        assert_eq!(
            rig.run(code),
            case["status"].as_i64().unwrap() as i32,
            "{code}"
        );
        assert_eq!(
            rig.errors.bytes(),
            case["stderr"].as_str().unwrap().as_bytes(),
            "{code}"
        );
        assert_eq!(
            rig.output.bytes(),
            case["stdout"].as_str().unwrap().as_bytes(),
            "{code}"
        );
    }
}

#[test]
fn printf_float_preserves_output_admission_and_cancellation() {
    for source in [
        "printf 'prefix%1000000000f' 1",
        "printf 'prefix%.2147483647e' 1",
        "printf 'prefix%*g' -2147483648 1",
        "printf 'prefix%.*f' 2147483647 1",
        "printf '%600f' 1 2",
        r"printf 'prefix%2000f%bBAD' 3x '\c'",
    ] {
        printf::assert_warning_admission(source);
    }
    printf::assert_admission_cancellation("started=yes; printf 'prefix%0900000f' 42; echo bad");
}

#[test]
fn printf_float_streams_padding_and_fraction_without_large_buffers() {
    let rig = Rig::new(Limits::default());
    let (output, records) = printf::recorded_endpoint();
    printf::replace_output(&rig, output);
    printf::check_chunks(&rig, &records, "printf '%+08193.2f' 1.25", &[4096, 4096, 1]);
    let bytes = records.borrow().concat();
    assert_eq!(bytes.len(), 8193);
    assert_eq!(bytes[0], b'+');
    assert!(bytes[1..8189].iter().all(|byte| *byte == b'0'));
    assert_eq!(&bytes[8189..], b"1.25");
    records.borrow_mut().clear();
    printf::check_chunks(&rig, &records, "printf '%.8190f' 1.25", &[4096, 4096]);
    let bytes = records.borrow().concat();
    assert_eq!(&bytes[..4], b"1.25");
    assert!(bytes[4..].iter().all(|byte| *byte == b'0'));
}

#[test]
fn printf_float_pipe_delivery_and_diagnostic_cancellation_preserve_status() {
    printf::assert_pipe_delivery("printf '%+0200000f' 42; echo bad", b'+', b'0');
    printf::assert_diagnostic_backpressure_cancellation(r"printf '[%08f]%bBAD' 3x '\c'", 2);
}

#[test]
fn printf_float_rejects_excess_numeric_work_before_any_output() {
    let rig = Rig::new(Limits::default());
    rig.variable("operand", &"9".repeat(12_001));
    assert_eq!(rig.run("printf 'prefix%f' \"$operand\" \"$operand\""), 2);
    assert!(rig.output.bytes().is_empty());
}
