//! arcade-api — the brain of OpenArcade.
//!
//! HTTP + WebSocket surface for the client, plus the server-list aggregator.
//! The aggregator polls public revival masters (333networks today; OpenSpy via
//! gslist next) for live servers of the classic GameSpy games, upserts them into
//! Postgres, and caches per-game lists in Redis for fast reads.
//!
//!   GET /health              -> liveness
//!   GET /games               -> games with live server + player counts
//!   GET /servers/:gamename   -> live server list for one game
//!   GET /ws                  -> client live channel

use std::net::IpAddr;
use std::str::FromStr;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use deadpool_postgres::{ManagerConfig, Pool, RecyclingMethod};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_postgres::NoTls;
use tower_http::cors::CorsLayer;

const STALE_MINUTES: i64 = 10;

#[derive(Clone)]
struct AppState {
    pool: Pool,
    redis: redis::aio::MultiplexedConnection,
    http: reqwest::Client,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "arcade_api=info,tower_http=warn".into()),
        )
        .init();

    let database_url =
        std::env::var("DATABASE_URL").expect("DATABASE_URL is required (postgres://…)");
    let redis_url = std::env::var("REDIS_URL").expect("REDIS_URL is required (redis://…)");
    let addr = std::env::var("ARCADE_API_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let poll_secs: u64 = std::env::var("POLL_INTERVAL_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(120);

    // --- Postgres pool -------------------------------------------------------
    let pg_cfg = tokio_postgres::Config::from_str(&database_url).expect("bad DATABASE_URL");
    let mgr = deadpool_postgres::Manager::from_config(
        pg_cfg,
        NoTls,
        ManagerConfig { recycling_method: RecyclingMethod::Fast },
    );
    let pool = Pool::builder(mgr).max_size(8).build().expect("build pg pool");

    // --- Redis ---------------------------------------------------------------
    let redis_client = redis::Client::open(redis_url).expect("bad REDIS_URL");
    let redis = redis_client
        .get_multiplexed_async_connection()
        .await
        .expect("connect redis");

    let state = AppState { pool, redis, http: reqwest::Client::new() };

    seed_games(&state).await.expect("seed games");

    // --- background poller ---------------------------------------------------
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                if let Err(e) = poll_once(&state).await {
                    tracing::warn!("poll cycle failed: {e}");
                }
                tokio::time::sleep(Duration::from_secs(poll_secs)).await;
            }
        });
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/games", get(games))
        .route("/servers/:gamename", get(servers))
        .route("/ws", get(ws_upgrade))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind arcade-api");
    tracing::info!("arcade-api listening on {addr}, polling every {poll_secs}s");
    axum::serve(listener, app).await.expect("serve arcade-api");
}

// ---------------------------------------------------------------------------
// Seed data — the popular classic GameSpy Arcade games.
// query_proto encodes the fetch source: '333networks' is polled live now;
// 'openspy' titles are known/seeded and light up once the gslist sidecar lands.
// ---------------------------------------------------------------------------
async fn seed_games(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    const SEED: &[(&str, &str, &str)] = &[
        // gamename, title, source(query_proto)
        ("ut", "Unreal Tournament", "333networks"),
        ("ut2003", "Unreal Tournament 2003", "333networks"),
        ("ut2004", "Unreal Tournament 2004", "333networks"),
        ("unreal", "Unreal", "333networks"),
        ("deusex", "Deus Ex", "333networks"),
        ("rune", "Rune", "333networks"),
        ("mohaa", "Medal of Honor: Allied Assault", "333networks"),
        ("postal2", "Postal 2", "333networks"),
        ("tacticalops", "Tactical Ops", "333networks"),
        ("nerf", "Nerf Arena Blast", "333networks"),
        // OpenSpy-backed favorites (server ingestion pending gslist)
        ("bfield1942", "Battlefield 1942", "openspy"),
        ("bfvietnam", "Battlefield Vietnam", "openspy"),
        ("battlefield2", "Battlefield 2", "openspy"),
        ("halom", "Halo: Combat Evolved", "openspy"),
        ("swat4", "SWAT 4", "openspy"),
        ("nwn", "Neverwinter Nights", "openspy"),
    ];
    let client = state.pool.get().await?;
    for (gamename, title, proto) in SEED {
        client
            .execute(
                "INSERT INTO games (gamename, title, query_proto, supported)
                 VALUES ($1, $2, $3, true)
                 ON CONFLICT (gamename) DO UPDATE SET title = EXCLUDED.title",
                &[gamename, title, proto],
            )
            .await?;
    }
    tracing::info!("seeded {} games", SEED.len());
    Ok(())
}

// ---------------------------------------------------------------------------
// Poller — 333networks JSON per game.
// ---------------------------------------------------------------------------
#[derive(Deserialize)]
struct T333Server {
    ip: String,
    hostport: i64,
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    mapname: Option<String>,
    #[serde(default)]
    gametype: Option<String>,
    #[serde(default)]
    numplayers: Option<i64>,
    #[serde(default)]
    maxplayers: Option<i64>,
}

#[derive(Serialize)]
struct ServerOut {
    address: String,
    port: i32,
    name: Option<String>,
    map: Option<String>,
    gametype: Option<String>,
    players: Option<i32>,
    max_players: Option<i32>,
    source: String,
}

/// Strip control characters (Unreal/GameSpy colour codes) from a display string.
fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string())
        .filter(|v| !v.is_empty())
}

