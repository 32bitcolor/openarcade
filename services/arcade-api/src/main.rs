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
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::net::UdpSocket;
use tokio::time::timeout;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
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

mod poker;

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
                    tracing::warn!("333networks poll failed: {e}");
                }
                if let Err(e) = poll_valve(&state).await {
                    tracing::warn!("valve poll failed: {e}");
                }
                if let Err(e) = poll_quake(&state).await {
                    tracing::warn!("quake poll failed: {e}");
                }
                if let Err(e) = poll_openspy(&state).await {
                    tracing::warn!("openspy poll failed: {e}");
                }
                tokio::time::sleep(Duration::from_secs(poll_secs)).await;
            }
        });
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/games", get(games))
        .route("/servers/:gamename", get(servers))
        .route("/details", get(details))
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
        ("halo", "Halo: Combat Evolved", "openspy"),
        ("swat4", "SWAT 4", "openspy"),
        ("nwn", "Neverwinter Nights", "openspy"),
        ("avp", "Aliens versus Predator Classic 2000", "openspy"),
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

    cache_servers(state, gamename, &out).await?;
    Ok(out.len())
}

async fn cache_servers(
    state: &AppState,
    gamename: &str,
    out: &[ServerOut],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let payload = serde_json::to_string(out)?;
    let mut redis = state.redis.clone();
    let _: () = redis::cmd("SET")
        .arg(format!("oa:servers:{gamename}"))
        .arg(payload)
        .arg("EX")
        .arg(600)
        .query_async(&mut redis)
        .await?;
    Ok(())
}

// ===========================================================================
// Valve ingester — Steam Web API GetServerList (CS 1.6, TFC, DoD).
// Valve retired the public UDP master, so this uses the Web API, which needs a
// free key (https://steamcommunity.com/dev/apikey) in STEAM_API_KEY. Without a
// key the valve games simply stay empty until it's set.
// ===========================================================================
// Filter by Steam appid, not gamedir — the GoldSrc and Source games share
// gamedir names (cstrike, dod), so gamedir alone leaks the Source versions.
fn valve_appid(gamename: &str) -> Option<u32> {
    match gamename {
        "cstrike" => Some(10), // Counter-Strike 1.6
        "tfc" => Some(20),     // Team Fortress Classic
        "dod" => Some(30),     // Day of Defeat
        _ => None,
    }
}

#[derive(Deserialize)]
struct SteamServer {
    addr: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    map: Option<String>,
    #[serde(default)]
    gametype: Option<String>,
    #[serde(default)]
    players: Option<i64>,
    #[serde(default)]
    max_players: Option<i64>,
}

async fn poll_valve(state: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let key = match std::env::var("STEAM_API_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => {
            tracing::debug!("STEAM_API_KEY unset — skipping valve games");
            return Ok(());
        }
    };

    let client = state.pool.get().await?;
    let rows = client
        .query("SELECT id, gamename FROM games WHERE query_proto = 'valve' AND supported", &[])
        .await?;

    for row in rows {
        let game_id: i32 = row.get(0);
        let gamename: String = row.get(1);
        let appid = match valve_appid(&gamename) {
            Some(a) => a,
            None => continue,
        };

        let body: Value = state
            .http
            .get("https://api.steampowered.com/IGameServersService/GetServerList/v1/")
            .query(&[
                ("key", key.as_str()),
                ("filter", &format!("\\appid\\{appid}")),
                ("limit", "1000"),
            ])
            .timeout(Duration::from_secs(20))
            .send()
            .await?
            .json()
            .await?;

        let list = body["response"]["servers"].as_array().cloned().unwrap_or_default();
        let mut out: Vec<ServerOut> = Vec::new();
        for v in list {
            let s: SteamServer = match serde_json::from_value(v) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let (ip_str, port) = match s.addr.rsplit_once(':') {
                Some((ip, p)) => (ip.to_string(), p.parse::<i32>().unwrap_or(0)),
                None => continue,
            };
            let ip: IpAddr = match ip_str.parse() {
                Ok(ip) => ip,
                Err(_) => continue,
            };
            let name = clean(s.name);
            let map = clean(s.map);
            let gametype = clean(s.gametype);
            let players = s.players.map(|v| v as i32);
            let max_players = s.max_players.map(|v| v as i32);
            client
                .execute(
                    "INSERT INTO servers
                       (game_id, address, port, name, map, gametype, players, max_players, source, last_seen_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'valve', now())
                     ON CONFLICT (game_id, address, port) DO UPDATE SET
                       name=EXCLUDED.name, map=EXCLUDED.map, gametype=EXCLUDED.gametype,
                       players=EXCLUDED.players, max_players=EXCLUDED.max_players,
                       source=EXCLUDED.source, last_seen_at=now()",
                    &[&game_id, &ip, &port, &name, &map, &gametype, &players, &max_players],
                )
                .await?;
            out.push(ServerOut {
                address: ip_str,
                port,
                name,
                map,
                gametype,
                players,
                max_players,
                source: "valve".into(),
            });
        }
        cache_servers(state, &gamename, &out).await?;
        tracing::info!("{gamename}: {} servers (valve)", out.len());
    }
    Ok(())
}

