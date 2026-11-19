#!/usr/bin/env bash
# Sets up RanchCord on a Raspberry Pi (Raspberry Pi OS 64-bit, Bookworm or newer).
#
#   git clone https://github.com/KingCreeper531/RanchCord.git ~/ranchcord
#   bash ~/ranchcord/deploy/pi/setup.sh
#
# It installs Node.js, ffmpeg and Caddy (for HTTPS), builds the app, starts RanchCord whenever the Pi
# boots, keeps a DuckDNS address pointed at your home, and checks GitHub for updates every night.
# Safe to run again: it keeps your settings and only fills in what's missing.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_USER="$(id -un)"
PORT=6420
NODE_MAJOR=24

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
ask() {
  local prompt="$1" default="${2:-}" reply
  read -r -p "$prompt${default:+ [$default]}: " reply </dev/tty
  printf '%s' "${reply:-$default}"
}

if [[ "$(uname -m)" != "aarch64" ]]; then
  echo "RanchCord needs Raspberry Pi OS 64-bit (this system is $(uname -m)). Reinstall with the 64-bit image."
  exit 1
fi
if [[ "$APP_USER" == "root" ]]; then
  echo "Run this as your normal user (not with sudo); it asks for your password when it needs it."
  exit 1
fi

say "Installing system packages (git, ffmpeg, Caddy)"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates xz-utils ffmpeg caddy

if ! command -v node >/dev/null || (($(node -p 'process.versions.node.split(".")[0]') < NODE_MAJOR)); then
  say "Installing Node.js $NODE_MAJOR"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(awk '/linux-arm64\.tar\.xz$/ {print $2}' <<<"$sums")"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" <<<"$sums" | sha256sum -c --quiet -)
  sudo tar -xJf "$tmp/$file" -C /usr/local --strip-components=1
  rm -rf "$tmp"
fi
echo "Node $(node -v)"

say "Building RanchCord (a few minutes on a Pi)"
cd "$APP_DIR"
npm ci --prefix server --omit=dev --no-audit --no-fund
npm ci --prefix client --no-audit --no-fund
npm run build --prefix client

ENV_FILE="$APP_DIR/server/.env"
if [[ -f "$ENV_FILE" ]] && grep -q '^PUBLIC_URL=' "$ENV_FILE"; then
  DOMAIN="$(sed -n 's#^PUBLIC_URL=https\?://##p' "$ENV_FILE" | head -1)"
  say "Keeping your settings in server/.env ($DOMAIN)"
else
  say "A few questions (you can change all of these later)"
  echo "Your server needs an address friends can reach, like yourname.duckdns.org (free at duckdns.org)."
  DOMAIN="$(ask 'Server address, without https://')"
  KLIPY="$(ask 'KLIPY key for GIFs (Enter to skip, you can add it in the app later)')"
  CODE="$(ask 'Signup code friends must type to make an account (Enter for none)')"
  umask 077
  cat >"$ENV_FILE" <<EOF
# RanchCord server settings. Most of these can also be changed in the app: Settings > Server Admin.
PORT=$PORT
PUBLIC_URL=https://$DOMAIN
KLIPY_API_KEY=$KLIPY
SIGNUP_CODE=$CODE
EOF
  umask 022
fi

say "Starting RanchCord now and whenever the Pi boots"
sudo tee /etc/systemd/system/ranchcord.service >/dev/null <<EOF
[Unit]
Description=RanchCord chat server
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
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

say "HTTPS with Caddy (free certificate from Let's Encrypt)"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF

if [[ "$DOMAIN" == *.duckdns.org ]]; then
  say "Keeping $DOMAIN pointed at your home internet"
  if ! sudo test -f /etc/ranchcord/duckdns.env; then
    TOKEN="$(ask 'Your DuckDNS token (shown at the top of duckdns.org when you log in)')"
    sudo install -d -m 700 /etc/ranchcord
    printf 'DUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "${DOMAIN%.duckdns.org}" "$TOKEN" | sudo tee /etc/ranchcord/duckdns.env >/dev/null
    sudo chmod 600 /etc/ranchcord/duckdns.env
  fi
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
fi

sudo systemctl daemon-reload
sudo systemctl enable --now ranchcord.service ranchcord-update.timer
sudo systemctl restart ranchcord.service
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy

# Grab the newest Windows and Android apps so friends can download them from the server.
node "$APP_DIR/deploy/pi/fetch-apps.mjs" || warn "Couldn't download the app installers yet (they appear after the first GitHub release)."

LAN_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_IP="$(curl -fsS https://api.ipify.org || echo unknown)"
say "Done! RanchCord is running."
cat <<EOF

  On your Wi-Fi:  http://$LAN_IP:$PORT
  Everywhere:     https://$DOMAIN   (after the router step below)

  Last step, on your router's settings page:
    Forward ports 80 and 443 (TCP) to this Pi ($LAN_IP).

  Your home's public address is $PUBLIC_IP. If your router's status page shows a
  different "WAN" address (often starting with 100.), your internet provider uses
  CGNAT and port forwarding won't work; see "Hosting behind CGNAT" in the README.

  Useful commands:
    sudo systemctl status ranchcord     is it running?
    journalctl -u ranchcord -f          live log
    bash $APP_DIR/deploy/pi/update.sh   update right now
EOF
