#!/usr/bin/env bash
# Hosted runners pull apt packages from a regional mirror (Azure or AWS, varying by image)
# that can stall for many minutes. Send apt to the main Ubuntu archive whatever host it is.
# Usage: use-main-ubuntu-archive.sh [ROOT]; ROOT (default /) holds etc/apt, for tests.
set -euo pipefail
root=${1:-}
as_root=(sudo)
if [[ -n "$root" ]]; then as_root=(); fi
apt="$root/etc/apt"
for file in "$apt/apt-mirrors.txt" "$apt/sources.list" "$apt"/sources.list.d/*; do
  [[ -f "$file" ]] || continue
  "${as_root[@]}" sed -i -E 's#https?://[a-z0-9.-]+\.archive\.ubuntu\.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' "$file"
done
hosts=$(grep -rhoE 'https?://[a-z0-9.-]*archive\.ubuntu\.com/ubuntu' \
  "$apt/apt-mirrors.txt" "$apt/sources.list" "$apt/sources.list.d" 2>/dev/null | sort -u || true)
printf '%s\n' "${hosts:-none found}" | sed 's/^/apt archive host: /'
