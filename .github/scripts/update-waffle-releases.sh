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
    sort -V | tail -n 1
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

# The runtime is published to npm as @waffle-os/runtime and installed under the `waffle` alias.
update_runtime() {
  local tag version current_version revision specifier tarball archive_sha archive_bytes builder_sha patch_sha tmp
  tag=$(latest_release_tag ShaulLavo/waffle '@waffle-os/runtime@')
  version=${tag#@waffle-os/runtime@}
  current_version=$(jq -r '.waffle.version' sources.lock.json)
  if [[ "$version" == "$current_version" ]]; then
    return
  fi

  revision=$(release_source_revision https://github.com/ShaulLavo/waffle.git "$tag") || return
  specifier="npm:@waffle-os/runtime@${version}"
  tarball="https://registry.npmjs.org/@waffle-os/runtime/-/runtime-${version}.tgz"
  curl --fail --location --silent --show-error "$tarball" > "$scratch/runtime.tgz"
  node scripts/build/check-waffle-release.ts runtime "$scratch/runtime.tgz" "$version"
  archive_sha=$(sha256sum "$scratch/runtime.tgz" | cut -d ' ' -f 1)
  archive_bytes=$(wc -c < "$scratch/runtime.tgz")
  builder_sha=$(curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/ShaulLavo/waffle/${revision}/packages/waffle/scripts/build-wasi-libc.sh" |
    sha256sum | cut -d ' ' -f 1)
  patch_sha=$(curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/ShaulLavo/waffle/${revision}/packages/waffle/patches/wasi-libc/preopen-scan.patch" |
    sha256sum | cut -d ' ' -f 1)

  sed -i "s|$(jq -r '.waffle.specifier' sources.lock.json)|${specifier}|g" package.json
  tmp=$(mktemp)
  jq --arg version "$version" --arg tag "$tag" --arg revision "$revision" \
    --arg specifier "$specifier" --arg tarball "$tarball" --arg archive_sha "$archive_sha" \
    --arg builder_sha "$builder_sha" --arg patch_sha "$patch_sha" --argjson archive_bytes "$archive_bytes" \
    '.waffle.version = $version
     | .waffle.tag = $tag
     | .waffle.revision = $revision
     | .waffle.specifier = $specifier
     | .waffle.tarball = $tarball
     | .waffle.archiveSha256 = $archive_sha
     | .waffle.archiveBytes = $archive_bytes
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
  # A program release without a receipt for the pinned runtime must not block a runtime update
  # in the same run. Leave the program pins as they are and say so; nothing is written before this.
  if ! curl --fail --location --silent --show-error "$manifest_url" > "$scratch/program-release.json" ||
    ! node scripts/build/check-waffle-release.ts programs "$scratch/program-release.json" "$version"; then
    echo "::warning::Skipped Waffle programs ${tag}: its program-release.json is missing or does not match the pinned runtime."
    return 0
  fi
  manifest_sha=$(sha256sum "$scratch/program-release.json" | cut -d ' ' -f 1)
  manifest_bytes=$(wc -c < "$scratch/program-release.json")
  tmp=$(mktemp)
  jq --arg url "$manifest_url" --arg sha256 "$manifest_sha" --argjson bytes "$manifest_bytes" \
    --slurpfile release "$scratch/program-release.json" \
    '.wafflePrograms.version = $release[0].version
     | .wafflePrograms.revision = $release[0].sourceCommit
     | .wafflePrograms.releaseManifest = {url: $url, bytes: $bytes, sha256: $sha256}
     | .wafflePrograms.runtime = ($release[0].runtime | {url, bytes, sha256})' sources.lock.json > "$tmp"
  mv "$tmp" sources.lock.json
  sed -E -i "s|programs-v${current_version}|${tag}|g; s|(waffle-[[:alnum:]-]+-)${current_version}(\.tgz)|\1${version}\2|g" package.json
}

update_native_waffle() {
  [[ "$runtime_updated" == true ]] || return 0
  local manifest previous_revision
  previous_revision=$(sed -nE '/^[[:space:]]*waffle-program-support[[:space:]]*=/{s/.*rev = "([0-9a-f]{40})".*/\1/p;}' shell/engine/Cargo.toml | sed -n '1p')
  [[ "$previous_revision" =~ ^[0-9a-f]{40}$ ]] || return 1
  for manifest in shell/engine/Cargo.toml shell/compat-fixtures/Cargo.toml; do
    sed -E -i "/^[[:space:]]*waffle-(program-support|coreutils)[[:space:]]*=/{s|(rev = \")[0-9a-f]{40}(\".*)|\\1${runtime_source_revision}\\2|;}" "$manifest"
  done
  if ! git diff --quiet -- shell/engine/Cargo.toml shell/compat-fixtures/Cargo.toml; then
    cargo update --manifest-path shell/Cargo.toml -p "git+https://github.com/ShaulLavo/waffle?rev=${previous_revision}#waffle-program-support" \
      -p "git+https://github.com/ShaulLavo/waffle?rev=${previous_revision}#waffle-coreutils"
  fi
}

update_runtime
update_programs
bash .github/scripts/update-hotkeys.sh
update_native_waffle
# Move the version-specific script grant with the runtime pin.
tmp=$(mktemp)
jq --arg version "$(jq -r '.waffle.version' sources.lock.json)"   '.allowScripts |= with_entries(if (.key | startswith("waffle@")) then .key = ("waffle@" + $version) else . end)' package.json > "$tmp"
mv "$tmp" package.json
npm install --package-lock-only --ignore-scripts --force
bun install --lockfile-only --ignore-scripts
