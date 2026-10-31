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
  mkdir -p "$root/bin" "$root/.github/scripts" "$root/shell/engine" "$root/shell/compat-fixtures"
  cp "$script_root/update-waffle-releases.sh" "$root/.github/scripts/"
  cp "$script_root/check-update-paths.sh" "$root/.github/scripts/"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n' > "$root/.github/scripts/update-hotkeys.sh"
  chmod +x "$root/.github/scripts"/*.sh
  cat > "$root/package.json" <<JSON
{
  "dependencies": {
    "waffle-base": "https://github.com/ShaulLavo/waffle/releases/download/programs-v${program_version}/waffle-base-${program_version}.tgz"
  },
  "devDependencies": {
    "waffle": "https://github.com/ShaulLavo/waffle/releases/download/waffle-v${runtime_version}/waffle-${runtime_version}.tgz"
  },
  "peerDependencies": {
    "waffle": "https://github.com/ShaulLavo/waffle/releases/download/waffle-v${runtime_version}/waffle-${runtime_version}.tgz"
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
    "version": "0.0.13",
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
if [[ "$1" == ls-remote ]]; then
  tag=${*: -1}
  tag=${tag#refs/tags/}
  tag=${tag%\^\{\}}
  if [[ "$*" == *'waffle-v'* ]]; then
    if [[ "$GIT_REF_MODE" == annotated ]]; then
      printf '%s\trefs/tags/%s\n' "${RUNTIME_TAG_OBJECT}" "$tag"
      if [[ "$#" -ge 4 ]]; then
        printf '%s\trefs/tags/%s^{}\n' "${RUNTIME_SOURCE_REVISION}" "$tag"
      fi
      exit 0
    fi
    printf '%s\trefs/tags/%s\n' "${RUNTIME_DIRECT_REVISION}" "$tag"
    exit 0
  fi
  if [[ "$*" == *'programs-v'* ]]; then
    printf '%s\trefs/tags/%s\n' "${PROGRAM_TAG_OBJECT}" "$tag"
    printf '%s\trefs/tags/%s^{}\n' "${PROGRAM_SOURCE_REVISION}" "$tag"
    exit 0
  fi
fi
exec "$REAL_GIT" "$@"
GIT
  cat > "$root/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
printf 'fixture bytes\n'
CURL
  cat > "$root/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_ROOT/cargo-calls"
if [[ "$*" == *'update --manifest-path shell/Cargo.toml -p waffle-program-support'* ]]; then
  sed -i "s/${OLD_REVISION}/${RUNTIME_SOURCE_REVISION}/g" shell/Cargo.lock
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
  rg -q "waffle-program-support.*rev = \"${revision}\"" "$root/shell/engine/Cargo.toml"
  test "$(rg -c 'waffle-program-support.*rev =' "$root/shell/engine/Cargo.toml")" = 2
  rg -q "waffle-program-support.*rev = \"${revision}\"" "$root/shell/compat-fixtures/Cargo.toml"
  rg -q "name = \"waffle-program-support\"" "$root/shell/Cargo.lock"
  rg -q "rev=${revision}#${revision}" "$root/shell/Cargo.lock"
}

assert_common_calls() {
  local root=$1
  grep -Fxq 'update --manifest-path shell/Cargo.toml -p waffle-program-support' "$root/cargo-calls"
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

run_pair_fixture annotated 0.0.106
run_pair_fixture direct 0.0.107
run_no_runtime_fixture
run_guard_negative_fixture
printf '%s\n' 'Waffle updater fixtures passed: peeled and lightweight refs, runtime-owned support, no-runtime preservation, repeat stability, and narrow manifest guards.'
