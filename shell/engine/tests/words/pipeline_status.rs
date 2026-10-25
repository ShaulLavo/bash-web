use super::*;

#[test]
fn pipeline_status_preserves_completed_stages_across_wrappers() {
    check_output(
        "case $SH in dash|zsh) exit ;; esac; echo pipestatus ${PIPESTATUS[@]}",
        "pipestatus\n",
    );
    check_output(
        "false | true; { false | true; }; echo ${PIPESTATUS[@]}; false | true; case x in y) ;; esac; echo ${PIPESTATUS[@]}; false | true; f() { :; }; echo ${PIPESTATUS[@]}",
        "1 0\n1 0\n1 0\n",
    );
}

#[test]
fn pipeline_status_declaration_snapshots_before_its_own_status() {
    check_output(
        "true | false | true; echo \"${PIPESTATUS[*]}\" ${#PIPESTATUS[@]}; declare -p PIPESTATUS",
        "0 1 0 3\ndeclare -a PIPESTATUS=([0]=\"0\")\n",
    );
    check_output(
        "false | true; declare -p PIPESTATUS; echo ${PIPESTATUS[@]}",
        "declare -a PIPESTATUS=([0]=\"1\" [1]=\"0\")\n0\n",
    );
}

#[test]
fn pipeline_status_ordinary_negated_and_isolated_commands_keep_real_codes() {
    check_output(
        "false; echo ${PIPESTATUS[@]}; ! true; echo ${PIPESTATUS[@]}; f() { return 3; }; f; echo ${PIPESTATUS[@]}",
        "1\n0\n3\n",
    );
    check_output(
        "false | true; x=$(false); echo ${PIPESTATUS[@]}; (( 0 )); echo ${PIPESTATUS[@]}; [[ a == a ]]; echo ${PIPESTATUS[@]}; (exit 3); echo ${PIPESTATUS[@]}",
        "1\n1\n0\n3\n",
    );
    check_output("false | true; echo $(echo ${PIPESTATUS[@]})", "1 0\n");
}

#[test]
fn pipeline_status_declaration_preserves_active_attributes() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../scripts/cases/pipeline-status-attributes.json"
    ))
    .unwrap();
    for item in fixture["cases"].as_array().unwrap() {
        let rig = Rig::new(Limits::default());
        rig.check_recorded(item, item["stdout"].as_str().unwrap().as_bytes());
    }
}

#[test]
fn lastpipe_captures_pipefail_before_either_option_mutation() {
    for (initial, mutation, expected) in [("-o", "+o", 1), ("+o", "-o", 0)] {
        check_output(
            &format!(
                r#"shopt -s lastpipe; set {initial} pipefail; false | set {mutation} pipefail; printf 'STATUS:%s PIPE:%s\n' "$?" "${{PIPESTATUS[*]}}""#
            ),
            &format!("STATUS:{expected} PIPE:1 0\n"),
        );
    }
}

#[test]
fn lastpipe_option_mutation_applies_to_the_next_pipeline() {
    for (initial, mutation, first, next) in [("-o", "+o", 1, 0), ("+o", "-o", 0, 1)] {
        check_output(
            &format!(
                r#"shopt -s lastpipe; set {initial} pipefail; false | set {mutation} pipefail; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}"; false | true; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#
            ),
            &format!("{first}:1 0\n{next}:1 0\n"),
        );
    }
}

#[test]
fn lastpipe_function_and_nested_pipeline_capture_their_own_pipefail() {
    for (initial, mutation, first, next) in [("-o", "+o", 1, 0), ("+o", "-o", 0, 1)] {
        check_output(
            &format!(
                r#"shopt -s lastpipe; set {initial} pipefail; f() {{ set {mutation} pipefail; }}; false | f; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}"; false | true; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#
            ),
            &format!("{first}:1 0\n{next}:1 0\n"),
        );
        check_output(
            &format!(
                r#"shopt -s lastpipe; set {initial} pipefail; f() {{ false | set {mutation} pipefail; printf 'inner:%s:%s\n' "$?" "${{PIPESTATUS[*]}}"; }}; false | f; printf 'outer:%s:%s\n' "$?" "${{PIPESTATUS[*]}}"; false | true; printf 'next:%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#
            ),
            &format!("inner:{first}:1 0\nouter:{first}:1 0\nnext:{next}:1 0\n"),
        );
    }
}

