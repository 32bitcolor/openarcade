-- OpenArcade — Postgres schema (runs on arcade-data).
-- Accounts are shared between the desktop client and the public website.
-- Live server state lives in Redis; this table is the durable record + history.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Accounts & social
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nick          TEXT UNIQUE NOT NULL,           -- the classic GameSpy "unique nick"
    email         CITEXT UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ,
    verified      BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS buddies (
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    buddy_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, buddy_id),
    CHECK (account_id <> buddy_id)
);

-- ---------------------------------------------------------------------------
-- Games & servers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
    id           SERIAL PRIMARY KEY,
    gamename     TEXT UNIQUE NOT NULL,            -- GameSpy gamename, e.g. "halom"
    title        TEXT NOT NULL,
    gamekey      TEXT,                            -- secret key (from gslist.cfg)
    enctype      SMALLINT,                        -- 0/1/2/X
    query_proto  TEXT NOT NULL DEFAULT 'gamespy', -- gamespy | a2s | quake | unreal
    supported    BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS servers (
    id           BIGSERIAL PRIMARY KEY,
    game_id      INT NOT NULL REFERENCES games(id),
    address      INET NOT NULL,
    port         INT NOT NULL,
    name         TEXT,
    map          TEXT,
    gametype     TEXT,
    mod_name     TEXT,
    players      INT,
    max_players  INT,
    has_password BOOLEAN NOT NULL DEFAULT false,
    source       TEXT NOT NULL,                   -- openspy | 333networks | arcade-core
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (game_id, address, port)
);

CREATE INDEX IF NOT EXISTS servers_game_seen_idx ON servers (game_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, server_id)
);

-- ---------------------------------------------------------------------------
-- Content
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    game_id     INT REFERENCES games(id),
    published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
