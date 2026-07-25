#!/usr/bin/env bash
# Redeploy tv-fast-runner from the checked-out repo on the VPS.
#
# Use this after every code change to scripts/tv-fast-runner/ or when
# /health reports an older SERVER_VERSION than the repo. It is a thin
# wrapper around install-vps.sh so the "how do we ship a new build?"
# answer is always: `sudo bash scripts/tv-fast-runner/redeploy.sh`.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/tv-fast-runner/redeploy.sh" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/install-vps.sh"
