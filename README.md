# OpenArcade

A self-hosted, modern revival of **GameSpy Arcade** — one desktop hub that browses
live servers for the classic games, launches you straight into them, and brings back
the rooms, buddies, and voice that made it a place to hang out.

GameSpy shut down in 2014, but the revival scene kept the protocols alive. OpenArcade
doesn't reverse-engineer crypto — it **orchestrates known tooling against known keys**,
querying public revival masters and your own self-hosted one.

## Repository layout

| Path | What it is |
|------|-----------|
| [`client/`](client/) | The desktop app — [Tauri](https://tauri.app) (Rust core + web UI). |
| [`services/arcade-api/`](services/arcade-api/) | The brain — Rust/axum aggregator, poller, and WebSocket gateway. |
| [`infra/`](infra/) | Proxmox LXC provisioning + database schema. |
| [`docs/architecture.md`](docs/architecture.md) | Full architecture & build roadmap. |

## The five services (Proxmox LXCs, Debian)

| Host | Role | Stack |
|------|------|-------|
| `arcade-core` | Authentic GameSpy backend (your own master) | [openspy-core](https://github.com/openspy/openspy-core) |
| `arcade-api`  | Aggregator · poller · WebSocket gateway | Rust (axum) |
| `arcade-data` | State & live-server cache | Postgres + Redis |
| `arcade-voice`| Roger Wilco, reborn | Mumble / Murmur |
| `arcade-files`| FilePlanet, reborn | Caddy static + news feed |

## Where the server data comes from

- **[OpenSpy](https://openspy.net)** — ~132 classic games still report here.
- **[333networks](https://333networks.com)** — Unreal-engine masters, with a `/json` live-server API.
- **Your own [openspy-core](https://github.com/openspy/openspy-core)** — so your & friends' servers list too.
- **Tooling** — [gslist](https://aluigi.altervista.org/papers.htm) + `gslist.cfg` (the gamename/gamekey DB)
  and [GameserverLister](https://github.com/cetteup/GameserverLister), then direct A2S / `\status\` UDP probes per server.

## Status

Phase 1 (Foundation) — scaffolding. Nothing provisioned yet. See the roadmap in
[`docs/architecture.md`](docs/architecture.md).

## Development

```sh
# Client (Tauri) — needs the Rust toolchain + Node
cd client && pnpm install && pnpm tauri dev

# API service
cd services/arcade-api && cargo run
```

## License

MIT © Austin Funk (32bitcolor)
