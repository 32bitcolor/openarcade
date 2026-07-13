#!/usr/bin/env bash
# Build + deploy the Next.js portal on CT 125 (10.0.1.48). Run inside the container.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git >/dev/null

# Node 20 LTS (Debian's is too old for Next 15).
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi

cd /opt
if [ -d openarcade ]; then
  git -C openarcade pull --ff-only
else
  git clone --depth 1 https://github.com/32bitcolor/openarcade.git
fi

cd /opt/openarcade/web
npm install --no-audit --no-fund
npm run build

cat >/etc/systemd/system/arcade-web.service <<'UNIT'
[Unit]
Description=OpenArcade public portal (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/openarcade/web
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=0.0.0.0
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now arcade-web
sleep 3
systemctl is-active arcade-web && echo "arcade-web: running on :3000"
