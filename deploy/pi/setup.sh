#!/usr/bin/env bash
# Sets up RanchCord on a Raspberry Pi (Raspberry Pi OS 64-bit, Bookworm or newer).
#
#   git clone https://github.com/KingCreeper531/RanchCord.git ~/ranchcord
#   bash ~/ranchcord/deploy/pi/setup.sh
#
# It installs Node.js and ffmpeg, builds the app, starts RanchCord whenever the Pi boots, and checks
# GitHub for updates every night. With an address (like you.duckdns.org) it also turns on HTTPS with
# Caddy and keeps DuckDNS pointed at your home. Safe to run again: it keeps your settings and only
# fills in what's missing (run it again later to add your address).
#
# Answers can also come from the environment, so it runs without anyone at the keyboard:
#   RANCHCORD_DOMAIN=you.duckdns.org DUCKDNS_TOKEN=... KLIPY_API_KEY=... SIGNUP_CODE=... bash setup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="$(id -un)"
PORT=6420
NODE_MAJOR=24
ENV_FILE="$APP_DIR/server/.env"

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
can_ask() { { : </dev/tty; } 2>/dev/null; }
ask() {
  local prompt="$1" default="${2:-}" reply=''
  if can_ask; then read -r -p "$prompt${default:+ [$default]}: " reply </dev/tty; fi
  printf '%s' "${reply:-$default}"
}
env_get() { if [[ -f "$ENV_FILE" ]]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; fi; }
env_set() {
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then grep -v "^$1=" "$ENV_FILE" >"$tmp" || true; fi
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

if [[ "$(uname -m)" != "aarch64" ]]; then
  echo "RanchCord needs Raspberry Pi OS 64-bit (this system is $(uname -m)). Reinstall with the 64-bit image."
  exit 1
fi
if [[ "$APP_USER" == "root" ]]; then
  echo "Run this as your normal user (not with sudo); it asks for your password when it needs it."
  exit 1
fi

say "Installing system packages (git, ffmpeg)"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates xz-utils ffmpeg

if ! command -v node >/dev/null || (($(node -p 'process.versions.node.split(".")[0]') < NODE_MAJOR)); then
  say "Installing Node.js $NODE_MAJOR"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(awk '/linux-arm64\.tar\.xz$/ {print $2}' <<<"$sums")"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" <<<"$sums" | sha256sum -c --quiet -)
  sudo tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
  rm -rf "$tmp"
fi
echo "Node $(node -v)"

say "Building RanchCord (a few minutes on a Pi)"
cd "$APP_DIR"
npm ci --prefix server --omit=dev --no-audit --no-fund
npm ci --prefix client --no-audit --no-fund
npm run build --prefix client

say "Settings (server/.env)"
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  printf '# RanchCord server settings. After changing one, run: sudo systemctl restart ranchcord\nPORT=%s\n' "$PORT" >"$ENV_FILE"
  umask 022
fi
DOMAIN="${RANCHCORD_DOMAIN:-$(env_get PUBLIC_URL)}"
if [[ -z "$DOMAIN" ]]; then
  echo "Friends reach your server at an address like yourname.duckdns.org (free at duckdns.org)."
  DOMAIN="$(ask 'Server address, without https:// (Enter to skip: home Wi-Fi only for now)')"
fi
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"
if [[ -n "$DOMAIN" ]]; then env_set PUBLIC_URL "https://$DOMAIN"; fi
if [[ -z "$(env_get KLIPY_API_KEY)" ]]; then
  KLIPY="${KLIPY_API_KEY:-$(ask 'KLIPY key for GIFs (Enter to skip, you can add KLIPY_API_KEY to server/.env later)')}"
  if [[ -n "$KLIPY" ]]; then env_set KLIPY_API_KEY "$KLIPY"; fi
fi
if ! grep -q '^SIGNUP_CODE=' "$ENV_FILE"; then
  CODE="${SIGNUP_CODE-$(ask 'Signup code friends must type to make an account (Enter for none)')}"
  env_set SIGNUP_CODE "$CODE"
fi

