#!/usr/bin/env bash
set -euo pipefail

runtime_updated=false
runtime_source_revision=''
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/waffle-release-update-XXXXXX")
trap 'rm -rf "$scratch"' EXIT

latest_release_tag() {
  local repository=$1
  local prefix=$2
  gh api "repos/${repository}/releases?per_page=100" --paginate \
    --jq ".[] | select(.draft == false and .prerelease == false) | select(.tag_name | startswith(\"${prefix}\")) | .tag_name" |
    sed -n '1p'
}

release_source_revision() {
  local repository=$1
  local tag=$2
  local direct_ref="refs/tags/${tag}"
  local peeled_ref="${direct_ref}^{}"
  local refs direct=''
  refs=$(git ls-remote "$repository" "$peeled_ref" "$direct_ref") || return
  while IFS=$'\t' read -r revision ref; do
    [[ -n "$revision" && -n "$ref" ]] || continue
    if [[ "$ref" == "$peeled_ref" ]]; then
      [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || return 1
      printf '%s\n' "$revision"
      return
    fi
    if [[ "$ref" == "$direct_ref" ]]; then
      direct=$revision
    fi
  done <<< "$refs"
  [[ "$direct" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$direct"
}

update_runtime() {
  local tag version current_version revision specifier archive_sha builder_sha patch_sha tmp
  tag=$(latest_release_tag ShaulLavo/waffle waffle-v)
  version=${tag#waffle-v}
  current_version=$(jq -r '.waffle.version' sources.lock.json)
  if [[ "$version" == "$current_version" ]]; then
    return
  fi

  revision=$(release_source_revision https://github.com/ShaulLavo/waffle.git "$tag") || return
  specifier="https://github.com/ShaulLavo/waffle/releases/download/${tag}/waffle-${version}.tgz"
  curl --fail --location --silent --show-error "$specifier" > "$scratch/runtime.tgz"
  node scripts/check-waffle-release.ts runtime "$scratch/runtime.tgz" "$version"
  archive_sha=$(sha256sum "$scratch/runtime.tgz" | cut -d ' ' -f 1)
  builder_sha=$(curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/ShaulLavo/waffle/${revision}/packages/waffle/scripts/build-wasi-libc.sh" |
    sha256sum | cut -d ' ' -f 1)
  patch_sha=$(curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/ShaulLavo/waffle/${revision}/packages/waffle/patches/wasi-libc/preopen-scan.patch" |
    sha256sum | cut -d ' ' -f 1)

  sed -i "s|$(jq -r '.waffle.specifier' sources.lock.json)|${specifier}|g" package.json
  tmp=$(mktemp)
  jq --arg version "$version" --arg revision "$revision" \
    --arg specifier "$specifier" --arg archive_sha "$archive_sha" --arg builder_sha "$builder_sha" \
    --arg patch_sha "$patch_sha" \
    '.waffle.version = $version
     | .waffle.revision = $revision
     | .waffle.specifier = $specifier
     | .waffle.archiveSha256 = $archive_sha
     | .waffle.buildInputs.builderSha256 = $builder_sha
     | .waffle.buildInputs.patchSha256 = $patch_sha
     | .wasiLibc.patchPath |= sub("waffle-inputs/[0-9a-f]{40}/"; "waffle-inputs/" + $revision + "/")
     | .wasiLibc.builder |= sub("waffle-inputs/[0-9a-f]{40}/"; "waffle-inputs/" + $revision + "/")' \
    sources.lock.json > "$tmp"
  mv "$tmp" sources.lock.json
  runtime_updated=true
  runtime_source_revision=$revision
}

update_programs() {
  local current_tag tag version current_version
  current_tag=$(grep -oE 'programs-v[0-9]+\.[0-9]+\.[0-9]+' package.json | sed -n '1p' || true)
  [[ -n "$current_tag" ]] || return 0
  tag=$(latest_release_tag ShaulLavo/waffle programs-v)
  version=${tag#programs-v}
  current_version=${current_tag#programs-v}
  [[ "$version" == "$current_version" ]] && return 0
  local manifest_url manifest_sha manifest_bytes tmp
  manifest_url="https://github.com/ShaulLavo/waffle/releases/download/${tag}/program-release.json"
  curl --fail --location --silent --show-error "$manifest_url" > "$scratch/program-release.json"
  node scripts/check-waffle-release.ts programs "$scratch/program-release.json" "$version"
  manifest_sha=$(sha256sum "$scratch/program-release.json" | cut -d ' ' -f 1)
  manifest_bytes=$(wc -c < "$scratch/program-release.json")
  tmp=$(mktemp)
  jq --arg url "$manifest_url" --arg sha256 "$manifest_sha" --argjson bytes "$manifest_bytes" \
    --slurpfile release "$scratch/program-release.json" \
    '.wafflePrograms.version = $release[0].version
     | .wafflePrograms.revision = $release[0].sourceCommit
     | .wafflePrograms.releaseManifest = {url: $url, bytes: $bytes, sha256: $sha256}' sources.lock.json > "$tmp"
  mv "$tmp" sources.lock.json
  sed -E -i "s|programs-v${current_version}|${tag}|g; s|(waffle-[[:alnum:]-]+-)${current_version}(\.tgz)|\1${version}\2|g" package.json
}

update_program_support() {
  [[ "$runtime_updated" == true ]] || return 0
  local manifest
  for manifest in shell/engine/Cargo.toml shell/compat-fixtures/Cargo.toml; do
    sed -E -i "/^[[:space:]]*waffle-program-support[[:space:]]*=/{s|(rev = \")[0-9a-f]{40}(\".*)|\\1${runtime_source_revision}\\2|;}" "$manifest"
  done
  if ! git diff --quiet -- shell/engine/Cargo.toml shell/compat-fixtures/Cargo.toml; then
    cargo update --manifest-path shell/Cargo.toml -p waffle-program-support
  fi
}

update_runtime
update_programs
bash .github/scripts/update-hotkeys.sh
update_program_support
# Move the version-specific script grant with the runtime pin.
tmp=$(mktemp)
jq --arg version "$(jq -r '.waffle.version' sources.lock.json)"   '.allowScripts |= with_entries(if (.key | startswith("waffle@")) then .key = ("waffle@" + $version) else . end)' package.json > "$tmp"
mv "$tmp" package.json
npm install --package-lock-only --ignore-scripts --force
bun install --lockfile-only --ignore-scripts
