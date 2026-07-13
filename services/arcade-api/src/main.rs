//! arcade-api — the brain of OpenArcade.
//!
//! Phase 1 stands up the HTTP + WebSocket surface the client connects to:
//!   GET /health   -> liveness
//!   GET /ws       -> the client's live channel (server lists, presence, chat)
//!
//! Phase 2 hangs the poller off this: ingest OpenSpy + 333networks + arcade-core,
//! run A2S / \status\ detail probes, cache in Redis, and push updates over /ws.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "arcade_api=info,tower_http=info".into()),
        )
        .init();

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws_upgrade))
        .layer(CorsLayer::permissive());

    let addr = std::env::var("ARCADE_API_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("bind arcade-api");

    tracing::info!("arcade-api listening on {addr}");
    axum::serve(listener, app).await.expect("serve arcade-api");
}

async fn health() -> impl IntoResponse {
    Json(json!({ "ok": true, "service": "arcade-api", "version": "0.0.1" }))
}

async fn ws_upgrade(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    // Greet the client so the shell can confirm the round-trip.
    let hello = json!({ "type": "welcome", "service": "arcade-api" }).to_string();
    if socket.send(Message::Text(hello)).await.is_err() {
        return;
    }

    // Echo loop placeholder — replaced by the pub/sub server-list feed in Phase 2.
    while let Some(Ok(msg)) = socket.recv().await {
        match msg {
            Message::Text(text) => {
                tracing::debug!("client: {text}");
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
