#!/usr/bin/env bash
# Set up Postgres + Redis on arcade-data (CTID 122, 10.0.1.45).
# Run inside the container. Reads DB_PW and REDIS_PW from the environment.
set -euo pipefail

: "${DB_PW:?set DB_PW}"
: "${REDIS_PW:?set REDIS_PW}"
LAN_CIDR="10.0.1.0/24"
BIND_IP="10.0.1.45"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql redis-server >/dev/null

# --- Postgres role + database ------------------------------------------------
runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openarcade') THEN
    CREATE ROLE openarcade LOGIN PASSWORD '${DB_PW}';
  ELSE
    ALTER ROLE openarcade PASSWORD '${DB_PW}';
  END IF;
END \$\$;
SELECT 'CREATE DATABASE openarcade OWNER openarcade'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openarcade')\gexec
SQL

# --- Postgres network config: listen on LAN, allow the .x/24 subnet ----------
PGCONF_DIR=$(runuser -u postgres -- psql -tAc "SHOW config_file" | xargs dirname)
sed -i "s/^#\?listen_addresses.*/listen_addresses = 'localhost,${BIND_IP}'/" "$PGCONF_DIR/postgresql.conf"
HBA="$PGCONF_DIR/pg_hba.conf"
if ! grep -q "openarcade LAN" "$HBA"; then
  {
    echo "# openarcade LAN access"
    echo "host    openarcade    openarcade    ${LAN_CIDR}    scram-sha-256"
  } >> "$HBA"
fi
systemctl restart postgresql

# --- Redis: bind LAN, require a password -------------------------------------
REDIS_CONF=/etc/redis/redis.conf
sed -i "s/^bind .*/bind 127.0.0.1 ${BIND_IP}/" "$REDIS_CONF"
sed -i "s/^# \?requirepass .*/requirepass ${REDIS_PW}/" "$REDIS_CONF"
grep -q "^requirepass " "$REDIS_CONF" || echo "requirepass ${REDIS_PW}" >> "$REDIS_CONF"
sed -i "s/^protected-mode .*/protected-mode yes/" "$REDIS_CONF"
systemctl enable redis-server >/dev/null 2>&1 || true
systemctl restart redis-server   # always restart so config edits take effect

echo "arcade-data: Postgres + Redis ready on ${BIND_IP}"
