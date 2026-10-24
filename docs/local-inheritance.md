# Scalar local inheritance

Inside a function, `local -I name` creates a local ordinary scalar using its visible caller value. `local -I name+=suffix` appends to that value without changing the caller. An explicit assignment replaces the inherited value. If no outer binding exists, the declaration creates an unset local or uses the supplied assignment.

```bash
v=base
f() { local -I v+=' +more'; printf '%s\n' "$v"; }
f
printf '%s\n' "$v"
```

This prints `base +more`, then `base`.

The local retains the visible export flag and supported case-conversion attribute. `local -Ix name` also marks an unset local as exported. Function-prefix assignments use their existing binding owner and restore the caller on return. Repeating `local -I` on a current local keeps its current value, including an unset value, rather than reloading the saved outer binding. Return, cancellation, and dropped execution observers use normal function-frame cleanup.

## Limits

This is ordinary-scalar support, not general Bash attribute inheritance. Indexed arrays, stack arrays, live dynamic parameters, `OPTIND`, and nameref bindings are rejected with status 2. Combining `-I` with `-n` or case-conversion flags is also rejected. Existing readonly targets reject the operand with status 1 and later ordinary operands still run. This change does not add integer, associative-array, or nameref inheritance.

The frozen GNU Bash 5.3.15 rows for inherited append, exported unset creation, and absent-outer assignment are replayed by `scripts/test-own-shell-local-inherit-I.ts`. Native and default-debug WASI tests cover caller locals, prefix ownership, current-unset locals, case/export restoration, admission failure, cancellation, and refunds. New causal controls are authored contract tests, not new Bash oracle observations. Full compatibility qualification belongs to hosted CI; the frozen baseline is unchanged.
