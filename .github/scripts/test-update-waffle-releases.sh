#!/usr/bin/env bash
set -euo pipefail

script_root=$(cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/waffle-updater-test-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
real_git=$(command -v git)
old_revision=a9af70fabd5ea2f0f7e7730a36ca00ff6697d9ee
program_revision=3050f69d810fe7c851e487135517698b5dfd93e5
runtime_revision=8d6f3c4a2b19087766554433221100ffeeddccbb
runtime_direct_revision=1234567890abcdef1234567890abcdef12345678

write_fixture() {
  local root=$1 runtime_version=$2 program_version=$3
  mkdir -p "$root/scripts" "$root/bin" "$root/.github/scripts" "$root/shell/engine" "$root/shell/compat-fixtures"
  cp "$script_root/../../scripts/"{check-waffle-release,installed-waffle,waffle-host-interface}.ts "$root/scripts/"
  cp "$script_root/update-waffle-releases.sh" "$root/.github/scripts/"
  cp "$script_root/check-update-paths.sh" "$root/.github/scripts/"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n' > "$root/.github/scripts/update-hotkeys.sh"
  chmod +x "$root/.github/scripts"/*.sh
  cat > "$root/package.json" <<JSON
{
  "type": "module",
  "waffleHostInterface": 1,
  "dependencies": {
    "waffle-base": "https://github.com/ShaulLavo/waffle/releases/download/programs-v${program_version}/waffle-base-${program_version}.tgz"
  },
  "devDependencies": {
    "waffle": "https://github.com/ShaulLavo/waffle/releases/download/waffle-v${runtime_version}/waffle-${runtime_version}.tgz"
  },
  "peerDependencies": {
    "waffle": "*"
  },
  "allowScripts": {
    "waffle@${runtime_version}": true
  }
}
JSON
  printf '{}\n' > "$root/package-lock.json"
  printf '{}\n' > "$root/bun.lock"
  cat > "$root/sources.lock.json" <<JSON
{
  "waffle": {
    "hostInterface": 1,
    "version": "${runtime_version}",
    "revision": "${runtime_direct_revision}",
    "specifier": "https://github.com/ShaulLavo/waffle/releases/download/waffle-v${runtime_version}/waffle-${runtime_version}.tgz",
    "archiveSha256": "archive",
    "buildInputs": {
      "builderSha256": "builder",
      "patchSha256": "patch"
    }
  },
  "wafflePrograms": {
    "version": "${program_version}",
    "revision": "${program_revision}",
    "provenance": "historical receipts"
  },
  "wasiLibc": {
    "patchPath": "waffle-inputs/${runtime_direct_revision}/patch",
    "builder": "waffle-inputs/${runtime_direct_revision}/builder"
  }
}
JSON
  cat > "$root/shell/engine/Cargo.toml" <<EOF_ENGINE
[dependencies]
waffle-program-support = { git = "https://github.com/ShaulLavo/waffle", rev = "${old_revision}", features = [
  "cooperative-wasi",
] }

[dev-dependencies]
waffle-program-support = { git = "https://github.com/ShaulLavo/waffle", rev = "${old_revision}", features = [
  "stack-observation",
] }
EOF_ENGINE
  cat > "$root/shell/compat-fixtures/Cargo.toml" <<EOF_COMPAT
[dependencies]
waffle-program-support = { git = "https://github.com/ShaulLavo/waffle", rev = "${old_revision}" }
waffle-coreutils = { git = "https://github.com/ShaulLavo/waffle", rev = "${old_revision}" }
waffle-grep = { git = "https://github.com/ShaulLavo/waffle", rev = "${old_revision}" }
EOF_COMPAT
  cat > "$root/shell/Cargo.lock" <<EOF_LOCK
[[package]]
name = "waffle-program-support"
source = "git+https://github.com/ShaulLavo/waffle?rev=${old_revision}#${old_revision}"

[[package]]
name = "waffle-coreutils"
source = "git+https://github.com/ShaulLavo/waffle?rev=${old_revision}#${old_revision}"
EOF_LOCK
  "$real_git" -C "$root" init -q -b main
  "$real_git" -C "$root" config user.name fixture
  "$real_git" -C "$root" config user.email fixture@example.com
  "$real_git" -C "$root" add .
  "$real_git" -C "$root" commit -qm base
}

write_stubs() {
  local root=$1
  cat > "$root/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'releases?per_page=100'*waffle-v*) printf '%s\n' "waffle-v${RELEASE_RUNTIME}" ;;
  *'releases?per_page=100'*programs-v*) printf '%s\n' "programs-v${RELEASE_PROGRAM}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
GH
  cat > "$root/bin/git" <<'GIT'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != ls-remote ]]; then
  exec "$REAL_GIT" "$@"
fi
tag=${*: -1}
tag=${tag#refs/tags/}
tag=${tag%\^\{\}}
if [[ "$*" == *'programs-v'* ]]; then
  printf '%s\trefs/tags/%s\n' "${PROGRAM_TAG_OBJECT}" "$tag"
  printf '%s\trefs/tags/%s^{}\n' "${PROGRAM_SOURCE_REVISION}" "$tag"
  exit 0
fi
case "$GIT_REF_MODE" in
  failed) echo 'fixture: remote lookup failed' >&2; exit 1 ;;
  partial)
    printf '%s\trefs/tags/%s\n' "${RUNTIME_DIRECT_REVISION}" "$tag"
    echo 'fixture: remote lookup failed after partial output' >&2
    exit 1
    ;;
  missing) exit 0 ;;
  invalid) printf 'invalid-revision\trefs/tags/%s\n' "$tag" ;;
  invalid-peeled)
    printf '%s\trefs/tags/%s\n' "${RUNTIME_TAG_OBJECT}" "$tag"
    printf 'invalid-revision\trefs/tags/%s^{}\n' "$tag"
    ;;
  annotated)
    printf '%s\trefs/tags/%s\n' "${RUNTIME_TAG_OBJECT}" "$tag"
    if [[ "$#" -ge 4 ]]; then
      printf '%s\trefs/tags/%s^{}\n' "${RUNTIME_SOURCE_REVISION}" "$tag"
    fi
    ;;
  direct) printf '%s\trefs/tags/%s\n' "${RUNTIME_DIRECT_REVISION}" "$tag" ;;
  *) echo "unexpected Git ref mode: $GIT_REF_MODE" >&2; exit 1 ;;
esac
GIT
  cat > "$root/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
url=${*: -1}
case "$url" in
  */waffle-*.tgz)
    mkdir -p "$TEST_ROOT/runtime-archive/package"
    printf '{"name":"waffle","version":"%s","waffleHostInterface":%s}\n' "$RELEASE_RUNTIME" "${RUNTIME_INTERFACE:-1}" > "$TEST_ROOT/runtime-archive/package/package.json"
    tar -czf - -C "$TEST_ROOT/runtime-archive" package
    ;;
  */program-release.json)
    printf '{"schema":"waffle-program-release/2","version":"%s","sourceCommit":"%s","tagState":"tagged","dirty":false,"runtime":{"waffleHostInterface":1},"packages":[{"waffleHostInterface":1}]}\n' "$RELEASE_PROGRAM" "$PROGRAM_SOURCE_REVISION"
    ;;
  *) printf 'fixture bytes\n' ;;
