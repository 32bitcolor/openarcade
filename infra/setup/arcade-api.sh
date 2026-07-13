#!/usr/bin/env bash
# Build + deploy arcade-api on CT 121 (10.0.1.44). Run inside the container.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq build-essential pkg-config libssl-dev curl git ca-certificates >/dev/null

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

cd /opt/openarcade/services/arcade-api
cargo build --release
install -m755 target/release/arcade-api /usr/local/bin/arcade-api

cat >/etc/systemd/system/arcade-api.service <<'UNIT'
[Unit]
Description=OpenArcade API gateway
After=network-online.target
Wants=network-online.target

[Service]
Environment=ARCADE_API_ADDR=0.0.0.0:8080
ExecStart=/usr/local/bin/arcade-api
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now arcade-api
sleep 2
systemctl is-active arcade-api && echo "arcade-api: running on :8080"
