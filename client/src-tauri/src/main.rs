// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;

#[derive(Serialize)]
struct Ping {
    ok: bool,
    service: &'static str,
}

/// Placeholder command so the JS side has something to invoke while the real
/// query/launch commands are built out in later phases.
#[tauri::command]
fn ping() -> Ping {
    Ping { ok: true, service: "openarcade-client" }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running OpenArcade");
}
