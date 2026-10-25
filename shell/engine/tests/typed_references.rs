//! Step 1 contract checks from the existing frozen oracle, not a new oracle run.
use std::process::Command;

fn check(source: &str, expected: &str) {
    check_status(source, expected, 0);
}

fn check_status(source: &str, expected: &str, status: i32) {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", source])
        .env("LC_ALL", "C.UTF-8")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(status),
        "{source}\nstderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, expected.as_bytes(), "{source}");
    assert!(
        output.stderr.is_empty(),
        "{source}\nstderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn brush_nameref_18_reads_and_writes_an_element_target() {
    check(
        "arr=(zero one two three)\ndeclare -n ref='arr[2]'\necho \"ref: $ref\"\nref=\"changed\"\necho \"arr[2]: ${arr[2]}\"\n",
        "ref: two\narr[2]: changed\n",
    );
}

#[test]
fn brush_nameref_29_arithmetic_increment_writes_the_referent() {
    check(
        "arr=(10 20 30 40)\ndeclare -n ref='arr[2]'\necho \"before: $ref\"\n(( ref++ ))\necho \"after: $ref\"\necho \"arr[2]: ${arr[2]}\"\n",
        "before: 30\nafter: 31\narr[2]: 31\n",
    );
}

#[test]
fn brush_nameref_16_unset_element_preserves_siblings() {
    check(
        "target=(a b c d)\ndeclare -n ref=target\nunset 'ref[2]'\ndeclare -p target\n",
        "declare -a target=([0]=\"a\" [1]=\"b\" [3]=\"d\")\n",
    );
}

#[test]
fn bashkit_arith_array_lvalue_3_postincrement_updates_the_element() {
    check("a=(1 2); ((a[1]++)); echo \"${a[1]}\"\n", "3\n");
}

#[test]
fn bashkit_arith_array_lvalue_33_compound_write_evaluates_the_index() {
    check("a=(1 2); i=0; ((a[i]+=5)); echo \"${a[0]}\"\n", "6\n");
}

#[test]
fn oils_nameref_39_scope_control_separates_declaration_from_array_assignment() {
    check(
        "show_value() {\n  local -n array_name=$1\n  local idx=$2\n  echo \"${array_name[$idx]}\"\n}\ncaller() {\n  local shadock\n  shadock=(ga bu zo meu)\n  show_value shadock 2\n}\ncaller\n\n\n",
        "zo\n",
    );
}

#[test]
fn oils_array_672_test_v_distinguishes_missing_and_set_empty_elements() {
    check(
        "array=(1 2 3 '')\n\ntest -v 'array[1]'\necho set=$?\n\ntest -v 'array[3]'\necho empty=$?\n\ntest -v 'array[4]'\necho unset=$?\n\n",
        "set=0\nempty=0\nunset=1\n",
    );
}

#[test]
fn oils_array_700_double_bracket_uses_the_same_element_presence_contract() {
    check(
        "array=(1 2 3)\n[[ -v array[1] ]]\necho status=$?\n\n[[ -v array[4] ]]\necho status=$?\n\n",
        "status=0\nstatus=1\n",
    );
}

#[test]
fn scalar_compound_assignment_keeps_the_old_value_before_rhs_effects() {
    check("x=7; echo \"$((x+=x=4)):$x\"", "11:11\n");
}

#[test]
fn typed_reference_selector_runs_only_in_active_arithmetic_branches() {
    check(
        "a=(4 5); i=0; ((0 && a[i++]++)); ((1 || a[i++]++)); ((0 ? a[i++]++ : a[1]++)); echo \"$i:${a[0]}:${a[1]}\"",
        "0:4:6\n",
    );
}

#[test]
fn typed_reference_compound_and_increment_select_once() {
    check(
        "a=(3 4 5); i=0; ((a[i++]+=7)); ((++a[i++])); ((a[i++]++)); echo \"$i:${a[*]}\"",
        "3:10 5 6\n",
    );
}

#[test]
fn typed_reference_plain_store_does_not_evaluate_unused_old_value() {
    check("a[0]='1/0'; ((a[0]=7)); echo \"${a[0]}\"", "7\n");
}

#[test]
fn typed_reference_shell_rhs_precedes_explicit_index() {
    check(
        "a=(3 4); i=0; a[i++]=$((i=1,9)); echo \"$i:${a[*]}\"",
        "2:3 9\n",
    );
}

#[test]
fn typed_reference_negative_slot_empty_presence_and_unset_n() {
    check(
        "a=(zero one ''); declare -n r='a[-1]'; test -v 'a[-1]'; echo set=$?; test -v r; echo named=$?; r=last; unset -n r; echo \"${a[*]}\"; test -R r; echo ref=$?; unset 'a[-1]'; echo \"${a[*]}\"",
        "set=0\nnamed=1\nzero one last\nref=1\nzero one\n",
    );
}

#[test]
fn typed_reference_rhs_rebind_keeps_selected_index_and_old_value() {
    check(
        "a=(3 4); i=0; ((a[i++]+=a[0]=8)); echo \"$i:${a[*]}\"",
        "1:11 4\n",
    );
}

#[test]
fn typed_reference_dynamic_scope_is_resolved_at_use_not_declaration() {
    check(
        "a=(global); declare -n r='a[0]'; f() { local a; a=(local); r=changed; echo \"$r:${a[0]}\"; }; f; echo \"$r:${a[0]}\"",
        "changed:changed\nglobal:global\n",
    );
}

// Causal refinements of the frozen array/nameref and lazy-scalar contracts.
// These are invariant tests, not newly recorded Bash oracle observations.
#[test]
fn typed_reference_arithmetic_recursion_distinguishes_selected_elements() {
    check("a[0]='a[1]+1'; a[1]=2; echo \"$((a[0]))\"", "3\n");
}

#[test]
fn typed_reference_lazy_operators_read_the_selected_element() {
    check(
        "a=(old); declare -n r='a[0]'; echo \"${r:-fallback}:${r+present}:${r:=new}:${a[0]}\"",
        "old:present:old:old\n",
    );
}

#[test]
fn typed_reference_lazy_operators_distinguish_set_empty() {
    check(
        "a=(''); declare -n r='a[0]'; echo \"${r-word}:${r:-word}:${r+yes}:${r:+yes}:${r=new}\"; echo \"${r:=filled}:${a[0]}\"",
        ":word:yes::\nfilled:filled\n",
    );
}

#[test]
fn typed_reference_lazy_assignment_selects_once_and_writes_the_element() {
    check(
        "a=(); i=0; declare -n r='a[i++]'; echo \"${r:=new}\"; echo \"$i:${a[0]}\"; declare -p r",
        "new\n1:new\ndeclare -n r=\"a[i++]\"\n",
    );
}

#[test]
fn typed_reference_lazy_operands_skip_inactive_effects() {
    check(
        "a=(old); i=0; declare -n r='a[0]'; echo \"${r:-$((i++))}:${r:=$((i++))}:${r:?$((i++))}\"; unset 'a[0]'; echo \"${r+$((i++))}:$i\"",
        "old:old:old\n:0\n",
    );
}

#[test]
fn typed_reference_lazy_assignment_keeps_completed_rhs_effects() {
    check(
        "a=(); declare -n r='a[1]'; echo \"${r:=${a:=base}}\"; echo \"${a[0]}:${a[1]}\"",
        "base\nbase:base\n",
    );
}

#[test]
fn typed_reference_direct_funcname_default_uses_existing_projection() {
    check(
        "echo \"${FUNCNAME[0]:-top}\"; f() { echo \"name=${FUNCNAME[0]:-top}:${FUNCNAME[9]:-missing}\"; }; f; echo \"${FUNCNAME[0]:-top}\"",
        "top\nname=f:missing\ntop\n",
    );
}

#[test]
fn typed_reference_special_subscript_declaration_refuses_before_publication() {
    check(
        "r=kept; declare -n r='PIPESTATUS[0]'; echo \"status=$?:$r\"; declare -p r; declare -n s='FUNCNAME[0]'; echo \"status=$?\"; test -R s; echo \"ref=$?\"",
        "status=2:kept\ndeclare -- r=\"kept\"\nstatus=2\nref=1\n",
    );
}

#[test]
fn typed_reference_sparse_declaration_preserves_existing_attributes() {
    check(
        "a=(old); readonly a; export a; declare -p a; declare -l b; b=(ABC); declare -p b; declare -u c; c=(abc); declare -p c",
        "declare -arx a=([0]=\"old\")\ndeclare -al b=([0]=\"abc\")\ndeclare -au c=([0]=\"ABC\")\n",
    );
}

#[test]
fn typed_reference_direct_special_defaults_keep_existing_array_reads() {
    check(
        "outer() { local -n ref=FUNCNAME; echo \"${ref[0]}:${ref[0]:-fallback}\"; }; outer; false | true; echo \"${PIPESTATUS[0]:-missing}:${PIPESTATUS[1]:-missing}:${PIPESTATUS[8]:-missing}\"",
        "outer:outer\n1:0:missing\n",
    );
}

#[test]
fn oils_array_868_empty_negative_presence_is_false() {
    check_status("e=()\n[[ -v e[-1] ]] && echo 'e has -1'\n\n", "", 1);
}

#[test]
fn oils_array_sparse_477_invalid_negative_presence_is_false() {
    check_status(
        "case $SH in mksh) exit ;; esac\n\nsp1=()\n([[ -v sp1[-1] ]]; echo \"$? (expect 1)\")\nsp2=({1..9})\n([[ -v sp2[-10] ]]; echo \"$? (expect 1)\")\nsp3=({1..9})\nunset -v 'sp3[4]'\n([[ -v sp3[-10] ]]; echo \"$? (expect 1)\")\n\n",
        "1 (expect 1)\n1 (expect 1)\n1 (expect 1)\n",
        0,
    );
}

#[test]
fn brush_extended_tests_48_bare_nameref_presence_keeps_literal_target() {
    check_status(
        "arr=(a b c d)\ndeclare -n ref='arr[2]'\n[[ -v ref ]] && echo \"set\" || echo \"unset\"\n",
        "unset\n",
        0,
    );
}

#[test]
fn bashkit_assoc_arrays_58_unsupported_key_unset_preserves_indexed_value() {
    check_status(
        "declare -A m\nm[a]=\"1\"\nm[b]=\"2\"\nunset 'm[a]'\necho \"${#m[@]}\"\necho \"${m[b]}\"\n",
        "1\n2\n",
        0,
    );
}

#[test]
fn bashkit_blackbox_305_unsupported_key_unset_keeps_indexed_count() {
    check_status(
        "declare -A m; m[a]=1; m[b]=2; unset m[a]; echo ${#m[@]}\n",
        "1\n",
        0,
    );
}
