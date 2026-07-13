#!/usr/bin/env bash
# Launch the OpenArcade desktop client.
# The app is built inside the `openarcade-dev` distrobox (WebKitGTK + Rust);
# this runs it there so it picks up the right libs, on your host display.
set -euo pipefail

BIN="$HOME/openarcade/client/src-tauri/target/release/openarcade"

if [ ! -x "$BIN" ]; then
  echo "Client not built yet. Building..."
  distrobox enter openarcade-dev -- bash -lc '
    source "$HOME/.cargo/env"
    cd ~/openarcade/client && npm install --no-audit --no-fund && npm run build
    cd src-tauri && cargo build --release'
fi

# WEBKIT_DISABLE_DMABUF_RENDERER avoids a blank window on some NVIDIA setups.
exec distrobox enter openarcade-dev -- bash -lc '
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
  exec ~/openarcade/client/src-tauri/target/release/openarcade'
