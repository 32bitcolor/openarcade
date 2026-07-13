# OpenArcade — public website (`arcade-web`)

The official OpenArcade portal. What it does:

- **Landing page** — what OpenArcade is, screenshots, download the desktop client.
- **Sign up / log in** — accounts shared with the desktop app (same `accounts` table
  on `arcade-data`), so a nick created here works in the client and vice-versa.
- **Email verification & password reset** — via a transactional email provider
  (see below); do **not** self-host SMTP.
- **Connect to the official server** — server browser of what's live on your
  `arcade-core` master, and "how to connect" per game.

## Stack

Next.js (App Router) + TypeScript, talking to `arcade-api` for data and to
Postgres (`arcade-data`) for accounts. Runs in the `arcade-web` LXC, fronted by
the Cloudflare tunnel.

## Email

Verification / reset / notification email goes through a transactional provider
over API — self-hosting a mail server on a homelab IP fails deliverability
(SPF/DKIM/DMARC + residential port-25 blocks). Configure one of:

| Provider | Free tier | Notes |
|----------|-----------|-------|
| Resend   | 3k/mo     | Simplest API, great DX. Recommended. |
| Amazon SES | ~62k/mo (from EC2) | Cheapest at scale, more setup. |
| Postmark | 100/mo    | Best deliverability, low free tier. |

Set the domain's SPF/DKIM records (Cloudflare DNS) and put the key in
`.env.local` (see `.env.example`). Never commit real keys.
