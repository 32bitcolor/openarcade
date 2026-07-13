//! arcade-api — the brain of OpenArcade.
//!
//! Three jobs:
//!   1. Aggregator — polls public revival masters (333networks today; OpenSpy/
//!      Valve/Quake next) for live servers, upserts to Postgres, caches in Redis.
//!   2. Room hub — per-game rooms over WebSocket: chat, member lists, presence,
//!      and a generic move-relay that carries the parlor games (chess/checkers/…).
//!   3. REST surface for the desktop client and the web portal.
//!
//!   GET  /health              -> liveness
//!   GET  /games               -> games with live server + player counts
//!   GET  /servers/:gamename   -> live server list for one game
//!   GET  /ws                  -> client live channel (rooms/chat/members/moves)

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_postgres::NoTls;
use tower_http::cors::CorsLayer;

const STALE_MINUTES: i64 = 10;

#[derive(Clone)]
struct AppState {
    pool: Pool,
    redis: redis::aio::MultiplexedConnection,
    http: reqwest::Client,
    hub: Arc<Mutex<Hub>>,
    next_id: Arc<AtomicU64>,
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

    let pg_cfg = tokio_postgres::Config::from_str(&database_url).expect("bad DATABASE_URL");
    let mgr = deadpool_postgres::Manager::from_config(
        pg_cfg,
        NoTls,
        ManagerConfig { recycling_method: RecyclingMethod::Fast },
    );
    let pool = Pool::builder(mgr).max_size(8).build().expect("build pg pool");

    let redis_client = redis::Client::open(redis_url).expect("bad REDIS_URL");
    let redis = redis_client
        .get_multiplexed_async_connection()
        .await
        .expect("connect redis");

    let state = AppState {
        pool,
        redis,
        http: reqwest::Client::new(),
        hub: Arc::new(Mutex::new(Hub::default())),
        next_id: Arc::new(AtomicU64::new(1)),
    };