say "Starting RanchCord now and whenever the Pi boots"
# Runs as your account by number, so renaming the account later doesn't break it.
sudo tee /etc/systemd/system/ranchcord.service >/dev/null <<EOF
[Unit]
Description=RanchCord chat server
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -u)
Group=$(id -g)
WorkingDirectory=$APP_DIR/server
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning src/index.ts
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

say "Checking GitHub for updates every night"
sudo tee /etc/systemd/system/ranchcord-update.service >/dev/null <<EOF
[Unit]
Description=Update RanchCord from GitHub
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/deploy/pi/update.sh
EOF
sudo tee /etc/systemd/system/ranchcord-update.timer >/dev/null <<EOF
[Unit]
Description=Update RanchCord every night

[Timer]
OnCalendar=*-*-* 04:30
RandomizedDelaySec=20m
Persistent=true

[Install]
WantedBy=timers.target
EOF

if [[ -n "$DOMAIN" ]]; then
  say "HTTPS with Caddy (free certificate from Let's Encrypt)"
  sudo apt-get install -y caddy
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  sudo systemctl enable caddy >/dev/null 2>&1 || true
  sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

  if [[ "$DOMAIN" == *.duckdns.org ]]; then
    if ! sudo test -f /etc/ranchcord/duckdns.env; then
      TOKEN="${DUCKDNS_TOKEN:-$(ask 'Your DuckDNS token (shown at the top of duckdns.org when you log in)')}"
      if [[ -n "$TOKEN" ]]; then
        sudo install -d -m 700 /etc/ranchcord
        printf 'DUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "${DOMAIN%.duckdns.org}" "$TOKEN" | sudo tee /etc/ranchcord/duckdns.env >/dev/null
        sudo chmod 600 /etc/ranchcord/duckdns.env
      fi
    fi
    if sudo test -f /etc/ranchcord/duckdns.env; then
      say "Keeping $DOMAIN pointed at your home internet"
      sudo tee /etc/systemd/system/duckdns.service >/dev/null <<'EOF'
[Unit]
Description=Update DuckDNS with this network's address
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/ranchcord/duckdns.env
ExecStart=/usr/bin/curl -fsS -o /dev/null "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip="
EOF
      sudo tee /etc/systemd/system/duckdns.timer >/dev/null <<'EOF'
[Unit]
Description=Update DuckDNS every 5 minutes

[Timer]
OnBootSec=30s
OnUnitActiveSec=5m

[Install]
WantedBy=timers.target
EOF
      sudo systemctl daemon-reload
      sudo systemctl enable --now duckdns.timer
    else
      warn "No DuckDNS token yet, so $DOMAIN won't follow your home address. Run this script again to add it."
    fi
  fi
fi

sudo systemctl daemon-reload
sudo systemctl enable --now ranchcord.service ranchcord-update.timer
sudo systemctl restart ranchcord.service

# Grab the newest Windows and Android apps so friends can download them from the server.
node "$APP_DIR/deploy/pi/fetch-apps.mjs" || warn "Couldn't download the app installers yet (they appear after the first GitHub release)."

LAN_IP="$(hostname -I | awk '{print $1}')"
say "Done! RanchCord is running."
echo
echo "  On your Wi-Fi:  http://$LAN_IP:$PORT"
if [[ -n "$DOMAIN" ]]; then
  PUBLIC_IP="$(curl -fsS https://api.ipify.org || echo unknown)"
  cat <<EOF
  Everywhere:     https://$DOMAIN   (after the router step below)

  Last step, on your router's settings page:
    Forward ports 80 and 443 (TCP) to this Pi ($LAN_IP).

  Your home's public address is $PUBLIC_IP. If your router's status page shows a
  different "WAN" address (often starting with 100.), your internet provider uses
  CGNAT and port forwarding won't work; see "Hosting behind CGNAT" in the README.
EOF
else
  cat <<EOF

  To let friends in from anywhere: get a free address at duckdns.org, then run
    RANCHCORD_DOMAIN=yourname.duckdns.org bash $APP_DIR/deploy/pi/setup.sh
  and forward ports 80 and 443 (TCP) on your router to this Pi ($LAN_IP).
EOF
fi
cat <<EOF

  Useful commands:
    sudo systemctl status ranchcord     is it running?
    journalctl -u ranchcord -f          live log
    bash $APP_DIR/deploy/pi/update.sh   update right now
EOF
