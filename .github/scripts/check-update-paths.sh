#!/usr/bin/env bash
set -euo pipefail
changed_paths() {
  if [[ $# == 0 ]]; then git diff --name-only -z HEAD; return; fi
  while IFS= read -r -d '' entry; do
    entry=${entry#*$'\t'}
    printf '%s\0' "${entry#*$'\t'}"
  done < <(git apply --numstat -z "$1")
}

check_record_type() {
  local path=$1
  local before_mode after_mode
  if [[ ! -f "$path" || -L "$path" ]]; then
    echo "::error::Dependency records must remain regular files: $path" >&2
    return 1
  fi
  read -r before_mode after_mode _ < <(git -c core.filemode=true diff --raw --no-renames HEAD -- "$path")
  if [[ "$before_mode" != ":$after_mode" ]]; then
    echo "::error::Dependency updater changed a record mode: $path" >&2
    return 1
  fi
}

while IFS= read -r -d '' path; do
  case "$path" in
    package.json|package-lock.json|bun.lock|sources.lock.json|shell/engine/Cargo.toml|shell/compat-fixtures/Cargo.toml|shell/Cargo.lock) ;;
    *) echo "::error::Dependency updater changed a forbidden path: $path" >&2; exit 1 ;;
  esac
  if ! git cat-file -e "HEAD:$path"; then
    echo "::error::Dependency updater may only update existing pin records: $path" >&2
    exit 1
  fi
  if [[ $# == 0 ]]; then check_record_type "$path"; fi
done < <(changed_paths "$@")

if [[ $# == 0 ]]; then
  scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/waffle-manifest-validation-XXXXXX")
  trap 'rm -rf "$scratch"' EXIT
  normalize_native_waffle_revisions() {
    sed -E '/^[[:space:]]*waffle-(program-support|coreutils|grep)[[:space:]]*=/{s/(rev = ")[0-9a-f]{40}(")/\1<native-waffle-rev>\2/;}'
  }
  for file in shell/engine/Cargo.toml shell/compat-fixtures/Cargo.toml; do
    [[ -f "$file" ]] || continue
    git show "HEAD:$file" | normalize_native_waffle_revisions > "$scratch/before"
    normalize_native_waffle_revisions < "$file" > "$scratch/after"
    if ! cmp -s "$scratch/before" "$scratch/after"; then
      echo "::error::Dependency updater changed Cargo manifest fields beyond native Waffle revision pins: $file" >&2
      exit 1
    fi
  done
fi
