#!/usr/bin/env bash
# Pulls the latest RanchCord from GitHub, rebuilds and restarts it if anything changed.
# Runs every night (ranchcord-update.timer); run it yourself any time: bash deploy/pi/update.sh [--force]
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="$(stat -c %U "$APP_DIR")"

as_app() {
  if [[ "$(id -un)" == "$APP_USER" ]]; then "$@"; else sudo -u "$APP_USER" -H "$@"; fi
}
as_root() {
  if [[ "$(id -u)" == 0 ]]; then "$@"; else sudo "$@"; fi
}

cd "$APP_DIR"
before="$(as_app git rev-parse HEAD)"
as_app git pull --ff-only --quiet
after="$(as_app git rev-parse HEAD)"

if [[ "$before" == "$after" && "${1:-}" != "--force" ]]; then
  echo "RanchCord is up to date (${after:0:7})"
else
  echo "Updating RanchCord ${before:0:7} -> ${after:0:7}"
  as_app npm ci --prefix server --omit=dev --no-audit --no-fund
  as_app npm ci --prefix client --no-audit --no-fund
  as_app npm run build --prefix client
  as_root systemctl restart ranchcord
  echo "RanchCord updated and restarted"
fi

# Newest Windows/Android installers for the in-app "Download the apps" button.
as_app node "$APP_DIR/deploy/pi/fetch-apps.mjs" || echo "Couldn't check for new app installers right now"
