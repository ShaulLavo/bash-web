//! Step 1 contract checks from the existing frozen oracle, not a new oracle run.
use std::process::Command;

fn check(source: &str, expected: &str) {
    let output = Command::new(env!("CARGO_BIN_EXE_shell-engine"))
        .args(["-c", source])
        .env("LC_ALL", "C.UTF-8")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
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
fn oils_nameref_39_resolves_a_calling_functions_local_array() {
    check(
        "show_value() {\n  local -n array_name=$1\n  local idx=$2\n  echo \"${array_name[$idx]}\"\n}\ncaller() {\n  local shadock=(ga bu zo meu)\n  show_value shadock 2\n}\ncaller\n\n\n",
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