    seed_games(&state).await.expect("seed games");

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

// ===========================================================================
// Aggregator
// ===========================================================================
async fn seed_games(state: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    const SEED: &[(&str, &str, &str)] = &[
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
        ("bfield1942", "Battlefield 1942", "openspy"),
        ("bfvietnam", "Battlefield Vietnam", "openspy"),
        ("battlefield2", "Battlefield 2", "openspy"),
        ("halom", "Halo: Combat Evolved", "openspy"),
        ("swat4", "SWAT 4", "openspy"),
        ("nwn", "Neverwinter Nights", "openspy"),
        ("avpclassic", "Aliens versus Predator Classic 2000", "openspy"),
        ("cstrike", "Counter-Strike 1.6", "valve"),
        ("tfc", "Team Fortress Classic", "valve"),
        ("dod", "Day of Defeat", "valve"),
        ("quake", "Quake", "quake"),
        ("quake2", "Quake II", "quake2"),
        ("quake3", "Quake III Arena", "quake3"),
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

fn clean(s: Option<String>) -> Option<String> {
    s.map(|v| v.chars().filter(|c| !c.is_control()).collect::<String>().trim().to_string())
        .filter(|v| !v.is_empty())
}

async fn poll_once(state: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
) -> Result<Vec<T333Server>, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("https://master.333networks.com/json/{gamename}?r=1000");
    let body: Value = http
        .get(&url)
        .header("User-Agent", "OpenArcade/0.1 (aggregator)")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .json()
        .await?;
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
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
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

// ===========================================================================
// Room hub — per-game rooms over WebSocket.
//
// A "room" is a channel string. Convention:
//   game-<slug>              title room (a game's main lobby)
//   game-<slug>-<group>      group room
//   game-<slug>-match-<id>   staging room for one hosted match
// The client picks the room name; the hub just relays. Everything is guest-nick
// for now (accounts land next); no persistence — chat is live-only.
// ===========================================================================
struct Conn {
    nick: String,
    tx: mpsc::UnboundedSender<String>,
    rooms: HashSet<String>,
}

#[derive(Default)]
struct Hub {
    conns: HashMap<u64, Conn>,
    rooms: HashMap<String, HashSet<u64>>,
}

impl Hub {
    fn send_to(&self, id: u64, msg: &str) {
        if let Some(c) = self.conns.get(&id) {
            let _ = c.tx.send(msg.to_string());
        }
    }
    fn broadcast(&self, room: &str, msg: &str) {
        if let Some(ids) = self.rooms.get(room) {
            for id in ids {
                self.send_to(*id, msg);
            }
        }
    }
    fn member_nicks(&self, room: &str) -> Vec<String> {
        let mut v: Vec<String> = self
            .rooms
            .get(room)
            .map(|ids| ids.iter().filter_map(|i| self.conns.get(i).map(|c| c.nick.clone())).collect())
            .unwrap_or_default();
        v.sort();
        v
    }
    fn nick_of(&self, id: u64) -> String {
        self.conns.get(&id).map(|c| c.nick.clone()).unwrap_or_default()
    }
    fn announce_members(&self, room: &str) {
        let msg = json!({ "type": "members", "room": room, "members": self.member_nicks(room) })
            .to_string();
        self.broadcast(room, &msg);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let nick = format!("guest{id}");

    // Pump outbound messages to the websocket sink.
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    {
        let mut hub = state.hub.lock().unwrap();
        hub.conns.insert(id, Conn { nick: nick.clone(), tx: tx.clone(), rooms: HashSet::new() });
    }
    let _ = tx.send(json!({ "type": "welcome", "nick": nick, "service": "arcade-api" }).to_string());

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => handle_client_msg(&state, id, &text),
            Message::Close(_) => break,
            _ => {}
        }
    }

    on_disconnect(&state, id);
    send_task.abort();
}

fn handle_client_msg(state: &AppState, id: u64, text: &str) {
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let room = v.get("room").and_then(|x| x.as_str()).map(|s| s.to_string());
    let mut hub = state.hub.lock().unwrap();

    match t {
        // Choose a display nick.
        "hello" | "nick" => {
            if let Some(n) = v.get("nick").and_then(|x| x.as_str()) {
                let n = n.chars().filter(|c| !c.is_control()).take(24).collect::<String>();
                if !n.trim().is_empty() {
                    let old_rooms: Vec<String> =
                        hub.conns.get(&id).map(|c| c.rooms.iter().cloned().collect()).unwrap_or_default();
                    if let Some(c) = hub.conns.get_mut(&id) {
                        c.nick = n.trim().to_string();
                    }
                    let nick = hub.nick_of(id);
                    hub.send_to(id, &json!({ "type": "nick", "nick": nick }).to_string());
                    for r in old_rooms {
                        hub.announce_members(&r);
                    }
                }
            }
        }
        // Join a room: add membership, send member list, notify the room.
        "join" => {
            if let Some(room) = room {
                hub.rooms.entry(room.clone()).or_default().insert(id);
                if let Some(c) = hub.conns.get_mut(&id) {
                    c.rooms.insert(room.clone());
                }
                let nick = hub.nick_of(id);
                hub.broadcast(
                    &room,
                    &json!({ "type": "join", "room": room, "nick": nick }).to_string(),
                );
                hub.announce_members(&room);
            }
        }
        "leave" => {
            if let Some(room) = room {
                if let Some(s) = hub.rooms.get_mut(&room) {
                    s.remove(&id);
                }
                if let Some(c) = hub.conns.get_mut(&id) {
                    c.rooms.remove(&room);
                }
                let nick = hub.nick_of(id);
                hub.broadcast(
                    &room,
                    &json!({ "type": "leave", "room": room, "nick": nick }).to_string(),
                );
                hub.announce_members(&room);
            }
        }
        // Chat message to a room.
        "chat" => {
            if let (Some(room), Some(txt)) =
                (room, v.get("text").and_then(|x| x.as_str()))
            {
                let nick = hub.nick_of(id);
                let out = json!({
                    "type": "chat", "room": room, "nick": nick,
                    "text": txt, "ts": now_ms()
                })
                .to_string();
                hub.broadcast(&room, &out);
            }
        }
        // Parlor-game move / control relay — opaque payload, echoed to the room.
        "move" | "ready" | "begin" | "game" => {
            if let Some(room) = room {
                let nick = hub.nick_of(id);
                let mut out = v.clone();
                if let Some(obj) = out.as_object_mut() {
                    obj.insert("nick".into(), json!(nick));
                    obj.insert("ts".into(), json!(now_ms()));
                }
                hub.broadcast(&room, &out.to_string());
            }
        }
        _ => {}
    }
}

fn on_disconnect(state: &AppState, id: u64) {
    let mut hub = state.hub.lock().unwrap();
    let rooms: Vec<String> =
        hub.conns.get(&id).map(|c| c.rooms.iter().cloned().collect()).unwrap_or_default();
    let nick = hub.nick_of(id);
    hub.conns.remove(&id);
    for r in &rooms {
        if let Some(s) = hub.rooms.get_mut(r) {
            s.remove(&id);
        }
    }
    for r in rooms {
        hub.broadcast(&r, &json!({ "type": "leave", "room": r, "nick": nick }).to_string());
        hub.announce_members(&r);
    }
}

// ===========================================================================
// HTTP handlers
// ===========================================================================
async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "arcade-api", "version": "0.2.0" }))
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

async fn servers(State(state): State<AppState>, Path(gamename): Path<String>) -> impl IntoResponse {
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
