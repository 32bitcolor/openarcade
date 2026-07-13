# OpenArcade — Architecture & Roadmap

A self-hosted revival of GameSpy Arcade, hosted on the Proxmox host (`10.0.1.65`).

## Locked decisions

| | |
|---|---|
| **Codename** | OpenArcade |
| **Client** | Tauri desktop (cross-platform; shares Rust query crates with the backend) |
| **Game target** | Revive classic GameSpy games — see every live server |
| **Chat & voice** | Authentic — PeerChat/IRC + Mumble |
| **Sequencing** | Full architecture upfront |
| **Exposure** | Public via Cloudflare tunnel (TCP layers only — game UDP won't traverse the tunnel) |
| **Container OS** | Debian (lightweight) |

## 01 — The unlock: where server data comes from

Two kinds of source feed the browser at once:

**Public revival masters** (query these to see everyone's servers worldwide)
- **OpenSpy** (`openspy.net`) — full open-source GameSpy reimplementation; ~132 classic
  games still report to it (Tony Hawk, F.E.A.R., Halo, Battlefield, SWAT 4, NWN).
- **333networks** (`333networks.com`) — the Unreal-engine master (UT, Deus Ex, Rune,
  Serious Sam, Postal 2); exposes a `/json` API of live servers.

**Your own self-hosted master** (so your & friends' servers list too)
- **openspy-core** — one suite reimplementing the *entire* GameSpy backend: ServerBrowsing
  (SB), Query & Reporting master (QR), GP presence/accounts, PeerChat (IRC), NatNeg
  hole-punching, CD-key auth. The crown jewel.

**Fetch tooling** (the "how do I pull a list per game" problem, already solved)
- **gslist + gslist.cfg** (Auriemma) — the database of every game's `gamename`, secret
  `gamekey`, and enctype needed to decrypt master responses.
- **cetteup/GameserverLister** — maintained tool that retrieves lists across GameSpy and
  other protocols.
- Then a direct A2S / `\status\` UDP probe per server fills in map, players, ping, mod.

## 02 — Service architecture (6 LXCs on `10.0.1.x`, Debian)

| Host | Role | Stack | Ports |
|------|------|-------|-------|
| `arcade-core` | Authentic GameSpy backend (your own master) | openspy-core | 6500, 27900, 28900/28910, 29900/29901, 6667 |
| `arcade-api`  | The brain — aggregator, poller, WebSocket gateway | Rust (axum) + gslist/GameserverLister | 443 (behind tunnel) |
| `arcade-data` | State — accounts, buddies, favorites, cache | Postgres + Redis | 5432, 6379 |
| `arcade-voice`| Roger Wilco equivalent | Mumble / Murmur | 64738 |
| `arcade-files`| FilePlanet equivalent + news | Caddy static + news feed | 80, 443 |
| `arcade-web`  | Public site — signup + connect to the official server | Next.js | 443 (behind tunnel) |

### The public website (`arcade-web`)

The official OpenArcade portal: landing page, **account sign-up / log in** (accounts shared
with the desktop client — same `accounts` table), email verification & password reset, a
web server browser of what's live on your master, and per-game "how to connect" guides.

**Email** is the one piece we do *not* self-host — a mail server on a homelab IP fails
deliverability (SPF/DKIM/DMARC + residential port-25 blocks). Verification/reset mail goes
through a transactional provider over API (Resend recommended; Amazon SES or Postmark as
alternatives), with SPF/DKIM set in Cloudflare DNS for the OpenArcade domain.

**Tunnel reality check.** Cloudflare tunnels proxy TCP — the app UI, API, chat, and
downloads reach friends globally. Master/query and the games themselves are UDP, which the
tunnel won't carry, so *joining an actual match* still needs a port-forward or the friend
self-hosting. Discovery + social layer is global; the match packets are peer-to-peer.

## 03 — The client (Tauri desktop)

Rust core (sharing query-protocol crates with `arcade-api`) + web-tech UI styled like the
original. Tabs map one-to-one to the classic Arcade:

- **My Games** — scans local disk for installed classics, matches the supported-games DB.
- **Server Browser** — live per-game list (name, ping, players, map, mod, locked); filter,
  sort, favorite, one-click launch-and-join.
- **Rooms** — PeerChat/IRC lobby + per-game rooms, shared with real game clients.
- **Buddies & IM** — friends list, presence ("Bob is playing SWAT 4 → Join"), 1:1 messages.
- **Downloads** — patches, maps, mods from `arcade-files`.
- **News** — featured games and updates.

Launch-and-join spawns the game with the right connect string, and can inject the
openspy-client redirect so a game's own in-game browser points at your master too.

## 04 — Build roadmap

1. **Foundation** — provision the 5 LXCs, Postgres/Redis schema, `arcade-api` skeleton with
   WebSocket, empty Tauri shell that connects to it. *(Everything talks; nothing does much.)*
2. **Server data pipeline** — wire gslist/GameserverLister into `arcade-api`, ingest OpenSpy
   + 333networks, run detail probes, populate the cache → **Server Browser works end-to-end.**
3. **Your own master** — deploy openspy-core in `arcade-core`; your servers appear alongside
   the public ones; wire launch-and-join.
4. **Social layer** — PeerChat/IRC rooms, buddies & presence, accounts, Mumble voice.
5. **Content & polish** — `arcade-files` downloads, news, game auto-detection, tunnel exposure.

## Sources

openspy.net · 333networks.com · aluigi.altervista.org (gslist) ·
github.com/cetteup/GameserverLister · github.com/openspy/openspy-core