// ===========================================================================
// QuakeWorld ingester (Quake 1 MP) — the community hub JSON API (no key).
// ===========================================================================
async fn poll_quakeworld(
    state: &AppState,
    game_id: i32,
    gamename: &str,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let body: Value = state
        .http
        .get("https://hubapi.quakeworld.nu/v2/servers")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .json()
        .await?;
    let list = body.as_array().cloned().unwrap_or_default();
    let client = state.pool.get().await?;
    let mut out: Vec<ServerOut> = Vec::new();
    for v in list {
        let addr = v["address"].as_str().unwrap_or("");
        let (ip_str, port) = match addr.rsplit_once(':') {
            Some((i, p)) => (i.to_string(), p.parse::<i32>().unwrap_or(0)),
            None => continue,
        };
        let ip: IpAddr = match ip_str.parse() {
            Ok(ip) => ip,
            Err(_) => continue,
        };
        let s = &v["settings"];
        let name = clean(s["hostname"].as_str().map(|x| x.to_string()));
        let map = clean(s["map"].as_str().map(|x| x.to_string()));
        let players = v["clients"].as_array().map(|a| a.len() as i32);
        let max_players = s["maxclients"].as_str().and_then(|x| x.parse::<i32>().ok());
        upsert_server(&client, game_id, ip, port, &name, &map, &None, players, max_players, "quakeworld").await?;
        out.push(ServerOut { address: ip_str, port, name, map, gametype: None, players, max_players, source: "quakeworld".into() });
    }
    cache_servers(state, gamename, &out).await?;
    Ok(out.len())
}

// ===========================================================================
// Quake III Arena ingester — id master getservers + per-server getstatus (UDP).
// ===========================================================================
const Q3_MASTER: &str = "master.ioquake3.org";

async fn q3_getservers(master: &str) -> Result<Vec<SocketAddrV4>, Box<dyn std::error::Error + Send + Sync>> {
    let sock = UdpSocket::bind("0.0.0.0:0").await?;
    sock.connect((master, 27950)).await?;
    sock.send(b"\xff\xff\xff\xffgetservers 68 empty full\0").await?;
    let mut all: Vec<SocketAddrV4> = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = match timeout(Duration::from_secs(3), sock.recv(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => break,
        };
        let data = &buf[..n];
        // entries begin after "getserversResponse"; each is '\' + 4-byte ip + 2-byte port
        let start = data.windows(18).position(|w| w == b"getserversResponse").map(|p| p + 18).unwrap_or(0);
        let mut j = start;
        let mut eot = false;
        while j + 7 <= n {
            if data[j] == b'\\' {
                if &data[j + 1..j + 4] == b"EOT" { eot = true; break; }
                let ip = Ipv4Addr::new(data[j + 1], data[j + 2], data[j + 3], data[j + 4]);
                let port = u16::from_be_bytes([data[j + 5], data[j + 6]]);
                if port != 0 { all.push(SocketAddrV4::new(ip, port)); }
                j += 7;
            } else {
                j += 1;
            }
        }
        if eot || all.len() > 2000 { break; }
    }
    Ok(all)
}

