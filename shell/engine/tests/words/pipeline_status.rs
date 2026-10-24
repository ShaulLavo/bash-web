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
