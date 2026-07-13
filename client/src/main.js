// OpenArcade desktop client — faithful GameSpy Arcade loop:
// pick a game -> enter its room -> live server browser + chat lobby + member list.
// Parlor games (chess/checkers/reversi) enter the same room shell with a board
// in place of the server browser.

import { PARLOR_GAMES, createParlorSession } from "./parlor.js";
import { invoke } from "@tauri-apps/api/core";

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
  staging: { list: [], room: null },
};

// Peer-hosted games (no dedicated servers) — use GameSpy-style staging rooms.
const HOSTED = new Set(["avp"]);

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
  document.addEventListener("click", () => $("ctxmenu").classList.add("hidden"));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { $("ctxmenu").classList.add("hidden"); closeModal(); } });
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
  if (state.staging?.room) wsSend({ type: "lobby", do: "leave", id: state.staging.room.id });
  if (state.staging) state.staging.room = null;
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
  const hosted = HOSTED.has(id);
  $("parlorwrap").classList.add("hidden");
  $("browserwrap").classList.toggle("hidden", hosted);
  $("stagewrap").classList.toggle("hidden", !hosted);
  enterRoomShell(g.title, hosted ? `peer-hosted · room #${state.room}` : `${g.source} · room #${state.room}`);
  sysLine(`Entered the ${g.title} room.`);

  wsSend({ type: "join", room: state.room });
  if (hosted) {
    state.staging = { list: [], room: null };
    wsSend({ type: "lobby", do: "list", game: id });
    renderStaging();
  } else {
    loadServers(id);
  }
}