async fn q3_getstatus(addr: SocketAddrV4) -> Option<A2sInfo> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    sock.connect(addr).await.ok()?;
    sock.send(b"\xff\xff\xff\xffgetstatus\0").await.ok()?;
    let mut buf = [0u8; 4096];
    let n = timeout(Duration::from_secs(1), sock.recv(&mut buf)).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let idx = text.find("statusResponse")?;
    let rest = text[idx + "statusResponse".len()..].trim_start_matches(['\n', '\r']);
    let mut lines = rest.split('\n');
    let info = lines.next()?;
    let mut kv = HashMap::new();
    let parts: Vec<&str> = info.trim_start_matches('\\').split('\\').collect();
    let mut it = parts.into_iter();
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        kv.insert(k.to_string(), v.to_string());
    }
    let players = lines.filter(|l| !l.trim().is_empty()).count() as i32;
    Some(A2sInfo {
        name: kv.get("sv_hostname").cloned(),
        map: kv.get("mapname").cloned(),
        players: Some(players),
        max: kv.get("sv_maxclients").and_then(|s| s.parse::<i32>().ok()),
    })
}

async fn poll_quake3(
    state: &AppState,
    game_id: i32,
    gamename: &str,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let addrs = q3_getservers(Q3_MASTER).await?;
    let details = futures::stream::iter(addrs.into_iter().map(|sa| async move { (sa, q3_getstatus(sa).await) }))
        .buffer_unordered(64)
        .collect::<Vec<_>>()
        .await;
    let client = state.pool.get().await?;
    let mut out: Vec<ServerOut> = Vec::new();
    for (sa, d) in details {
        let info = match d {
            Some(i) if i.name.is_some() => i,
            _ => continue,
        };
        let ip = IpAddr::V4(*sa.ip());
        let port = sa.port() as i32;
        let name = clean(info.name);
        let map = clean(info.map);
        upsert_server(&client, game_id, ip, port, &name, &map, &None, info.players, info.max, "quake3").await?;
        out.push(ServerOut { address: sa.ip().to_string(), port, name, map, gametype: None, players: info.players, max_players: info.max, source: "quake3".into() });
    }
    cache_servers(state, gamename, &out).await?;
    Ok(out.len())
}

struct A2sInfo {
    name: Option<String>,
    map: Option<String>,
    players: Option<i32>,
    max: Option<i32>,
}

// ===========================================================================
// Quake II ingester — q2servers.com raw list + per-server Q2 status query.
// ===========================================================================
async fn q2_status(addr: SocketAddrV4) -> Option<A2sInfo> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    sock.connect(addr).await.ok()?;
    sock.send(b"\xff\xff\xff\xffstatus\0").await.ok()?;
    let mut buf = [0u8; 4096];
    let n = timeout(Duration::from_secs(1), sock.recv(&mut buf)).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let idx = text.find("print")?;
    let rest = text[idx + "print".len()..].trim_start_matches(['\n', '\r']);
    let mut lines = rest.split('\n');
    let info = lines.next()?;
    let mut kv = HashMap::new();
    let parts: Vec<&str> = info.trim_start_matches('\\').split('\\').collect();
    let mut it = parts.into_iter();
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        kv.insert(k.to_string(), v.to_string());
    }
    let players = lines.filter(|l| !l.trim().is_empty()).count() as i32;
    Some(A2sInfo {
        name: kv.get("hostname").cloned(),
        map: kv.get("mapname").cloned(),
        players: Some(players),
        max: kv.get("maxclients").and_then(|s| s.parse::<i32>().ok()),
    })
}

