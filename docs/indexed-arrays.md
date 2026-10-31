# Indexed arrays

The shell stores a scalar or a sparse indexed array in one binding map. Scalar reads select element zero. Indexed arrays do not enter child-process environments.

Supported assignments include dense compound lists, individual numeric subscripts, negative subscripts relative to the highest index, and `+=`. Compound words use the existing field-expansion path. A scalar assignment to an existing array changes only element zero. Compound replacement clears the previous elements. Compound append starts after the highest index. Element assignment expands its right-hand side before evaluating the subscript. An invalid negative assignment ends the read unit with status 1. Relative reads work when the highest index is the largest signed 64-bit value.

Direct element expansion, `[@]`, `[*]`, element counts, and element lengths use the same binding. Quoted `[@]` preserves separate fields and empty elements. Quoted `[*]` joins with the first scalar IFS character. Array-valued IFS disables field splitting, including when the array is empty. Raw-byte star-join behavior for array-valued IFS remains outside this UTF-8 representation. Sparse traversal follows ascending numeric indices. Indexed `PIPESTATUS` lengths read the pipeline-status producer rather than the ordinary binding map. Checked negative indices are relative to the producer length; invalid negative indices report status 1. Missing positive elements still have length zero under nounset.

## Slices

`${a[@]:offset:length}` and `${a[*]:offset:length}` select a sparse numeric start and then count present elements. Omitted length selects all remaining elements. Negative offsets count back from one past the highest index. Negative lengths fail with status 1. Empty sources skip both arithmetic expressions. Starts beyond the highest index skip the length expression. Bounds share arithmetic side effects and cancellation with other expansions.

Quoted `[@]` keeps separate fields, including empty elements. Quoted `[*]` joins with IFS. Scalar bindings use text slicing even when referenced as `[@]` or `[*]`. `PIPESTATUS` slices read its existing producer. The read-only adapter admits only selected values before copying them and never clones the indexed map. It adds no durable producer publication API.

## Storage and restoration

`state/binding.rs` defines `Binding::Scalar` and `Binding::Indexed`. Indexed bindings hold an `Rc` of an ordered sparse map with cached string capacities and value lengths. State is the sole mutation owner. A unique indexed write replaces one element or appends staged entries in place. A genuinely shared tree pays full copy admission before copy-on-write. Subshell snapshots, local bindings and builtin prefixes retain complete bindings, not just element zero. Readonly checks remain in state.

`interpreter/indexed.rs` stages fallible operand expansion, subscript evaluation, cooperative work and storage admission before each synchronous commit through `PrefixFrame::commit_update`. `BindingUpdate` describes replacement, element and append operations without retaining another copy of the live array. Local storage tickets admit retained growth before mutation.

Assignment-only commands commit completed assignments one at a time. `AssignmentFrame` keeps a session-budgeted inverse journal for resource rejection and cancellation. Unique arrays retain only the changed element or appended range. Ordinary semantic errors preserve earlier completed assignments. Resource rejection or interruption reverses them. Parameter-assignment effects produced during later RHS expansion update matching inverses, so those durable effects survive rollback. State clones and isolated snapshots exclude the caller's journal. The journal admits vector reallocation and retained inverse values to its own session reservation before allocation. A durable write during the command may shrink a local's ticket to its live value. Reversal therefore moves the journal's reservation into the locals it restores and only shrinks afterwards: it never asks the shared budget for growth, which another owner may have taken meanwhile. Temporary command prefixes keep their independent rollback behavior. After getopts integration, OPTIND updates also refresh its hidden option cursor. Resource/cancellation rollback restores the prior cluster position, while durable RHS resets update the saved cursor. Getopts aggregate preflight uses the same indexed-local sizing as publication, including absent element zero and repeated aliases. It reserves publication growth before committing the scanner cursor.

## Node accounting

The node bound uses Rust 1.98.1 commit `48a229ceaefd4985c50990b14116b6d856af0985`, `library/alloc/src/collections/btree/node.rs`. Its B-tree has capacity 11 and at least five entries in each nonroot node. For `n > 0`, nodes are at most `1 + floor((n - 1) / 5)` and internal nodes at most `floor((nodes + 3) / 6)`. Charge each aligned leaf layout plus twelve child pointers for each possible internal node, then add string capacities separately. This bounds requested allocation layouts, not allocator bookkeeping or RSS, consistent with existing command storage admission. Empty maps retain no allocated leaf.

On the pinned native compiler, leaves request 368 bytes and internal nodes 464 bytes. An allocation-counting probe observed 635,936 requested bytes for 10,000 entries against a 767,968-byte bound. Limits and gates are unchanged. Default-limit regressions cover 5,000 incremental writes, 5,000 appends and a 10,000-element compound assignment.

## Internal producers and remaining forms

Future internal producers can reuse the crate-visible `Indexed` constructors and owned-string storage. Publication requires a separate state-owned admitted producer adapter with its own typed outcome and special-hook policy, not ordinary assignment or prefix rollback. `mapfile` and `readarray` use this boundary to publish each completed record directly into the target array. Producers must admit strings, nodes, keys, cooperative work and retained storage before allocation or mutation. These constructors are not a public package API. This implementation does not define `BASH_REMATCH` publication or produce regex captures.

Explicit compound subscripts such as `a=([5]=value)` and `a+=([5]+=value)` are not implemented. Unquoted syntactic entries reject with status 2 rather than becoming silent literal data. Quoted or escaped spellings remain ordinary elements. Array operators and transformations, indexed `unset`, declaration array flags, associative arrays and arithmetic array lvalues are also outside this bounded implementation. Indexed and append assignments used as temporary command prefixes remain unsupported.

Known gaps remain. A negative out-of-range read returns an empty field without Bash's stderr diagnostic. With `set -u`, an unset array count uses the engine's generic unbound-variable status 127 rather than Bash's status 1. Circular indexed nameref writes report status 1 without Bash's warning or successful status. Indexed `unset` still leaves the element intact. Custom probes of these gaps are not scored failures. They are outside nameref lifecycle and declaration handling.

The implementation is original local code. `sources.lock.json:shellIndexedArrays` records its classification and checks. The [evidence receipt](evidence/indexed-arrays.json) records frozen gains, exact identities and qualification. Explicit-name `declare -p` and `typeset -p` are not supported. Four scored IDs need raw-byte support.

## Interaction with other features

Indexed arrays work with positive extglob, positional and special indirection, scalar transformations and builtin-wrapper dispatch. Pathname/noglob and tilde expansion are not part of this feature. Compound assignment uses `expand::fields`, not admitted argv pathname expansion, so adding pathname expansion needs a separate audit of that caller. Recorded local Bash 5.3.15 controls are in `scripts/fixtures/shell-indexed-integration.json`; native and production-Waffle observations are separate from scored membership.

Scalar transformations reject resolved indexed bindings, including namerefs and empty or sparse arrays, with status 2. The existing nounset read check runs first. An extracted scalar such as `s=${a[0]}` still uses scalar transformations. Boundary observations recorded with local Bash 5.3.15 are in `scripts/fixtures/shell-indexed-transform-boundary.json`; rejection is the guest's deliberate unsupported-family policy, not Bash parity.
