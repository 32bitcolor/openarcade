// OpenArcade parlor games — the classic hosted casual games (GameSpy Arcade
// bundled chess/checkers/reversi/cards, etc.).
//
// Sync model: deterministic lockstep. The room hub broadcasts every "game"
// message to all members in the same order, so every client replays the same
// move stream onto the same start state and stays in sync — no authority server.
// Late joiners send {a:"sync_req"}; a seated player replies {a:"state", ...}.

export const PARLOR_GAMES = [
  { key: "reversi", title: "Reversi (Othello)", ready: true },
  { key: "checkers", title: "Checkers", ready: true },
  { key: "chess", title: "Chess", ready: false },
];

// ---- Reversi rules --------------------------------------------------------
const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const B = 1, W = 2;
const oppOf = (p) => (p === B ? W : B);
const at = (bd, r, c) => bd[r * 8 + c];

function initBoard() {
  const bd = new Array(64).fill(0);
  bd[27] = W; bd[28] = B; bd[35] = B; bd[36] = W;
  return bd;
}
function flipsFor(bd, r, c, p) {
  if (r < 0 || r > 7 || c < 0 || c > 7 || at(bd, r, c) !== 0) return [];
  let out = [];
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc; const line = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && at(bd, rr, cc) === oppOf(p)) {
      line.push(rr * 8 + cc); rr += dr; cc += dc;
    }
    if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && at(bd, rr, cc) === p) out = out.concat(line);
  }
  return out;
}
function anyMove(bd, p) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (flipsFor(bd, r, c, p).length) return true;
  return false;
}
function tally(bd) {
  let b = 0, w = 0;
  for (const v of bd) { if (v === B) b++; else if (v === W) w++; }
  return { b, w };
}

// ---- Session --------------------------------------------------------------
export function createParlorSession(gameKey, root, controls, io) {
  const game = PARLOR_GAMES.find((g) => g.key === gameKey);
  if (!game || !game.ready) {
    root.innerHTML = `<div class="parlor-soon">${game ? game.title : "Game"} — coming soon.<br>
      The parlor engine is live; this board lands in the next update.</div>`;
    controls.innerHTML = "";
    return { handle() {}, destroy() {} };
  }
  if (gameKey === "checkers") return checkersSession(root, controls, io);
  return reversiSession(root, controls, io);
}