async fn poll_quake2(
    state: &AppState,
    game_id: i32,
    gamename: &str,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    // NOTE: q2servers.com's HTTPS cert is expired — use plain HTTP (it doesn't
    // redirect) so the fetch doesn't fail cert verification.
    let text = state
        .http
        .get("http://q2servers.com/?raw=1")
        .timeout(Duration::from_secs(20))
        .send()
        .await?
        .text()
        .await?;
    let addrs: Vec<SocketAddrV4> = text.lines().filter_map(|l| l.trim().parse::<SocketAddrV4>().ok()).collect();
    let details = futures::stream::iter(addrs.into_iter().map(|sa| async move { (sa, q2_status(sa).await) }))
        .buffer_unordered(64)
        .collect::<Vec<_>>()
        .await;
    let client = state.pool.get().await?;
    let mut out: Vec<ServerOut> = Vec::new();
    for (sa, d) in details {
        let info = match d {
            Some(i) if i.name.is_some() => i,
            _ => continue,
        };
        let ip = IpAddr::V4(*sa.ip());
        let port = sa.port() as i32;
        let name = clean(info.name);
        let map = clean(info.map);
        upsert_server(&client, game_id, ip, port, &name, &map, &None, info.players, info.max, "quake2").await?;
        out.push(ServerOut { address: sa.ip().to_string(), port, name, map, gametype: None, players: info.players, max_players: info.max, source: "quake2".into() });
    }
    cache_servers(state, gamename, &out).await?;
    Ok(out.len())
}

#[allow(clippy::too_many_arguments)]
async fn upsert_server(
    client: &deadpool_postgres::Client,
    game_id: i32,
    ip: IpAddr,
    port: i32,
    name: &Option<String>,
    map: &Option<String>,
    gametype: &Option<String>,
    players: Option<i32>,
    max_players: Option<i32>,
    source: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    client
        .execute(
            "INSERT INTO servers
               (game_id, address, port, name, map, gametype, players, max_players, source, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
             ON CONFLICT (game_id, address, port) DO UPDATE SET
               name=EXCLUDED.name, map=EXCLUDED.map, gametype=EXCLUDED.gametype,
               players=EXCLUDED.players, max_players=EXCLUDED.max_players,
               source=EXCLUDED.source, last_seen_at=now()",
            &[&game_id, &ip, &port, name, map, gametype, &players, &max_players, &source],
        )
        .await?;
    Ok(())
}

async fn poll_quake(state: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = state.pool.get().await?;
    let rows = client
        .query("SELECT id, gamename, query_proto FROM games WHERE query_proto IN ('quake','quake2','quake3') AND supported", &[])
        .await?;
    for row in rows {
        let game_id: i32 = row.get(0);
        let gamename: String = row.get(1);
        let proto: String = row.get(2);
        let res = match proto.as_str() {
            "quake3" => poll_quake3(state, game_id, &gamename).await,
            "quake2" => poll_quake2(state, game_id, &gamename).await,
            _ => poll_quakeworld(state, game_id, &gamename).await,
        };
        match res {
            Ok(n) => tracing::info!("{gamename}: {n} servers ({proto})"),
            Err(e) => tracing::warn!("{gamename} ({proto}) failed: {e}"),
        }
    }
    Ok(())
}

// ===========================================================================
// OpenSpy ingester — gslist gets the list from master.openspy.net (encrypted
// SB protocol, per-game secret keys via gslist.cfg); then a GameSpy \status\
// query per server for live details. Covers SWAT 4, the Battlefields, AvP, etc.
// ===========================================================================
async fn gs_status(addr: SocketAddrV4) -> Option<A2sInfo> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    sock.connect(addr).await.ok()?;
    sock.send(b"\\status\\").await.ok()?;
    let mut buf = [0u8; 16384];
    let n = timeout(Duration::from_secs(1), sock.recv(&mut buf)).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let body = text.split("\\final\\").next().unwrap_or(&text);
    let parts: Vec<&str> = body.trim_start_matches('\\').split('\\').collect();
    let mut kv = HashMap::new();
    let mut it = parts.into_iter();
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        kv.insert(k.to_string(), v.to_string());
    }
    kv.get("hostname")?;
    Some(A2sInfo {
        name: kv.get("hostname").cloned(),
        map: kv.get("mapname").cloned(),
        players: kv.get("numplayers").and_then(|s| s.parse::<i32>().ok()),
        max: kv.get("maxplayers").and_then(|s| s.parse::<i32>().ok()),
    })
}