function enterParlor(key) {
  const p = PARLOR_GAMES.find((x) => x.key === key);
  if (!p) return;
  leaveCurrent();

  state.mode = "parlor";
  state.current = `parlor:${key}`;
  state.room = `parlor-${key}`;
  $("browserwrap").classList.add("hidden");
  $("stagewrap").classList.add("hidden");
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
    tr.addEventListener("contextmenu", (e) => showContextMenu(s, e));
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

// ---------------------------------------------------------------------------
// Launch-and-join
// ---------------------------------------------------------------------------
// The app runs inside a distrobox, so launches route through the host via
// distrobox-host-exec. Steam GoldSrc/Source games connect via steam://.
const LAUNCH_DEFAULTS = {
  cstrike: { program: "distrobox-host-exec", args: "xdg-open steam://connect/{addr}" },
  tfc: { program: "distrobox-host-exec", args: "xdg-open steam://connect/{addr}" },
  dod: { program: "distrobox-host-exec", args: "xdg-open steam://connect/{addr}" },
};
function getLaunchProfile(game) {
  const saved = localStorage.getItem("oa_launch_" + game);
  if (saved) { try { return JSON.parse(saved); } catch { /* ignore */ } }
  return LAUNCH_DEFAULTS[game] || null;
}

async function joinServer(s) {
  const game = state.current;
  const prof = getLaunchProfile(game);
  if (!prof) { configLaunch(game); return; }
  const addr = `${s.address}:${s.port}`;
  const argstr = prof.args.replace(/\{addr\}/g, addr).replace(/\{ip\}/g, s.address).replace(/\{port\}/g, s.port);
  const args = argstr.split(/\s+/).filter(Boolean);
  try {
    await invoke("launch", { program: prof.program, args });
    sysLine(`Launching ${game} → ${addr}…`);
  } catch (e) {
    sysLine(`Launch failed (${e}). Right-click → Configure Launch to fix the command.`);
  }
}

// ---------------------------------------------------------------------------
// Right-click context menu
// ---------------------------------------------------------------------------
function showContextMenu(s, ev) {
  ev.preventDefault();
  const menu = $("ctxmenu");
  menu.innerHTML = `
    <div data-act="join">▶ Join &amp; Play</div>
    <div data-act="details">🔍 Server Details</div>
    <div data-act="config">⚙ Configure Launch…</div>
    <div data-act="copy">📋 Copy Address</div>`;
  menu.style.left = Math.min(ev.clientX, window.innerWidth - 180) + "px";
  menu.style.top = Math.min(ev.clientY, window.innerHeight - 130) + "px";
  menu.classList.remove("hidden");
  menu.querySelectorAll("[data-act]").forEach((el) =>
    el.addEventListener("click", () => {
      menu.classList.add("hidden");
      const a = el.dataset.act;
      if (a === "join") joinServer(s);
      else if (a === "details") showDetails(s);
      else if (a === "config") configLaunch(state.current);
      else if (a === "copy") { navigator.clipboard?.writeText(`${s.address}:${s.port}`); sysLine(`Copied ${s.address}:${s.port}`); }
    }));
}

// ---------------------------------------------------------------------------
// Server details (live player query)
// ---------------------------------------------------------------------------
async function showDetails(s) {
  openModal(`<h3>${escapeHtml(s.name || "Server")}</h3>
    <div class="col-addr">${s.address}:${s.port} · ${escapeHtml(s.map || "")}</div>
    <div id="det-body" class="det-body">Querying server…</div>`);
  try {
    const r = await fetch(`${API}/details?game=${encodeURIComponent(state.current)}&addr=${s.address}&port=${s.port}`);
    const d = await r.json();
    const players = d.players || [];
    const rows = players.length
      ? players.map((p) => `<tr><td>${escapeHtml(p.name || "")}</td><td class="num">${p.score ?? "—"}</td><td class="num">${p.ping ?? "—"}</td><td class="num">${p.time != null ? fmtTime(p.time) : "—"}</td></tr>`).join("")
      : `<tr><td colspan="4" class="det-none">No player list returned (the server hides it or didn't answer the query).</td></tr>`;
    const body = $("det-body");
    if (body) body.innerHTML = `<table class="dettable"><thead><tr><th>Player</th><th>Score</th><th>Ping</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    const body = $("det-body");
    if (body) body.textContent = "Failed to query the server.";
  }
}
function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return h ? `${h}h${m}m` : `${m}m${ss}s`;
}

// ---------------------------------------------------------------------------
// Configure launch
// ---------------------------------------------------------------------------
function configLaunch(game) {
  const prof = getLaunchProfile(game) || { program: "distrobox-host-exec", args: "xdg-open steam://connect/{addr}" };
  openModal(`<h3>Configure Launch — ${escapeHtml(game)}</h3>
    <p class="hint">Command that boots the game and connects. Placeholders: <b>{addr}</b> (ip:port), <b>{ip}</b>, <b>{port}</b>.
    Runs on your host via <span class="mono">distrobox-host-exec</span>.</p>
    <label>Program<br><input id="cf-prog" class="cf-in" value="${escapeHtml(prof.program)}"></label>
    <label>Arguments<br><input id="cf-args" class="cf-in" value="${escapeHtml(prof.args)}"></label>
    <div class="modal-actions"><button id="cf-save">Save</button></div>`);
  $("cf-save").addEventListener("click", () => {
    const program = $("cf-prog").value.trim();
    const args = $("cf-args").value.trim();
    if (program) { localStorage.setItem("oa_launch_" + game, JSON.stringify({ program, args })); sysLine(`Saved launch config for ${game}.`); }
    closeModal();
  });
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
function openModal(html) {
  const m = $("modal");
  m.innerHTML = `<div class="modal-box">${html}<button class="modal-x" id="modal-x">✕</button></div>`;
  m.classList.remove("hidden");
  $("modal-x").addEventListener("click", closeModal);
  m.addEventListener("mousedown", (e) => { if (e.target === m) closeModal(); });
}
function closeModal() { const m = $("modal"); m.classList.add("hidden"); m.innerHTML = ""; }

// ---------------------------------------------------------------------------
// Staging rooms (peer-hosted games, GameSpy-Arcade style)
// ---------------------------------------------------------------------------
function gameTitle(slug) { return state.games.find((g) => g.gamename === slug)?.title || slug; }

function onLobby(m) {
  if (state.mode !== "server" || !HOSTED.has(state.current)) return;
  const st = state.staging;
  switch (m.ev) {
    case "list":
      if (m.game === state.current) { st.list = m.rooms || []; if (!st.room) renderStaging(); }
      break;
    case "state":
      if ((m.members || []).some((x) => x.nick === state.nick)) { st.room = m; renderStaging(); }
      break;
    case "disbanded":
      if (st.room && st.room.id === m.id) { st.room = null; sysLine("The host closed the staging room."); wsSend({ type: "lobby", do: "list", game: state.current }); renderStaging(); }
      break;
    case "launch":
      doHostedLaunch(m);
      break;
  }
}

function renderStaging() {
  const el = $("stage-body");
  const st = state.staging;
  if (st.room) {
    const r = st.room;
    const isHost = r.host === state.nick;
    const me = (r.members || []).find((x) => x.nick === state.nick);
    const p = r.params || {};
    const membersHtml = (r.members || []).map((x) =>
      `<div class="stg-member${x.ready ? " ready" : ""}"><span class="rl"></span> ${escapeHtml(x.nick)}${x.nick === r.host ? ' <span class="stg-hosttag">HOST</span>' : ""} — ${x.ready ? "ready" : "not ready"}</div>`).join("");
    const params = isHost
      ? `<div class="stg-params">
           <label>Map <input id="sp-map" value="${escapeHtml(p.map || "")}"></label>
           <label>Type <input id="sp-type" value="${escapeHtml(p.gametype || "")}"></label>
           <label>Max <input id="sp-max" type="number" value="${escapeHtml(String(p.maxplayers || 8))}" style="width:56px"></label>
           <button class="minibtn" id="sp-save">Set</button>
         </div>`
      : `<div class="stg-params ro">Map <b>${escapeHtml(p.map || "—")}</b> · Type <b>${escapeHtml(p.gametype || "—")}</b> · Max <b>${escapeHtml(String(p.maxplayers || "—"))}</b></div>`;
    el.innerHTML = `
      <div class="stg-hdr">Staging Room — ${escapeHtml(r.host)}'s game <span class="col-addr">host ${escapeHtml(r.hostIp || "?")}</span></div>
      ${params}
      <div class="stg-members">${membersHtml}</div>
      <div class="stg-actions">
        <button class="fbtn" id="stg-ready">${me?.ready ? "Not ready" : "Ready"}</button>
        ${isHost ? `<button class="fbtn" id="stg-launch">🚀 Launch</button>` : ""}
        <button class="minibtn" id="stg-leave">Leave</button>
        <button class="minibtn" id="stg-cfg">Configure launch…</button>
      </div>
      ${isHost ? "" : '<div class="hint">Waiting for the host to launch. Your game will boot and connect automatically.</div>'}`;
    $("stg-ready")?.addEventListener("click", () => wsSend({ type: "lobby", do: "ready", id: r.id, ready: !me?.ready }));
    $("stg-leave")?.addEventListener("click", leaveStaging);
    $("stg-launch")?.addEventListener("click", () => wsSend({ type: "lobby", do: "launch", id: r.id }));
    $("stg-cfg")?.addEventListener("click", () => configHostedLaunch(state.current));
    $("sp-save")?.addEventListener("click", () => wsSend({ type: "lobby", do: "params", id: r.id, params: { map: $("sp-map").value, gametype: $("sp-type").value, maxplayers: Number($("sp-max").value) || 8 } }));
  } else {
    const rows = (st.list || []).map((r) => {
      const p = r.params || {};
      return `<div class="stg-listrow"><div><b>${escapeHtml(r.host)}</b>'s game — ${escapeHtml(p.map || "?")} · ${escapeHtml(p.gametype || "")} · ${r.count} player${r.count === 1 ? "" : "s"}</div><button class="minibtn" data-join="${r.id}">Join</button></div>`;
    }).join("") || '<div class="stg-none">No open games. Host one to get started.</div>';
    el.innerHTML = `
      <div class="stg-hdr">Games — ${escapeHtml(gameTitle(state.current))}</div>
      <div class="hint">Peer-hosted: someone hosts a match, others join the staging room, then the host launches — classic GameSpy Arcade.</div>
      <div class="stg-actions"><button class="fbtn" id="stg-host">＋ Host a Game</button></div>
      <div class="stg-list">${rows}</div>`;
    $("stg-host")?.addEventListener("click", hostGame);
    el.querySelectorAll("[data-join]").forEach((b) => b.addEventListener("click", () => wsSend({ type: "lobby", do: "join", id: b.dataset.join })));
  }
}

