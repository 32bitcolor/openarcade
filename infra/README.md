# OpenArcade — infrastructure

Everything to stand up OpenArcade on the Proxmox host (`10.0.1.65`).

## LXC provisioning

`lxc/containers.env` is the inventory (hostnames, CTIDs, IPs, sizing).
`lxc/provision.sh` creates + starts them with `pct`. Run it **on the host**:

```sh
scp -r infra/lxc root@10.0.1.65:/root/openarcade-lxc
ssh root@10.0.1.65 'cd /root/openarcade-lxc && ./provision.sh'
```

Containers are Debian 12, unprivileged, `nesting=1` (so `arcade-core` can run
openspy-core under Docker). Verify CTIDs/IPs against `pct list` first — the
defaults are proposals.

## The six containers

| Host | Purpose | Setup notes |
|------|---------|-------------|
| `arcade-core` | Your own GameSpy master | Docker + openspy-core suite |
| `arcade-api`  | Aggregator + WebSocket gateway | Rust binary from `services/arcade-api` |
| `arcade-data` | Postgres + Redis | apply `db/schema.sql` |
| `arcade-voice`| Mumble/Murmur | `apt install mumble-server` |
| `arcade-files`| Caddy static + news | patch/mod library |
| `arcade-web`  | Public site — signup + connect | Next.js app from `web/` |

## Database

`db/schema.sql` — accounts (shared between the app and the website), buddies,
games, servers, favorites, news. Apply on `arcade-data`:

```sh
psql -h 10.0.1.32 -U openarcade -d openarcade -f db/schema.sql
```

## Exposure

Public surfaces (`arcade-web`, `arcade-api` WebSocket) go through the existing
Cloudflare tunnel via `cf-expose`. Game/master UDP does **not** traverse the
tunnel — see `docs/architecture.md`.