async fn poll_openspy(state: &AppState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let gslist_dir = std::env::var("GSLIST_DIR").unwrap_or_else(|_| "/opt/gslist".into());
    let gslist_bin = format!("{gslist_dir}/gslist");
    if !std::path::Path::new(&gslist_bin).exists() {
        tracing::debug!("gslist not found at {gslist_bin} — skipping openspy games");
        return Ok(());
    }
    let client = state.pool.get().await?;
    let rows = client
        .query("SELECT id, gamename FROM games WHERE query_proto = 'openspy' AND supported", &[])
        .await?;

    for row in rows {
        let game_id: i32 = row.get(0);
        let gamename: String = row.get(1);
        let output = tokio::process::Command::new(&gslist_bin)
            .args(["-n", &gamename, "-x", "master.openspy.net"])
            .current_dir(&gslist_dir)
            .output()
            .await;
        let out = match output {
            Ok(o) => o,
            Err(e) => {
                tracing::warn!("gslist {gamename}: {e}");
                continue;
            }
        };
        let text = String::from_utf8_lossy(&out.stdout);
        let addrs: Vec<SocketAddrV4> = text
            .lines()
            .filter_map(|l| {
                let p: Vec<&str> = l.split_whitespace().collect();
                if p.len() == 2 {
                    format!("{}:{}", p[0], p[1]).parse().ok()
                } else {
                    None
                }
            })
            .collect();

        let details = futures::stream::iter(addrs.into_iter().map(|sa| async move { (sa, gs_status(sa).await) }))
            .buffer_unordered(64)
            .collect::<Vec<_>>()
            .await;

        let mut serv: Vec<ServerOut> = Vec::new();
        for (sa, d) in details {
            let info = match d {
                Some(i) if i.name.is_some() => i,
                _ => continue,
            };
            let ip = IpAddr::V4(*sa.ip());
            let port = sa.port() as i32;
            let name = clean(info.name);
            let map = clean(info.map);
            upsert_server(&client, game_id, ip, port, &name, &map, &None, info.players, info.max, "openspy").await?;
            serv.push(ServerOut { address: sa.ip().to_string(), port, name, map, gametype: None, players: info.players, max_players: info.max, source: "openspy".into() });
        }
        cache_servers(state, &gamename, &serv).await?;
        tracing::info!("{gamename}: {} servers (openspy)", serv.len());
    }
    Ok(())
}

// ===========================================================================
// Per-server player queries — for the "server details" panel.
// Valve A2S_PLAYER yields each player's connection time; GameSpy/Quake give
// name + score + ping.
// ===========================================================================
#[derive(Serialize)]
struct PlayerOut {
    name: String,
    score: Option<i64>,
    ping: Option<i64>,
    time: Option<f64>, // seconds connected (Valve only)
}

fn read_cstr(buf: &[u8], pos: &mut usize) -> String {
    let start = *pos;
    while *pos < buf.len() && buf[*pos] != 0 {
        *pos += 1;
    }
    let s = String::from_utf8_lossy(&buf[start..*pos]).to_string();
    if *pos < buf.len() {
        *pos += 1;
    }
    s
}