async fn poll_once(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    let client = state.pool.get().await?;
    let rows = client
        .query(
            "SELECT id, gamename FROM games WHERE query_proto = '333networks' AND supported",
            &[],
        )
        .await?;

    let mut grand_total = 0usize;
    for row in rows {
        let game_id: i32 = row.get(0);
        let gamename: String = row.get(1);
        match fetch_333(&state.http, &gamename).await {
            Ok(list) => {
                let n = ingest(state, game_id, &gamename, list).await.unwrap_or(0);
                grand_total += n;
                if n > 0 {
                    tracing::info!("{gamename}: {n} servers");
                }
            }
            Err(e) => tracing::warn!("{gamename}: fetch failed: {e}"),
        }
    }
    tracing::info!("poll cycle done — {grand_total} servers across 333networks games");
    Ok(())
}

async fn fetch_333(
    http: &reqwest::Client,
    gamename: &str,
) -> Result<Vec<T333Server>, Box<dyn std::error::Error>> {
    let url = format!("https://master.333networks.com/json/{gamename}?r=1000");
    let body: serde_json::Value = http
        .get(&url)
        .header("User-Agent", "OpenArcade/0.1 (aggregator)")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .json()
        .await?;
    // Response shape: [ [servers...], {meta} ]
    let arr = body.get(0).and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let servers = arr
        .into_iter()
        .filter_map(|v| serde_json::from_value::<T333Server>(v).ok())
        .collect();
    Ok(servers)
}

async fn ingest(
    state: &AppState,
    game_id: i32,
    gamename: &str,
    list: Vec<T333Server>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let client = state.pool.get().await?;
    let mut out: Vec<ServerOut> = Vec::with_capacity(list.len());

    for s in list {
        let ip: IpAddr = match s.ip.parse() {
            Ok(ip) => ip,
            Err(_) => continue,
        };
        let port = s.hostport as i32;
        let name = clean(s.hostname);
        let map = clean(s.mapname);
        let gametype = clean(s.gametype);
        let players = s.numplayers.map(|v| v as i32);
        let max_players = s.maxplayers.map(|v| v as i32);

        client
            .execute(
                "INSERT INTO servers
                   (game_id, address, port, name, map, gametype, players, max_players, source, last_seen_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'333networks', now())
                 ON CONFLICT (game_id, address, port) DO UPDATE SET
                   name=EXCLUDED.name, map=EXCLUDED.map, gametype=EXCLUDED.gametype,
                   players=EXCLUDED.players, max_players=EXCLUDED.max_players,
                   source=EXCLUDED.source, last_seen_at=now()",
                &[&game_id, &ip, &port, &name, &map, &gametype, &players, &max_players],
            )
            .await?;

        out.push(ServerOut {
            address: ip.to_string(),
            port,
            name,
            map,
            gametype,
            players,
            max_players,
            source: "333networks".into(),
        });
    }

    // Cache the per-game list in Redis for fast reads (10 min TTL).
    let key = format!("oa:servers:{gamename}");
    let payload = serde_json::to_string(&out)?;
    let mut redis = state.redis.clone();
    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(payload)
        .arg("EX")
        .arg(600)
        .query_async(&mut redis)
        .await?;

    Ok(out.len())
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------
async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "arcade-api", "version": "0.1.0" }))
}

async fn games(State(state): State<AppState>) -> impl IntoResponse {
    let client = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let sql = format!(
        "SELECT g.gamename, g.title, g.query_proto,
                COUNT(s.id) FILTER (WHERE s.last_seen_at > now() - interval '{STALE_MINUTES} minutes') AS servers,
                COALESCE(SUM(s.players) FILTER (WHERE s.last_seen_at > now() - interval '{STALE_MINUTES} minutes'), 0) AS players
         FROM games g LEFT JOIN servers s ON s.game_id = g.id
         GROUP BY g.id ORDER BY servers DESC, g.title"
    );
    match client.query(&sql, &[]).await {
        Ok(rows) => {
            let items: Vec<_> = rows
                .iter()
                .map(|r| {
                    json!({
                        "gamename": r.get::<_, String>(0),
                        "title": r.get::<_, String>(1),
                        "source": r.get::<_, String>(2),
                        "servers": r.get::<_, i64>(3),
                        "players": r.get::<_, i64>(4),
                    })
                })
                .collect();
            Json(json!({ "games": items })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn servers(
    State(state): State<AppState>,
    Path(gamename): Path<String>,
) -> impl IntoResponse {
    // Fast path: Redis cache.
    let mut redis = state.redis.clone();
    let cached: Option<String> = redis::cmd("GET")
        .arg(format!("oa:servers:{gamename}"))
        .query_async(&mut redis)
        .await
        .ok()
        .flatten();
    if let Some(payload) = cached {
        return ([(axum::http::header::CONTENT_TYPE, "application/json")], payload).into_response();
    }

    // Fallback: Postgres.
    let client = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let sql = format!(
        "SELECT host(s.address), s.port, s.name, s.map, s.gametype, s.players, s.max_players, s.source
         FROM servers s JOIN games g ON g.id = s.game_id
         WHERE g.gamename = $1 AND s.last_seen_at > now() - interval '{STALE_MINUTES} minutes'
         ORDER BY s.players DESC NULLS LAST"
    );
    match client.query(&sql, &[&gamename]).await {
        Ok(rows) => {
            let items: Vec<ServerOut> = rows
                .iter()
                .map(|r| ServerOut {
                    address: r.get::<_, String>(0),
                    port: r.get::<_, i32>(1),
                    name: r.get(2),
                    map: r.get(3),
                    gametype: r.get(4),
                    players: r.get(5),
                    max_players: r.get(6),
                    source: r.get::<_, String>(7),
                })
                .collect();
            Json(items).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn ws_upgrade(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    let hello = json!({ "type": "welcome", "service": "arcade-api" }).to_string();
    if socket.send(Message::Text(hello)).await.is_err() {
        return;
    }
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(_) => {
                let ack = json!({ "type": "ack" }).to_string();
                if socket.send(Message::Text(ack)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}