// ---- Reversi session ------------------------------------------------------
function reversiSession(root, controls, { send, getNick }) {
  let needSync = true;
  let st = {
    board: initBoard(),
    turn: B,
    seats: { 1: null, 2: null }, // color -> nick
    winner: null, // null | 1 | 2 | 'draw'
  };
  const myNick = () => getNick();
  const mySeat = () => (st.seats[B] === myNick() ? B : st.seats[W] === myNick() ? W : 0);

  function advanceTurn(p) {
    if (anyMove(st.board, oppOf(p))) st.turn = oppOf(p);
    else if (anyMove(st.board, p)) st.turn = p; // opponent passes
    else {
      const { b, w } = tally(st.board);
      st.winner = b > w ? B : w > b ? W : "draw";
    }
  }

  function localMove(r, c) {
    if (st.winner) return;
    if (mySeat() !== st.turn) return;
    if (!flipsFor(st.board, r, c, st.turn).length) return;
    send({ a: "move", r, c });
  }

  function handle(g, from) {
    if (!g || typeof g !== "object") return;
    switch (g.a) {
      case "sit": {
        const col = g.color === W ? W : B;
        if (!st.seats[col] && st.seats[oppOf(col)] !== from) st.seats[col] = from;
        break;
      }
      case "stand":
        if (st.seats[g.color] === from) st.seats[g.color] = null;
        break;
      case "reset":
        st.board = initBoard(); st.turn = B; st.winner = null;
        break;
      case "move": {
        if (st.winner) break;
        if (from !== st.seats[st.turn]) break; // only the player on turn
        const f = flipsFor(st.board, g.r, g.c, st.turn);
        if (!f.length) break;
        st.board[g.r * 8 + g.c] = st.turn;
        for (const i of f) st.board[i] = st.turn;
        advanceTurn(st.turn);
        break;
      }
      case "sync_req":
        if (mySeat()) send({ a: "state", st: JSON.parse(JSON.stringify(st)) });
        break;
      case "state":
        if (needSync && g.st) { st = g.st; needSync = false; }
        break;
    }
    render();
  }

  function render() {
    const { b, w } = tally(st.board);
    const seatName = (c) => st.seats[c] || "(open)";
    let status;
    if (st.winner === "draw") status = "Draw game.";
    else if (st.winner) status = `${st.winner === B ? "Black" : "White"} wins!`;
    else status = `${st.turn === B ? "● Black" : "○ White"} to move`;

    controls.innerHTML = `
      <div class="parlor-status">${status}</div>
      <div class="parlor-seats">
        <span class="seat b">● Black: <b>${escapeHtml(seatName(B))}</b> ${seatBtn(B)}</span>
        <span class="seat w">○ White: <b>${escapeHtml(seatName(W))}</b> ${seatBtn(W)}</span>
        <span class="parlor-score">Score ${b}–${w}</span>
        <button class="fbtn" data-act="reset">New game</button>
      </div>`;
    controls.querySelectorAll("[data-sit]").forEach((el) =>
      el.addEventListener("click", () => send({ a: "sit", color: Number(el.dataset.sit) })));
    controls.querySelectorAll("[data-stand]").forEach((el) =>
      el.addEventListener("click", () => send({ a: "stand", color: Number(el.dataset.stand) })));
    const rb = controls.querySelector('[data-act="reset"]');
    if (rb) rb.addEventListener("click", () => send({ a: "reset" }));

    const canPlay = mySeat() === st.turn && !st.winner;
    let html = '<div class="reversi">';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const v = at(st.board, r, c);
      const legal = canPlay && flipsFor(st.board, r, c, st.turn).length > 0;
      html += `<div class="cell${legal ? " legal" : ""}" data-r="${r}" data-c="${c}">${
        v ? `<span class="disc ${v === B ? "black" : "white"}"></span>` : ""
      }</div>`;
    }
    html += "</div>";
    root.innerHTML = html;
    root.querySelectorAll(".cell").forEach((el) =>
      el.addEventListener("click", () => localMove(Number(el.dataset.r), Number(el.dataset.c))));
  }

  function seatBtn(color) {
    if (st.seats[color] === myNick()) return `<button class="minibtn" data-stand="${color}">stand</button>`;
    if (!st.seats[color] && !mySeat()) return `<button class="minibtn" data-sit="${color}">sit</button>`;
    return "";
  }

  // Ask the room for current state (in case a game is in progress).
  send({ a: "sync_req" });
  render();

  return { handle, destroy() { root.innerHTML = ""; controls.innerHTML = ""; } };
}

// ---- Checkers rules -------------------------------------------------------
const P = (r, c) => r * 8 + c;
const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const isBk = (p) => p === "b" || p === "B";
const isWt = (p) => p === "w" || p === "W";
const colorOf = (p) => (isBk(p) ? "b" : isWt(p) ? "w" : null);