async fn a2s_players(addr: SocketAddrV4) -> Vec<PlayerOut> {
    let sock = match UdpSocket::bind("0.0.0.0:0").await {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    if sock.connect(addr).await.is_err() {
        return vec![];
    }
    let mut req: Vec<u8> = vec![0xFF, 0xFF, 0xFF, 0xFF, 0x55, 0xFF, 0xFF, 0xFF, 0xFF];
    let mut buf = [0u8; 8192];
    for _ in 0..2 {
        if sock.send(&req).await.is_err() {
            return vec![];
        }
        let n = match timeout(Duration::from_secs(1), sock.recv(&mut buf)).await {
            Ok(Ok(n)) => n,
            _ => return vec![],
        };
        if n < 5 {
            return vec![];
        }
        match buf[4] {
            0x41 if n >= 9 => {
                req = vec![0xFF, 0xFF, 0xFF, 0xFF, 0x55];
                req.extend_from_slice(&buf[5..9]);
            }
            0x44 => {
                let mut out = Vec::new();
                let count = buf[5] as usize;
                let mut pos = 6;
                for _ in 0..count {
                    if pos >= n {
                        break;
                    }
                    pos += 1; // index byte
                    let name = read_cstr(&buf[..n], &mut pos);
                    if pos + 8 > n {
                        break;
                    }
                    let score = i32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as i64;
                    pos += 4;
                    let dur = f32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as f64;
                    pos += 4;
                    out.push(PlayerOut { name: clean(Some(name)).unwrap_or_default(), score: Some(score), ping: None, time: Some(dur) });
                }
                return out;
            }
            _ => return vec![],
        }
    }
    vec![]
}

async fn gs_players(addr: SocketAddrV4) -> Vec<PlayerOut> {
    let sock = match UdpSocket::bind("0.0.0.0:0").await {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    if sock.connect(addr).await.is_err() || sock.send(b"\\status\\").await.is_err() {
        return vec![];
    }
    let mut buf = [0u8; 16384];
    let n = match timeout(Duration::from_secs(1), sock.recv(&mut buf)).await {
        Ok(Ok(n)) => n,
        _ => return vec![],
    };
    let text = String::from_utf8_lossy(&buf[..n]);
    let body = text.split("\\final\\").next().unwrap_or(&text);
    let parts: Vec<&str> = body.trim_start_matches('\\').split('\\').collect();
    let mut kv = HashMap::new();
    let mut it = parts.into_iter();
    while let (Some(k), Some(v)) = (it.next(), it.next()) {
        kv.insert(k.to_string(), v.to_string());
    }
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let name = kv.get(&format!("player_{i}")).or_else(|| kv.get(&format!("playername_{i}")));
        match name {
            Some(nm) if !nm.is_empty() => {
                let score = kv.get(&format!("score_{i}")).or_else(|| kv.get(&format!("frags_{i}"))).and_then(|s| s.parse().ok());
                let ping = kv.get(&format!("ping_{i}")).and_then(|s| s.parse().ok());
                out.push(PlayerOut { name: clean(Some(nm.clone())).unwrap_or_default(), score, ping, time: None });
                i += 1;
            }
            _ => break,
        }
    }
    out
}

async fn quake_query(addr: SocketAddrV4, req: &[u8]) -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    sock.connect(addr).await.ok()?;
    sock.send(req).await.ok()?;
    let mut buf = [0u8; 16384];
    let n = timeout(Duration::from_secs(1), sock.recv(&mut buf)).await.ok()?.ok()?;
    Some(String::from_utf8_lossy(&buf[..n]).to_string())
}

fn parse_quake_players(text: &str, header: &str) -> Vec<PlayerOut> {
    let idx = match text.find(header) {
        Some(i) => i,
        None => return vec![],
    };
    let rest = text[idx + header.len()..].trim_start_matches(['\n', '\r']);
    let mut out = Vec::new();
    for line in rest.split('\n').skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let (Some(a), Some(b)) = (line.find('"'), line.rfind('"')) {
            if b > a {
                let name = line[a + 1..b].to_string();
                let nums: Vec<&str> = line[..a].split_whitespace().collect();
                out.push(PlayerOut {
                    name: clean(Some(name)).unwrap_or_default(),
                    score: nums.first().and_then(|s| s.parse().ok()),
                    ping: nums.get(1).and_then(|s| s.parse().ok()),
                    time: None,
                });
            }
        }
    }
    out
}

