#!/usr/bin/env bash
# Hosted runners pull apt packages from a regional mirror (Azure or AWS, varying by image)
# that can stall for many minutes. Send apt to the main Ubuntu archive whatever host it is.
set -euo pipefail
for file in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*; do
  [[ -f "$file" ]] || continue
  sudo sed -i -E 's#https?://[a-z0-9.-]+\.archive\.ubuntu\.com/ubuntu#https://archive.ubuntu.com/ubuntu#g' "$file"
done
hosts=$(grep -rhoE 'https?://[a-z0-9.-]*archive\.ubuntu\.com/ubuntu' \
  /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null | sort -u || true)
printf '%s\n' "${hosts:-none found}" | sed 's/^/apt archive host: /'
