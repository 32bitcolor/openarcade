// OpenArcade desktop client — faithful GameSpy Arcade loop:
// pick a game -> enter its room -> live server browser + chat lobby + member list.
// Parlor games (chess/checkers/reversi) enter the same room shell with a board
// in place of the server browser.

import { PARLOR_GAMES, createParlorSession } from "./parlor.js";

const API = localStorage.getItem("oa_api") || "http://10.0.1.44:8080";
const WS_URL = API.replace(/^http/, "ws") + "/ws";

const state = {
  games: [],
  current: null, // gamename or parlor:<key>
  room: null, // room channel for current game
  mode: "server", // "server" | "parlor"
  parlor: null, // active parlor session
  servers: [],
  members: [],
  nick: "guest",
  ws: null,
  sort: { key: "players", dir: -1 },
  filters: { empty: false, full: false, search: "" },
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();

async function init() {
  wireToolbar();
  wireChat();
  wireFilters();
  $("nick").addEventListener("click", changeNick);
  $("btn-refresh").addEventListener("click", () => state.current && loadServers(state.current));
  await loadGames();
  connectWS();
  setInterval(loadGames, 60000); // refresh rail counts
}

// ---------------------------------------------------------------------------
// Games rail
// ---------------------------------------------------------------------------
async function loadGames() {
  try {
    const r = await fetch(`${API}/games`);
    const d = await r.json();
    state.games = d.games || [];
    renderRail();
    const live = state.games.reduce((a, g) => a + (g.servers || 0), 0);
    const players = state.games.reduce((a, g) => a + (g.players || 0), 0);
    $("home-stat").textContent = `${live.toLocaleString()} servers online · ${players.toLocaleString()} players right now`;
  } catch (e) {
    $("conn-text").textContent = "API unreachable";
  }
}

function iconFor(title) {
  return (title || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function renderRail() {
  const list = $("gamelist");
  const withServers = state.games.filter((g) => g.servers > 0);
  const empty = state.games.filter((g) => !g.servers);
  list.innerHTML = "";
  const addRow = (g) => {
    const row = document.createElement("div");
    row.className = "game-row" + (g.gamename === state.current ? " sel" : "");
    row.innerHTML = `<span class="ico">${iconFor(g.title)}</span>
      <span class="name">${escapeHtml(g.title)}</span>
      <span class="count">${g.servers || 0}</span>`;
    row.title = `${g.title} — ${g.servers} servers, ${g.players} players (${g.source})`;
    row.addEventListener("click", () => selectGame(g.gamename));
    list.appendChild(row);
  };
  if (withServers.length) {
    addGroup(list, "Active");
    withServers.forEach(addRow);
  }
  if (empty.length) {
    addGroup(list, "More games");
    empty.forEach(addRow);
  }
  // Parlor games — the classic hosted casual games.
  addGroup(list, "Parlor Games");
  PARLOR_GAMES.forEach((p) => {
    const id = `parlor:${p.key}`;
    const row = document.createElement("div");
    row.className = "game-row" + (id === state.current ? " sel" : "");
    row.innerHTML = `<span class="ico" style="background:#7a4fd0">♟</span>
      <span class="name">${escapeHtml(p.title)}</span>
      <span class="count">${p.ready ? "" : "soon"}</span>`;
    row.addEventListener("click", () => selectGame(id));
    list.appendChild(row);
  });
}

function addGroup(list, label) {
  const g = document.createElement("div");
  g.className = "rail-group";
  g.textContent = label;
  list.appendChild(g);
}

// ---------------------------------------------------------------------------
// Room view
// ---------------------------------------------------------------------------
function leaveCurrent() {
  if (state.room) wsSend({ type: "leave", room: state.room });
  if (state.parlor) { state.parlor.destroy(); state.parlor = null; }
}

function enterRoomShell(title, sub) {
  state.servers = [];
  state.members = [];
  renderRail();
  $("home").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("room-title").textContent = title;
  $("room-sub").textContent = sub;
  $("chatlog").innerHTML = "";
  $("memberlist").innerHTML = "";
}

function selectGame(id) {
  if (id.startsWith("parlor:")) return enterParlor(id.slice(7));

  const g = state.games.find((x) => x.gamename === id);
  if (!g) return;
  leaveCurrent();

  state.mode = "server";
  state.current = id;
  state.room = `game-${id}`;
  $("parlorwrap").classList.add("hidden");
  $("browserwrap").classList.remove("hidden");
  enterRoomShell(g.title, `${g.source} · room #${state.room}`);
  sysLine(`Entered the ${g.title} room.`);

  wsSend({ type: "join", room: state.room });
  loadServers(id);
}

function enterParlor(key) {
  const p = PARLOR_GAMES.find((x) => x.key === key);
  if (!p) return;
  leaveCurrent();

  state.mode = "parlor";
  state.current = `parlor:${key}`;
  state.room = `parlor-${key}`;
  $("browserwrap").classList.add("hidden");
  $("parlorwrap").classList.remove("hidden");
  enterRoomShell(p.title, `parlor game · room #${state.room}`);
  sysLine(`Sat down at ${p.title}. Take a seat to play.`);

  wsSend({ type: "join", room: state.room });
  const send = (payload) => wsSend({ type: "game", room: state.room, g: payload });
  const pokerSend = (payload) => wsSend({ type: "poker", room: state.room, ...payload });
  state.parlor = createParlorSession(key, $("parlorboard"), $("parlor-controls"), {
    send,
    pokerSend,
    getNick: () => state.nick,
  });
}

async function loadServers(gamename) {
  $("srv-count").textContent = "loading…";
  try {
    const r = await fetch(`${API}/servers/${encodeURIComponent(gamename)}`);
    state.servers = await r.json();
  } catch (e) {
    state.servers = [];
  }
  renderBrowser();
}

const COLUMNS = [
  { key: "_status", label: "", cls: "col-status", sortable: false },
  { key: "name", label: "Server Name", cls: "namecell" },
  { key: "players", label: "Players", cls: "col-players" },
  { key: "map", label: "Map" },
  { key: "gametype", label: "Type" },
  { key: "address", label: "Address", cls: "col-addr" },
];

function renderBrowser() {
  // header
  const head = $("browser-head");
  head.innerHTML = "";
  COLUMNS.forEach((c) => {
    const th = document.createElement("th");
    th.className = c.cls || "";
    const arrow = state.sort.key === c.key ? `<span class="arrow">${state.sort.dir < 0 ? "▼" : "▲"}</span>` : "";
    th.innerHTML = `${c.label} ${arrow}`;
    if (c.sortable !== false) th.addEventListener("click", () => setSort(c.key));
    head.appendChild(th);
  });

  // filter + sort
  let rows = state.servers.slice();
  const f = state.filters;
  if (f.empty) rows = rows.filter((s) => (s.players || 0) > 0);
  if (f.full) rows = rows.filter((s) => !(s.max_players && s.players >= s.max_players));
  if (f.search) {
    const q = f.search.toLowerCase();
    rows = rows.filter((s) => (s.name || "").toLowerCase().includes(q) || (s.map || "").toLowerCase().includes(q));
  }
  const k = state.sort.key, dir = state.sort.dir;
  rows.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === "players") { av = a.players || 0; bv = b.players || 0; }
    av = av == null ? "" : av; bv = bv == null ? "" : bv;
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });

  const body = $("browser-body");
  body.innerHTML = "";
  for (const s of rows) {
    const full = s.max_players && s.players >= s.max_players;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-status"><span class="mon ${full ? "full" : "open"}" title="${full ? "Full" : "Joinable"}">${full ? "▣" : "▢"}</span></td>
      <td class="namecell" title="${escapeHtml(s.name || "")}">${escapeHtml(s.name || "(unnamed)")}</td>
      <td class="col-players">${s.players ?? 0}/${s.max_players ?? "?"}</td>
      <td title="${escapeHtml(s.map || "")}">${escapeHtml(s.map || "—")}</td>
      <td>${escapeHtml(s.gametype || "—")}</td>
      <td class="col-addr">${s.address}:${s.port}</td>`;
    tr.addEventListener("dblclick", () => joinServer(s));
    tr.addEventListener("click", () => {
      body.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
      tr.classList.add("sel");
    });
    body.appendChild(tr);
  }
  $("srv-count").textContent = `${rows.length} of ${state.servers.length} servers`;
}

function setSort(key) {
  if (state.sort.key === key) state.sort.dir *= -1;
  else state.sort = { key, dir: key === "players" ? -1 : 1 };
  renderBrowser();
}

function joinServer(s) {
  // Launch-and-join profiles land next; for now surface the connect target.
  const line = `${s.name || "server"} — ${s.address}:${s.port}`;
  sysLine(`Join requested: ${line}. (Launch-and-join profiles coming — this will boot the game and connect you.)`);
}

// ---------------------------------------------------------------------------
// Chat + members (WebSocket)
// ---------------------------------------------------------------------------
function connectWS() {
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  ws.onopen = () => {
    setConn(true);
    if (state.nick && state.nick !== "guest") wsSend({ type: "hello", nick: state.nick });
    if (state.room) wsSend({ type: "join", room: state.room });
  };
  ws.onclose = () => { setConn(false); setTimeout(connectWS, 3000); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onWs(m);
  };
}

function onWs(m) {
  switch (m.type) {
    case "welcome":
      state.nick = m.nick; $("nick").textContent = m.nick; break;
    case "nick":
      state.nick = m.nick; $("nick").textContent = m.nick; break;
    case "members":
      if (m.room === state.room) renderMembers(m.members); break;
    case "join":
      if (m.room === state.room && m.nick !== state.nick) sysLine(`${m.nick} joined.`); break;
    case "leave":
      if (m.room === state.room) sysLine(`${m.nick} left.`); break;
    case "chat":
      if (m.room === state.room) chatLine(m.nick, m.text); break;
    case "game":
      if (state.parlor?.handle && m.room === state.room) state.parlor.handle(m.g, m.nick); break;
    case "poker":
      if (state.parlor?.onPoker && m.room === state.room) state.parlor.onPoker(m); break;
  }
}

function renderMembers(members) {
  state.members = members;
  $("member-count").textContent = members.length;
  const el = $("memberlist");
  el.innerHTML = "";
  members.forEach((n) => {
    const d = document.createElement("div");
    d.className = "member" + (n === state.nick ? " me" : "");
    d.innerHTML = `<span class="pdot"></span> ${escapeHtml(n)}`;
    el.appendChild(d);
  });
}

function wireChat() {
  const send = () => {
    const t = $("chat-text").value.trim();
    if (!t || !state.room) return;
    wsSend({ type: "chat", room: state.room, text: t });
    $("chat-text").value = "";
  };
  $("chat-send").addEventListener("click", send);
  $("chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
}

function chatLine(nick, text) {
  const log = $("chatlog");
  const div = document.createElement("div");
  div.className = "line" + (nick === state.nick ? " me" : "");
  div.innerHTML = `<span class="who">${escapeHtml(nick)}:</span> ${escapeHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function sysLine(text) {
  const log = $("chatlog");
  const div = document.createElement("div");
  div.className = "line sys";
  div.textContent = `— ${text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------
// Toolbar / nick / helpers
// ---------------------------------------------------------------------------
function wireToolbar() {
  document.querySelectorAll(".tbtn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tbtn").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      const view = b.dataset.view;
      if (view !== "games") {
        alert(`${b.textContent.trim()} — coming soon.`);
        document.querySelector('.tbtn[data-view="games"]').classList.add("on");
        b.classList.remove("on");
      }
    });
  });
}

function changeNick() {
  const n = prompt("Choose your nickname:", state.nick);
  if (n && n.trim()) {
    state.nick = n.trim().slice(0, 24);
    $("nick").textContent = state.nick;
    wsSend({ type: "hello", nick: state.nick });
  }
}

function wireFilters() {
  $("f-empty").addEventListener("change", (e) => { state.filters.empty = e.target.checked; renderBrowser(); });
  $("f-full").addEventListener("change", (e) => { state.filters.full = e.target.checked; renderBrowser(); });
  $("f-search").addEventListener("input", (e) => { state.filters.search = e.target.value; renderBrowser(); });
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

function setConn(ok) {
  $("conn-dot").classList.toggle("on", ok);
  $("conn-text").textContent = ok ? "connected" : "reconnecting…";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