async fn q3_players(addr: SocketAddrV4) -> Vec<PlayerOut> {
    match quake_query(addr, b"\xff\xff\xff\xffgetstatus\0").await {
        Some(t) => parse_quake_players(&t, "statusResponse"),
        None => vec![],
    }
}
async fn q2_players(addr: SocketAddrV4) -> Vec<PlayerOut> {
    match quake_query(addr, b"\xff\xff\xff\xffstatus\0").await {
        Some(t) => parse_quake_players(&t, "print"),
        None => vec![],
    }
}

#[derive(Deserialize)]
struct DetailQuery {
    game: String,
    addr: String,
    port: u16,
}

async fn details(State(state): State<AppState>, Query(q): Query<DetailQuery>) -> impl IntoResponse {
    let ip: std::net::Ipv4Addr = match q.addr.parse() {
        Ok(ip) => ip,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad addr").into_response(),
    };
    let sa = SocketAddrV4::new(ip, q.port);
    let client = match state.pool.get().await {
        Ok(c) => c,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    let proto: String = match client
        .query_opt("SELECT query_proto FROM games WHERE gamename = $1", &[&q.game])
        .await
    {
        Ok(Some(r)) => r.get(0),
        _ => "gamespy".to_string(),
    };
    let players = match proto.as_str() {
        "valve" => a2s_players(sa).await,
        "quake3" => q3_players(sa).await,
        "quake" | "quake2" => q2_players(sa).await,
        "333networks" => {
            // UT-family: GameSpy query lives on the query port (game port + 1).
            let mut p = gs_players(SocketAddrV4::new(ip, q.port + 1)).await;
            if p.is_empty() {
                p = gs_players(sa).await;
            }
            p
        }
        _ => gs_players(sa).await, // openspy / gamespy
    };
    Json(json!({ "game": q.game, "addr": q.addr, "port": q.port, "players": players })).into_response()
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
    poker: HashMap<String, poker::Table>,
}

impl Hub {
    /// Deliver poker engine output: broadcast to the room, or private to a nick.
    fn deliver_poker(&self, room: &str, outs: Vec<poker::Out>) {
        for o in outs {
            let mut m = o.msg;
            if let Some(obj) = m.as_object_mut() {
                obj.insert("type".into(), json!("poker"));
                obj.insert("room".into(), json!(room));
            }
            let s = m.to_string();
            match o.to {
                None => self.broadcast(room, &s),
                Some(target) => {
                    for (id, c) in &self.conns {
                        if c.nick == target {
                            let _ = c.tx.send(s.clone());
                            let _ = id;
                        }
                    }
                }
            }
        }
    }
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
        // Poker — server-authoritative table (private hole cards).
        "poker" => {
            if let Some(room) = room {
                if room.starts_with("parlor-poker") {
                    let nick = hub.nick_of(id);
                    let outs = {
                        let table = hub.poker.entry(room.clone()).or_insert_with(poker::Table::new);
                        table.handle(&nick, &v)
                    };
                    hub.deliver_poker(&room, outs);
                    if hub.poker.get(&room).map(|t| t.is_empty()).unwrap_or(false) {
                        hub.poker.remove(&room);
                    }
                }
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
    for r in &rooms {
        if r.starts_with("parlor-poker") {
            let outs = hub.poker.get_mut(r).map(|t| t.handle(&nick, &json!({ "do": "leave" }))).unwrap_or_default();
            hub.deliver_poker(r, outs);
            if hub.poker.get(r).map(|t| t.is_empty()).unwrap_or(false) {
                hub.poker.remove(r);
            }
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
