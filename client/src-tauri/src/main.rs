// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;

#[derive(Serialize)]
struct Ping {
    ok: bool,
    service: &'static str,
}

#[tauri::command]
fn ping() -> Ping {
    Ping { ok: true, service: "openarcade-client" }
}

/// Launch-and-join: spawn a program with args (the game, or a URL opener).
#[tauri::command]
fn launch(program: String, args: Vec<String>) -> Result<(), String> {
    std::process::Command::new(&program)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("{program}: {e}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, launch])
        .run(tauri::generate_context!())
        .expect("error while running OpenArcade");
}
