#!/usr/bin/env bash
set -euo pipefail

latest_release_tag() {
  gh api "repos/$1/releases?per_page=100" --paginate \
    --jq ".[] | select(.draft == false and .prerelease == false) | select(.tag_name | startswith(\"$2\")) | .tag_name" |
    sed -n '1p'
}

tag=$(latest_release_tag ShaulLavo/hotkeys hotkeys-)
url=$(gh api "repos/ShaulLavo/hotkeys/releases/tags/$tag" --jq '.assets[] | select(.name | test("^fregat-hotkeys-[0-9a-f]{40}\\.tgz$")) | .browser_download_url')
test -n "$url"
tmp=$(mktemp)
jq --arg url "$url" '.devDependencies["@fregat/hotkeys"] = $url' package.json > "$tmp"
mv "$tmp" package.json