function hostGame() {
  openModal(`<h3>Host a Game — ${escapeHtml(gameTitle(state.current))}</h3>
    <label>Map<br><input id="hg-map" class="cf-in" value=""></label>
    <label>Game type<br><input id="hg-type" class="cf-in" value="Deathmatch"></label>
    <label>Max players<br><input id="hg-max" class="cf-in" type="number" value="8"></label>
    <div class="modal-actions"><button id="hg-create">Create staging room</button></div>`);
  $("hg-create").addEventListener("click", () => {
    wsSend({ type: "lobby", do: "host", game: state.current, params: { map: $("hg-map").value, gametype: $("hg-type").value, maxplayers: Number($("hg-max").value) || 8 } });
    closeModal();
  });
}

function leaveStaging() {
  if (state.staging.room) wsSend({ type: "lobby", do: "leave", id: state.staging.room.id });
  state.staging.room = null;
  wsSend({ type: "lobby", do: "list", game: state.current });
  renderStaging();
}

function getHostedProfile(game) {
  const saved = localStorage.getItem("oa_hosted_" + game);
  if (saved) { try { return JSON.parse(saved); } catch { /* ignore */ } }
  return { program: "distrobox-host-exec", hostArgs: "", joinArgs: "" };
}

function configHostedLaunch(game) {
  const prof = getHostedProfile(game);
  openModal(`<h3>Configure Launch — ${escapeHtml(gameTitle(game))} (peer-hosted)</h3>
    <p class="hint">Two commands — one for hosting a game, one for joining. Placeholders: <b>{host_ip} {map} {gametype} {maxplayers}</b>. Runs on your host via <span class="mono">distrobox-host-exec</span>.</p>
    <label>Program<br><input id="hp-prog" class="cf-in" value="${escapeHtml(prof.program)}"></label>
    <label>Host args (start a game)<br><input id="hp-host" class="cf-in" value="${escapeHtml(prof.hostArgs)}"></label>
    <label>Join args (connect to {host_ip})<br><input id="hp-join" class="cf-in" value="${escapeHtml(prof.joinArgs)}"></label>
    <div class="modal-actions"><button id="hp-save">Save</button></div>`);
  $("hp-save").addEventListener("click", () => {
    localStorage.setItem("oa_hosted_" + game, JSON.stringify({ program: $("hp-prog").value.trim(), hostArgs: $("hp-host").value.trim(), joinArgs: $("hp-join").value.trim() }));
    sysLine("Saved hosted-launch config.");
    closeModal();
  });
}

async function doHostedLaunch(m) {
  const game = state.current;
  const isHost = m.host === state.nick;
  const prof = getHostedProfile(game);
  const tmpl = isHost ? prof.hostArgs : prof.joinArgs;
  if (!prof.program || !tmpl) { sysLine("Launch not configured — Configure launch in the staging room."); configHostedLaunch(game); return; }
  const p = m.params || {};
  const argstr = tmpl
    .replace(/\{host_ip\}/g, m.hostIp || "")
    .replace(/\{map\}/g, p.map || "")
    .replace(/\{gametype\}/g, p.gametype || "")
    .replace(/\{maxplayers\}/g, p.maxplayers ?? "");
  try {
    await invoke("launch", { program: prof.program, args: argstr.split(/\s+/).filter(Boolean) });
    sysLine(`Launching ${game} — ${isHost ? "hosting" : "joining " + m.hostIp}…`);
  } catch (e) {
    sysLine(`Launch failed: ${e}`);
  }
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
    case "lobby":
      onLobby(m); break;
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
