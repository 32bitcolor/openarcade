#!/usr/bin/env bash
# Provision the OpenArcade LXCs on the Proxmox host.
#
# Run this ON the Proxmox host (10.0.1.65) as root, e.g.:
#   scp -r infra/lxc root@10.0.1.65:/root/openarcade-lxc
#   ssh root@10.0.1.65 'cd /root/openarcade-lxc && ./provision.sh'
#
# Idempotent-ish: skips any CTID that already exists. Set PASSWORD env or it
# generates a root password per container and prints it once.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=containers.env
source "$here/containers.env"

command -v pct >/dev/null || { echo "pct not found — run this on the Proxmox host."; exit 1; }

for entry in "${CONTAINERS[@]}"; do
  read -r hostname ctid ip mem disk role <<<"$entry"

  if pct status "$ctid" >/dev/null 2>&1; then
    echo "== $hostname (CTID $ctid) already exists — skipping."
    continue
  fi

  pass="${PASSWORD:-$(openssl rand -base64 12)}"
  echo "== Creating $hostname (CTID $ctid) — $ip — $role"

  pct create "$ctid" "$TEMPLATE" \
    --hostname "$hostname" \
    --cores "$CORES" \
    --memory "$mem" \
    --rootfs "${STORAGE}:${disk}" \
    --net0 "name=eth0,bridge=${BRIDGE},ip=${ip},gw=${GATEWAY}" \
    --nameserver "$NAMESERVER" \
    --features "nesting=1" \
    --unprivileged 1 \
    --onboot 1 \
    --password "$pass"

  pct start "$ctid"
  echo "   started. root password: $pass"
  echo "   (save this — it is not stored anywhere)"
done

echo
echo "All OpenArcade containers provisioned. Next: run the per-service setup"
echo "(Docker for openspy-core, Postgres/Redis on arcade-data, etc.)."
