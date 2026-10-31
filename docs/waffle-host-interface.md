# Waffle host compatibility

Bash selects the required positive safe integer in `sources.lock.json.waffle.hostInterface`.
Its package metadata declares that integer as `waffleHostInterface` for downstream consumers.
The installed runtime and every installed family must declare the same integer.
Missing values, strings, zero, negatives, fractions, non-finite numbers, unsafe integers,
and mismatches fail before the acceptance checks import family code or the Node build bundles it.

The wildcard `waffle` peer controls package placement only. It proves no compatibility.
The development dependency remains an exact public runtime archive. Every family must resolve
to the same physical runtime, and each package-manager lock must contain exactly one runtime entry.
Published families cannot carry a runtime dependency, optional dependency, or optional peer.

Archive hashes, source revisions, builder and patch hashes, program derivations, producer receipts,
and guest hashes remain separate integrity checks. The schema-2 program release manifest has its
own exact byte length and SHA-256 pin. Installed acceptance checks every admitted artifact,
including derivation receipts, before imports. Python and Git imports do not prove execution.

A runtime update with the same host integer does not require a family release or a change to the
family's historical runtime record. The updater validates candidate metadata before selecting it
and moves `waffle-program-support`, `waffle-coreutils`, and `waffle-grep` together to the runtime
source. Their native composition needs one support-crate identity. Other Cargo pins stay unchanged.
There is no version-derived compatibility, legacy metadata fallback, or interface negotiation.

`npm run test:guest-build` exercises malformed metadata, duplicate runtimes, changed artifacts,
changed receipts, dependency preservation, and same-interface runtime updates.
`npm run test:installed-waffle` checks the actual installed public release pair and imports it.