esac
CURL
  cat > "$root/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_ROOT/cargo-calls"
if [[ "$*" == *'update --manifest-path shell/Cargo.toml -p git+https://github.com/ShaulLavo/waffle?rev='*'#waffle-program-support' ]]; then
  cat >> shell/Cargo.lock <<EOF

[[package]]
name = "waffle-program-support"
source = "git+https://github.com/ShaulLavo/waffle?rev=${RUNTIME_SOURCE_REVISION}#${RUNTIME_SOURCE_REVISION}"
EOF
fi
CARGO
  cat > "$root/bin/npm" <<'NPM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_ROOT/npm-calls"
NPM
  cat > "$root/bin/bun" <<'BUN'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_ROOT/bun-calls"
BUN
  chmod +x "$root/bin"/*
}

run_updater() {
  local root=$1
  (
    cd "$root"
    export PATH="$root/bin:$PATH"
    export REAL_GIT="$real_git"
    export TEST_ROOT="$root"
    export RELEASE_RUNTIME RELEASE_PROGRAM GIT_REF_MODE
    export RUNTIME_TAG_OBJECT=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    if [[ "$GIT_REF_MODE" == annotated ]]; then
      export RUNTIME_SOURCE_REVISION="$runtime_revision"
    else
      export RUNTIME_SOURCE_REVISION="$runtime_direct_revision"
    fi
    export RUNTIME_DIRECT_REVISION="$runtime_direct_revision"
    export PROGRAM_TAG_OBJECT=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    export PROGRAM_SOURCE_REVISION="$program_revision"
    export OLD_REVISION="$old_revision"
    bash .github/scripts/update-waffle-releases.sh
  )
}

assert_support_revision() {
  local root=$1 revision=$2
  test "$(rg -c "waffle-program-support.*rev = \"${revision}\"" "$root/shell/engine/Cargo.toml")" = 2
  test "$(rg -c 'waffle-program-support.*rev =' "$root/shell/engine/Cargo.toml")" = 2
  rg -q "waffle-program-support.*rev = \"${revision}\"" "$root/shell/compat-fixtures/Cargo.toml"
  rg -q "name = \"waffle-program-support\"" "$root/shell/Cargo.lock"
  rg -q "rev=${revision}#${revision}" "$root/shell/Cargo.lock"
}

assert_common_calls() {
  local root=$1
  grep -Fxq "update --manifest-path shell/Cargo.toml -p git+https://github.com/ShaulLavo/waffle?rev=${old_revision}#waffle-program-support" "$root/cargo-calls"
  grep -Fxq -- 'install --package-lock-only --ignore-scripts --force' "$root/npm-calls"
  grep -Fxq -- 'install --lockfile-only --ignore-scripts' "$root/bun-calls"
}

run_pair_fixture() {
  local mode=$1 runtime=$2
  local root="$scratch/pair-${mode}"
  write_fixture "$root" 0.0.105 0.0.13
  write_stubs "$root"
  RELEASE_RUNTIME="$runtime" RELEASE_PROGRAM=0.0.14 GIT_REF_MODE="$mode" run_updater "$root"
  assert_support_revision "$root" "$([[ "$mode" == annotated ]] && printf '%s' "$runtime_revision" || printf '%s' "$runtime_direct_revision")"
  test "$(jq -r '.wafflePrograms.revision' "$root/sources.lock.json")" = "$program_revision"
  test "$(jq -r '.dependencies["waffle-base"]' "$root/package.json")" = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.14/waffle-base-0.0.14.tgz"
  test "$(rg -c "waffle-coreutils.*${old_revision}" "$root/shell/compat-fixtures/Cargo.toml")" = 1
  (cd "$root" && bash .github/scripts/check-update-paths.sh)
  assert_common_calls "$root"
  before=$($real_git -C "$root" diff)
  RELEASE_RUNTIME="$runtime" RELEASE_PROGRAM=0.0.14 GIT_REF_MODE="$mode" run_updater "$root"
  after=$($real_git -C "$root" diff)
  test "$before" = "$after"
  test "$(wc -l < "$root/cargo-calls")" = 1
}

run_no_runtime_fixture() {
  local root="$scratch/no-runtime"
  write_fixture "$root" 0.0.105 0.0.13
  write_stubs "$root"
  RELEASE_RUNTIME=0.0.105 RELEASE_PROGRAM=0.0.14 GIT_REF_MODE=annotated run_updater "$root"
  test "$(rg -c "waffle-program-support.*${old_revision}" "$root/shell/engine/Cargo.toml")" = 2
  test "$(rg -c "waffle-program-support.*${old_revision}" "$root/shell/compat-fixtures/Cargo.toml")" = 1
  rg -q "rev=${old_revision}#${old_revision}" "$root/shell/Cargo.lock"
  test "$(jq -r '.wafflePrograms.revision' "$root/sources.lock.json")" = "$program_revision"
  test "$(jq -r '.dependencies["waffle-base"]' "$root/package.json")" = "https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.14/waffle-base-0.0.14.tgz"
  test ! -s "$root/cargo-calls"
  (cd "$root" && bash .github/scripts/check-update-paths.sh)
  cp "$root/package.json" "$root/package.json.before-repeat"
  RELEASE_RUNTIME=0.0.105 RELEASE_PROGRAM=0.0.14 GIT_REF_MODE=annotated run_updater "$root"
  cmp "$root/package.json.before-repeat" "$root/package.json"
  test ! -s "$root/cargo-calls"
}

run_guard_negative_fixture() {
  local root="$scratch/guard"
  write_fixture "$root" 0.0.105 0.0.13
  printf '%s\n' 'unrelated change' >> "$root/shell/engine/Cargo.toml"
  if (cd "$root" && bash .github/scripts/check-update-paths.sh > "$root/guard.log" 2>&1); then
    echo 'FAIL: unrelated engine manifest change passed the updater guard' >&2
    exit 1
  fi
  grep -q 'beyond waffle-program-support revision pins' "$root/guard.log"
}

run_bad_ref_fixture() {
  local mode=$1 root="$scratch/bad-ref-$1"
  write_fixture "$root" 0.0.105 0.0.13
  write_stubs "$root"
  if RELEASE_RUNTIME=0.0.106 RELEASE_PROGRAM=0.0.14 GIT_REF_MODE="$mode" run_updater "$root" > "$root/updater.log" 2>&1; then
    echo "FAIL: ${mode} runtime lookup passed the updater" >&2
    exit 1
  fi
  "$real_git" -C "$root" diff --exit-code
  test ! -s "$root/cargo-calls"
  test ! -s "$root/npm-calls"
  test ! -s "$root/bun-calls"
}

run_bad_ref_fixture partial
run_bad_ref_fixture failed
run_bad_ref_fixture missing
run_bad_ref_fixture invalid
run_bad_ref_fixture invalid-peeled
run_pair_fixture annotated 0.0.106
run_pair_fixture direct 0.0.107
run_runtime_only_fixture() {
  local root="$scratch/runtime-only"
  write_fixture "$root" 0.0.107 0.0.15
  write_stubs "$root"
  RELEASE_RUNTIME=0.0.108 RELEASE_PROGRAM=0.0.15 GIT_REF_MODE=annotated run_updater "$root"
  test "$(jq -r '.peerDependencies.waffle' "$root/package.json")" = '*'
  test "$(jq -r '.dependencies["waffle-base"]' "$root/package.json")" = 'https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.15/waffle-base-0.0.15.tgz'
  assert_support_revision "$root" "$runtime_revision"
}
run_runtime_only_fixture
run_incompatible_runtime_fixture() {
  local root="$scratch/incompatible-runtime"
  write_fixture "$root" 0.0.107 0.0.15
  write_stubs "$root"
  if RUNTIME_INTERFACE=2 RELEASE_RUNTIME=0.0.108 RELEASE_PROGRAM=0.0.15 GIT_REF_MODE=annotated run_updater "$root" > "$root/guard.log" 2>&1; then
    echo 'FAIL: incompatible runtime passed' >&2
    exit 1
  fi
  grep -q 'host interface mismatch' "$root/guard.log"
  "$real_git" -C "$root" diff --exit-code
}
run_incompatible_runtime_fixture
run_no_runtime_fixture
run_guard_negative_fixture
printf '%s\n' 'Waffle updater fixtures passed: peeled and lightweight refs, runtime-owned support, no-runtime preservation, repeat stability, narrow manifest guards, and rejected failed/missing/invalid refs.'