#[test]
fn lastpipe_negation_uses_captured_pipefail_without_negating_stage_codes() {
    for (initial, mutation, expected) in [("-o", "+o", 0), ("+o", "-o", 1)] {
        check_output(
            &format!(
                r#"shopt -s lastpipe; set {initial} pipefail; ! false | set {mutation} pipefail; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#
            ),
            &format!("{expected}:1 0\n"),
        );
    }
}

#[test]
fn lastpipe_conditions_use_captured_pipefail() {
    for (initial, mutation, branch) in [("-o", "+o", "no"), ("+o", "-o", "yes")] {
        for pipeline in [
            format!("false | set {mutation} pipefail && echo yes || echo no"),
            format!("if false | set {mutation} pipefail; then echo yes; else echo no; fi"),
        ] {
            check_output(
                &format!("shopt -s lastpipe; set {initial} pipefail; {pipeline}"),
                &format!("{branch}\n"),
            );
        }
    }
}

#[test]
fn lastpipe_errexit_uses_captured_pipefail_and_keeps_mutated_option() {
    for (initial, mutation, output, policy) in
        [("-o", "+o", "", false), ("+o", "-o", "first:0:1 0\n", true)]
    {
        let rig = Rig::new(Limits::default());
        assert_eq!(
            rig.run(&format!(
                r#"shopt -s lastpipe; set -e {initial} pipefail; false | set {mutation} pipefail; printf 'first:%s:%s\n' "$?" "${{PIPESTATUS[*]}}"; false | true; echo forbidden"#
            )),
            1,
        );
        assert_eq!(rig.output.bytes(), output.as_bytes());
        assert_eq!(rig.shell.state().borrow().pipefail, policy);
        assert_eq!(rig.ex.drive(64).pending, 0);
    }
}

#[test]
fn isolated_final_stage_does_not_mutate_caller_pipefail() {
    for setup in ["shopt -u lastpipe", "shopt -s lastpipe; set -m"] {
        for (initial, mutation, expected) in [("-o", "+o", 1), ("+o", "-o", 0)] {
            check_output(
                &format!(
                    r#"{setup}; set {initial} pipefail; false | set {mutation} pipefail; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}"; false | true; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#
                ),
                &format!("{expected}:1 0\n{expected}:1 0\n"),
            );
        }
    }
}

#[test]
fn lastpipe_captured_policy_keeps_the_rightmost_failure_and_stage_order() {
    for (initial, mutation, expected) in [("-o", "+o", 3), ("+o", "-o", 0)] {
        check_output(
            &format!(
                r#"shopt -s lastpipe; set {initial} pipefail; (exit 7) | (exit 3) | set {mutation} pipefail; printf '%s:%s\n' "$?" "${{PIPESTATUS[*]}}""#
            ),
            &format!("{expected}:7 3 0\n"),
        );
    }
}

#[test]
fn lastpipe_option_mutation_does_not_mask_cancellation() {
    for (initial, mutation, policy) in [("-o", "+o", false), ("+o", "-o", true)] {
        for negation in ["", "! "] {
            let rig = Rig::new(Limits::default());
            let job = rig.start_until_value(
                &format!(
                    "shopt -s lastpipe; set {initial} pipefail; {negation}false | {{ set {mutation} pipefail; ready=yes; while :; do :; done; }}; echo forbidden"
                ),
                1000,
                "ready",
                "yes",
            );
            assert!(!job.is_finished());
            rig.shell.interrupt();
            assert_eq!(rig.finish(job), 130);
            assert!(rig.output.bytes().is_empty());
            assert_eq!(rig.shell.state().borrow().pipefail, policy);
            assert_eq!(rig.run(r#"printf '%s:%s\n' "$?" "${PIPESTATUS[*]}""#), 0,);
            assert_eq!(rig.output.bytes(), b"130:1 130\n");
            assert_eq!(rig.ex.drive(64).pending, 0);
        }
    }
}
