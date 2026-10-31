#!/usr/bin/env bash
set -euo pipefail

latest_release_tag() {
  local repository=$1
  local prefix=$2
  gh api "repos/${repository}/releases?per_page=100" --paginate \
    --jq ".[] | select(.draft == false and .prerelease == false) | select(.tag_name | startswith(\"${prefix}\")) | .tag_name" |
    sed -n '1p'
}

update_runtime() {
  local tag version current_version revision specifier archive_sha builder_sha patch_sha tmp
  tag=$(latest_release_tag ShaulLavo/waffle waffle-v)
  version=${tag#waffle-v}
  current_version=$(jq -r '.waffle.version' sources.lock.json)
  if [[ "$version" == "$current_version" ]]; then
    return
  fi

  revision=$(git ls-remote https://github.com/ShaulLavo/waffle.git "refs/tags/${tag}" | awk '{print $1}')
  test "$revision" != ""
  specifier="https://github.com/ShaulLavo/waffle/releases/download/${tag}/waffle-${version}.tgz"
  archive_sha=$(curl --fail --location --silent --show-error "$specifier" | sha256sum | cut -d ' ' -f 1)
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
}

update_programs() {
  local current_tag tag version current_version
  current_tag=$(grep -oE 'programs-v[0-9]+\.[0-9]+\.[0-9]+' package.json | sed -n '1p' || true)
  [[ -n "$current_tag" ]] || return 0
  tag=$(latest_release_tag ShaulLavo/waffle programs-v)
  version=${tag#programs-v}
  current_version=${current_tag#programs-v}
  [[ "$version" == "$current_version" ]] && return 0
  sed -E -i "s|programs-v${current_version}|${tag}|g; s|(waffle-[[:alnum:]-]+-)${current_version}(\.tgz)|\1${version}\2|g" package.json
}

update_runtime
update_programs
bash .github/scripts/update-hotkeys.sh
program_tag=$(latest_release_tag ShaulLavo/waffle programs-v)
program_revision=$(git ls-remote https://github.com/ShaulLavo/waffle.git "refs/tags/${program_tag}^{}" "refs/tags/${program_tag}" | tail -n 1 | cut -f1)
[[ "$program_revision" =~ ^[0-9a-f]{40}$ ]]
sed -E -i "s|(rev = \")[0-9a-f]{40}(\".*)|\\1${program_revision}\\2|g" shell/compat-fixtures/Cargo.toml
if ! git diff --quiet -- shell/compat-fixtures/Cargo.toml; then
  cargo update --manifest-path shell/Cargo.toml -p waffle-program-support
fi
# Move the version-specific script grant with the runtime pin.
tmp=$(mktemp)
jq --arg version "$(jq -r '.waffle.version' sources.lock.json)"   '.allowScripts |= with_entries(if (.key | startswith("waffle@")) then .key = ("waffle@" + $version) else . end)' package.json > "$tmp"
mv "$tmp" package.json
npm install --package-lock-only --ignore-scripts --force
bun install --lockfile-only --ignore-scripts
