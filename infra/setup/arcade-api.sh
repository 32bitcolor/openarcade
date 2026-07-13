#!/usr/bin/env bash
# Build + deploy arcade-api on CT 121 (10.0.1.44). Run inside the container.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
# gslist is a 32-bit i386 binary — enable multiarch + 32-bit libc.
dpkg --add-architecture i386 || true
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libssl-dev curl git ca-certificates cmake libc6:i386 >/dev/null

# Debian 12 ships rustc too old for axum 0.7 — use rustup stable.
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"

cd /opt
if [ -d openarcade ]; then
  git -C openarcade pull --ff-only
else
  git clone --depth 1 https://github.com/32bitcolor/openarcade.git
fi

# gslist (OpenSpy server-list tool) + its game-key database.
mkdir -p /opt/gslist
install -m755 /opt/openarcade/infra/tools/gslist/gslist /opt/gslist/gslist
install -m644 /opt/openarcade/infra/tools/gslist/gslist.cfg /opt/gslist/gslist.cfg

cd /opt/openarcade/services/arcade-api
cargo build --release
install -m755 target/release/arcade-api /usr/local/bin/arcade-api

# Secrets/config file (root-only, not in git). DATABASE_URL + REDIS_URL are
# passed into this script from the environment; keep any existing file if unset.
if [ -n "${DATABASE_URL:-}" ] && [ -n "${REDIS_URL:-}" ]; then
  umask 077
  cat >/etc/arcade-api.env <<ENV
ARCADE_API_ADDR=0.0.0.0:8080
DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}
POLL_INTERVAL_SECS=${POLL_INTERVAL_SECS:-120}
# Optional: free key from https://steamcommunity.com/dev/apikey — lights up
# the Valve games (CS 1.6 / TFC / DoD). Empty = those games stay dark.
STEAM_API_KEY=${STEAM_API_KEY:-}
# OpenSpy ingester: directory holding the gslist binary + gslist.cfg.
GSLIST_DIR=/opt/gslist
ENV
fi

cat >/etc/systemd/system/arcade-api.service <<'UNIT'
[Unit]
Description=OpenArcade API gateway
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/arcade-api.env
ExecStart=/usr/local/bin/arcade-api
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable arcade-api >/dev/null 2>&1 || true
systemctl restart arcade-api   # always restart so the freshly-built binary loads
sleep 2
systemctl is-active arcade-api && echo "arcade-api: running on :8080"
