#!/usr/bin/env bash
set -euo pipefail
changed_paths() {
  if [[ $# == 0 ]]; then git diff --name-only -z HEAD; return; fi
  while IFS= read -r -d '' entry; do
    entry=${entry#*$'\t'}
    printf '%s\0' "${entry#*$'\t'}"
  done < <(git apply --numstat -z "$1")
}

while IFS= read -r -d '' path; do
  case "$path" in
    package.json|package-lock.json|bun.lock|sources.lock.json|shell/compat-fixtures/Cargo.toml|shell/Cargo.lock) ;;
    *) echo "::error::Dependency updater changed a forbidden path: $path" >&2; exit 1 ;;
  esac
done < <(changed_paths "$@")
