import { defineConfig } from "vite";

// Tauri serves the built client; keep the dev server on a fixed port so the
// Rust side can point at it.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
});
