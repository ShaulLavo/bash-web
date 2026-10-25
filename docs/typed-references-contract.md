# Typed references, step 1

Approved for bounded Step 1 implementation after parent review on 2026-10-24.
Scope: indexed references through namerefs, arithmetic, `unset` and `test -v`.
Attributes, associative arrays and input-array builtins follow separately.

## Caller behavior

```sh
arr=(zero one two); declare -n ref='arr[2]'
echo "$ref"                       # two
ref=changed                       # writes arr[2], not ref's target text
ref=41; ((ref++))                 # numeric writes use the same selected element
unset ref                         # removes that element, not its siblings
[[ -v arr[2] ]]                   # false after removal; empty-but-set is true
```

The unchanged scalar case and
`declare -n ref=arr; unset 'ref[2]'` remain supported. Reference lookup follows
current dynamic scope; a declaration does not capture a local that later exits.
`unset -n` addresses the reference itself. Whole-variable unset keeps the existing
current-local shadow versus calling-local reveal distinction. Element removal
keeps the array, its other elements and declaration attributes.

Presence on a bare name keeps the frozen scalar-name policy, including namerefs
whose target text contains brackets. Explicit element predicates select that
slot; an out-of-range negative slot is false, not a fatal expansion error.
Element unset supports numeric selectors, arithmetic expressions and bound index
variables. An unbound bare key remains outside that removal adapter and is a
no-op. This preserves the frozen cases that continue after unsupported
`declare -A` without introducing associative storage. Indexed assignment and
arithmetic retain their existing unbound-variable-as-zero behavior.

## Minimal contract

```rust
struct Reference<'a> { name: &'a str, subscript: Option<&'a str> }
struct Place { owner: ScopeOwner, selector: Selector }
enum Selector { Scalar, Indexed(i64) }
// Feature-layer operations, all borrowing the original command context:
async fn read(reference: Reference<'_>, context: &mut Context) -> Result<Value, Error>;
async fn assign(assignment: &Assignment, context: &mut Context) -> Result<(), Error>;
async fn remove(reference: Reference<'_>, context: &mut Context) -> Result<bool, Error>;
async fn is_set(reference: Reference<'_>, context: &mut Context) -> Result<bool, Error>;
```

Names above describe responsibilities, not new public crate APIs. Arithmetic
obtains a typed place at its actual lvalue-evaluation phase, reads its numeric
value where needed, and writes that place without storage re-parsing its spelling.
A place carries an admitted owned name, scope/incarnation identity and evaluated
selector, never a borrow or retained array `Rc`. Parsing nameref/builtin operands
is shared; existing assignment ASTs do not take a string-parse round trip.
Resolution is separate from selector execution. State owns lookup, storage and
restoration; feature code owns arithmetic and expansion. State must not import
arithmetic. Reject cycles, excess depth and invalid selectors distinctly.

## Evaluation and effects

- Preserve shell indexed assignment's RHS-before-explicit-subscript ordering.
  Nameref subscript syntax is retained, not executed at declaration time.
- Preserve arithmetic compound old-value-before-RHS, plain assignment's unused
  old-value suppression, pre/postincrement results and inactive-branch laziness.
  Do not impose one universal subscript evaluation count across operations.
  An operation's recipe owns each evaluation occurrence; storage never repeats it.
- `unset` and presence checks share syntax/resolution, not assignment side effects.
  Negative indices normalize against the selected destination at the right phase.
  Presence distinguishes missing elements from set empty strings without creating
  bindings. Readonly checks apply to the actual owner; deleting a reference and
  writing through it are different operations.
- After RHS code or a yield, recheck owner identity and write constraints without
  silently re-running a selector. No State borrow crosses an await.
- Pre-admit text, reference work, copies, local/prefix saves, inverse amendments,
  diagnostics and successor-prefix capacity through the original Work. Publish
  synchronously with no fallible step left. Keep resource refusal, cancellation
  and ordinary language errors distinct; do not map them all to readonly.
- Completed RHS writes/removals amend the compatible saved-prefix and earlier
  inverse images by owner and chronology. Replacement/scope boundaries remain.
  Resource/cancel rollback restores reversible prefixes, not completed RHS effects.
  Ordinary semantic failure retains already-completed language effects.

## Ownership boundary

Independent copies use admitted `State::snapshot`; value-level public State Clone
cannot remain an uncharged deep-copy escape. Handle cloning still shares one
shell. Resolve this API change in step 1, not through an infallible clone fallback.
Prefix backing capacity has a State-lifetime outside allocation ticket; pop does
not refund retained capacity. Admit old-plus-new overlap before growth, using a
known capacity rather than paying unexpected Vec overcapacity after allocation.
Prepare allocation-free restoration before publication. Retained readers require
an admitted detached candidate where a small inverse would otherwise allocate on
Drop. Payload/allocation destruction precedes final execution-charge refund;
a ticket inside an Rc payload does not cover final control-block deallocation.
No CPU refunds, limit changes or accounting waivers. These requirements do not
approve a whole-State rewrite or the earlier broad owned-image design.

## First executable checkpoint

`shell/engine/tests/typed_references.rs` uses saved expected outputs from existing
frozen evidence: Brush `nameref:16`, `:18`, `:29`; Bashkit
`arith-array-lvalue:3`, `:33`; Oils `array:672`, `:700`. The Oils `nameref:39`
scope control splits local declaration from array assignment, avoiding a separate
compound-declaration prerequisite. A scalar control protects old-value ordering.
The draft intentionally exposes failures without ignores or baseline edits.
Selector side effects, readonly, retained readers, snapshots, nested prefix
rollback, admission/cancel and final-drop charges must be covered before landing.
No fresh oracle or gains are claimed by this checkpoint.