function ckInit() {
  const bd = new Array(64).fill("");
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) {
        if (r < 3) bd[P(r, c)] = "w";
        else if (r > 4) bd[P(r, c)] = "b";
      }
  return bd;
}
function pdirs(p) {
  if (p === "b") return [[-1,-1],[-1,1]];
  if (p === "w") return [[1,-1],[1,1]];
  return [[-1,-1],[-1,1],[1,-1],[1,1]];
}
function jumpsFrom(bd, i) {
  const p = bd[i]; if (!p) return [];
  const r = (i / 8) | 0, c = i % 8, out = [];
  for (const [dr, dc] of pdirs(p)) {
    const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
    if (inB(lr, lc) && bd[P(lr, lc)] === "") {
      const mp = bd[P(mr, mc)];
      if (mp && colorOf(mp) !== colorOf(p)) out.push({ land: P(lr, lc), mid: P(mr, mc) });
    }
  }
  return out;
}
function simpleFrom(bd, i) {
  const p = bd[i]; if (!p) return [];
  const r = (i / 8) | 0, c = i % 8, out = [];
  for (const [dr, dc] of pdirs(p)) {
    const nr = r + dr, nc = c + dc;
    if (inB(nr, nc) && bd[P(nr, nc)] === "") out.push(P(nr, nc));
  }
  return out;
}
function hasJump(bd, color) {
  for (let i = 0; i < 64; i++) if (colorOf(bd[i]) === color && jumpsFrom(bd, i).length) return true;
  return false;
}
function promote(bd, i) {
  const p = bd[i], r = (i / 8) | 0;
  if (p === "b" && r === 0) { bd[i] = "B"; return true; }
  if (p === "w" && r === 7) { bd[i] = "W"; return true; }
  return false;
}
function applyPartial(board, path) {
  const bd = board.slice();
  let cur = path[0], piece = bd[cur], promoted = false;
  for (let k = 1; k < path.length; k++) {
    const j = jumpsFrom(bd, cur).find((o) => o.land === path[k]);
    if (!j) return null;
    bd[j.land] = piece; bd[cur] = ""; bd[j.mid] = "";
    cur = j.land;
    if (promote(bd, cur)) { promoted = true; piece = bd[cur]; }
  }
  return { bd, cur, promoted };
}
function applyPath(board, path) {
  if (!Array.isArray(path) || path.length < 2) return { ok: false };
  const start = path[0], p = board[start], color = colorOf(p);
  if (!color) return { ok: false };
  const firstDelta = Math.abs(((path[1] / 8) | 0) - ((start / 8) | 0));
  if (firstDelta === 1) {
    if (path.length !== 2 || hasJump(board, color)) return { ok: false };
    if (!simpleFrom(board, start).includes(path[1])) return { ok: false };
    const bd = board.slice(); bd[path[1]] = p; bd[start] = ""; promote(bd, path[1]);
    return { ok: true, board: bd };
  }
  const res = applyPartial(board, path);
  if (!res) return { ok: false };
  if (!res.promoted && jumpsFrom(res.bd, res.cur).length) return { ok: false }; // incomplete
  return { ok: true, board: res.bd };
}
function ckWinner(bd, next) {
  for (let i = 0; i < 64; i++)
    if (colorOf(bd[i]) === next && (jumpsFrom(bd, i).length || simpleFrom(bd, i).length)) return null;
  return next === "b" ? "w" : "b";
}

