// OpenArcade client shell. Phase 1: connect to arcade-api over WebSocket and
// prove the round-trip. Real tab views land in later phases.

const API_WS = import.meta.env.VITE_ARCADE_WS ?? "ws://localhost:8080/ws";

const statusEl = () => document.getElementById("status");

function connect() {
  let ws;
  try {
    ws = new WebSocket(API_WS);
  } catch (err) {
    statusEl().textContent = `Could not reach arcade-api at ${API_WS}`;
    return;
  }

  ws.addEventListener("open", () => {
    statusEl().textContent = "Connected to arcade-api ✓";
    ws.send(JSON.stringify({ type: "hello", client: "openarcade", v: "0.0.1" }));
  });

  ws.addEventListener("message", (ev) => {
    console.debug("arcade-api:", ev.data);
  });

  ws.addEventListener("close", () => {
    statusEl().textContent = "Disconnected from arcade-api — retrying…";
    setTimeout(connect, 3000);
  });

  ws.addEventListener("error", () => {
    statusEl().textContent = `arcade-api unreachable at ${API_WS}`;
  });
}

function wireTabs() {
  const tabs = document.querySelectorAll("#tabs .tab");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabs.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("view").dataset.tab = btn.dataset.tab;
    });
  });
}

wireTabs();
connect();