// ---- Checkers session -----------------------------------------------------
function checkersSession(root, controls, { send, getNick }) {
  let needSync = true;
  let st = { board: ckInit(), turn: "b", seats: { 1: null, 2: null }, winner: null };
  let jpath = null; // in-progress selection/jump path

  const myNick = () => getNick();
  const seatColor = () => (st.seats[1] === myNick() ? "b" : st.seats[2] === myNick() ? "w" : null);
  const seatOfColor = (c) => (c === "b" ? 1 : 2);

  function onCell(idx) {
    if (st.winner || seatColor() !== st.turn) return;
    const me = st.turn;
    if (!jpath) {
      if (colorOf(st.board[idx]) === me) {
        const must = hasJump(st.board, me);
        const ok = must ? jumpsFrom(st.board, idx).length : (jumpsFrom(st.board, idx).length || simpleFrom(st.board, idx).length);
        if (ok) { jpath = [idx]; render(); }
      }
      return;
    }
    const start = jpath[0];
    if (jpath.length === 1 && colorOf(st.board[idx]) === me) { jpath = idx === start ? null : [idx]; render(); return; }
    if (jpath.length === 1 && !hasJump(st.board, me) && simpleFrom(st.board, start).includes(idx)) {
      send({ a: "move", path: [start, idx] }); jpath = null; return;
    }
    const partial = applyPartial(st.board, jpath);
    if (!partial) { jpath = null; render(); return; }
    if (!jumpsFrom(partial.bd, partial.cur).find((o) => o.land === idx)) return; // ignore invalid
    jpath.push(idx);
    const p2 = applyPartial(st.board, jpath);
    if (p2 && !p2.promoted && jumpsFrom(p2.bd, p2.cur).length) render(); // more jumps
    else { send({ a: "move", path: jpath.slice() }); jpath = null; }
  }

  function handle(g, from) {
    if (!g || typeof g !== "object") return;
    switch (g.a) {
      case "sit": {
        const s = g.color === 2 ? 2 : 1;
        if (!st.seats[s] && st.seats[s === 1 ? 2 : 1] !== from) st.seats[s] = from;
        break;
      }
      case "stand": if (st.seats[g.color] === from) st.seats[g.color] = null; break;
      case "reset": st.board = ckInit(); st.turn = "b"; st.winner = null; jpath = null; break;
      case "move": {
        if (st.winner) break;
        if (from !== st.seats[seatOfColor(st.turn)]) break;
        const res = applyPath(st.board, g.path);
        if (!res.ok) break;
        st.board = res.board;
        st.turn = st.turn === "b" ? "w" : "b";
        st.winner = ckWinner(st.board, st.turn);
        break;
      }
      case "sync_req": if (seatColor()) send({ a: "state", st: JSON.parse(JSON.stringify(st)) }); break;
      case "state": if (needSync && g.st) { st = g.st; needSync = false; } break;
    }
    render();
  }

  function render() {
    const nm = (c) => st.seats[seatOfColor(c)] || "(open)";
    let status;
    if (st.winner) status = `${st.winner === "b" ? "Black" : "White"} wins!`;
    else status = `${st.turn === "b" ? "● Black" : "○ White"} to move`;

    controls.innerHTML = `
      <div class="parlor-status">${status}</div>
      <div class="parlor-seats">
        <span class="seat b">● Black: <b>${escapeHtml(nm("b"))}</b> ${seatBtn("b")}</span>
        <span class="seat w">○ White: <b>${escapeHtml(nm("w"))}</b> ${seatBtn("w")}</span>
        <button class="fbtn" data-act="reset">New game</button>
      </div>`;
    controls.querySelectorAll("[data-sit]").forEach((el) =>
      el.addEventListener("click", () => send({ a: "sit", color: Number(el.dataset.sit) })));
    controls.querySelectorAll("[data-stand]").forEach((el) =>
      el.addEventListener("click", () => send({ a: "stand", color: Number(el.dataset.stand) })));
    const rb = controls.querySelector('[data-act="reset"]');
    if (rb) rb.addEventListener("click", () => send({ a: "reset" }));

    // legal target highlights for the in-progress selection
    let targets = new Set();
    if (jpath) {
      const start = jpath[0];
      if (jpath.length === 1 && !hasJump(st.board, st.turn)) simpleFrom(st.board, start).forEach((t) => targets.add(t));
      const partial = applyPartial(st.board, jpath);
      if (partial) jumpsFrom(partial.bd, partial.cur).forEach((o) => targets.add(o.land));
    }
    const selHead = jpath ? applyPartial(st.board, jpath)?.cur : null;

    let html = '<div class="checkers">';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const i = P(r, c);
      const dark = (r + c) % 2 === 1;
      const p = st.board[i];
      const cls = dark ? "dark" : "light";
      const tgt = targets.has(i) ? " tgt" : "";
      const selc = i === selHead ? " selp" : "";
      let piece = "";
      if (p) piece = `<span class="cpiece ${isBk(p) ? "black" : "white"}${p === "B" || p === "W" ? " king" : ""}">${p === "B" || p === "W" ? "♛" : ""}</span>`;
      html += `<div class="csq ${cls}${tgt}${selc}" data-i="${i}">${piece}</div>`;
    }
    html += "</div>";
    root.innerHTML = html;
    root.querySelectorAll(".csq").forEach((el) => el.addEventListener("click", () => onCell(Number(el.dataset.i))));
  }

  function seatBtn(color) {
    const s = seatOfColor(color);
    if (st.seats[s] === myNick()) return `<button class="minibtn" data-stand="${s}">stand</button>`;
    if (!st.seats[s] && !seatColor()) return `<button class="minibtn" data-sit="${s}">sit</button>`;
    return "";
  }

  send({ a: "sync_req" });
  render();
  return { handle, destroy() { root.innerHTML = ""; controls.innerHTML = ""; } };
}

// Exposed for tests (rule functions are pure).
export const _ck = { ckInit, applyPath, jumpsFrom, simpleFrom, hasJump, ckWinner, P, colorOf };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
