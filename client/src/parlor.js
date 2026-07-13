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
  { key: "chess", title: "Chess", ready: true },
  { key: "poker", title: "Texas Hold'em Poker", ready: true },
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
  if (gameKey === "chess") return chessSession(root, controls, io);
  if (gameKey === "poker") return pokerSession(root, controls, io);
  return reversiSession(root, controls, io);
}

// ---- Poker session (server-authoritative) ---------------------------------
function pokerSession(root, controls, { pokerSend, getNick }) {
  let table = null;
  let hole = [];
  let showdown = null;
  const myNick = () => getNick();
  const mySeat = () => table?.seats?.find((s) => s.nick === myNick());

  function onPoker(m) {
    if (m.ev === "state") { table = m; if (m.handActive) showdown = null; render(); }
    else if (m.ev === "hole") { hole = m.cards || []; render(); }
    else if (m.ev === "showdown") { showdown = m; render(); }
  }

  function status() {
    if (showdown && !table?.handActive) {
      const w = showdown.winners || [];
      return `Showdown — ${w.join(", ") || "nobody"} win${w.length === 1 ? "s" : ""} ${showdown.pot} chips`;
    }
    if (!table) return "Connecting to the table…";
    if (!table.handActive) return "Waiting — sit down, then Deal (need 2+ players).";
    const stages = ["", "Pre-flop", "Flop", "Turn", "River"];
    return `${stages[table.stage] || ""} · pot ${table.pot} · ${table.toAct || "?"} to act`;
  }

  function render() {
    const seated = !!mySeat();
    const active = table?.handActive;
    let ctl = "";
    if (!seated) ctl += `<button class="fbtn" data-do="sit">Sit (buy-in 1000)</button>`;
    else {
      ctl += `<button class="minibtn" data-do="leave">Leave</button>`;
      if (!active) ctl += ` <button class="fbtn" data-do="start">Deal</button>`;
    }
    const hasEmpty = (table?.seats || []).some((s) => s.empty);
    if (!active && hasEmpty) ctl += ` <button class="minibtn" data-do="sitbot">+ CPU</button>`;
    if (active && table.toAct === myNick()) {
      const me = mySeat();
      const toCall = (table.currentBet || 0) - (me?.bet || 0);
      ctl += ` &nbsp;&nbsp; `;
      ctl += toCall <= 0 ? `<button class="fbtn" data-do="check">Check</button>` : `<button class="fbtn" data-do="call">Call ${toCall}</button>`;
      ctl += ` <button class="fbtn" data-do="raise">Raise…</button> <button class="minibtn" data-do="fold">Fold</button>`;
    }
    controls.innerHTML = `<div class="parlor-status">${status()}</div><div class="parlor-seats">${ctl}</div>`;
    controls.querySelectorAll("[data-do]").forEach((el) => el.addEventListener("click", () => act(el.dataset.do)));

    if (!table) { root.innerHTML = ""; return; }
    const board = (table.board || []).map(cardHtml).join("") || '<span class="pk-empty">community cards appear here</span>';
    const seats = (table.seats || []).map((s) => {
      if (s.empty) return `<div class="pk-seat empty">empty</div>`;
      const me = s.nick === myNick();
      const badges = `${s.dealer ? '<span class="pk-d">D</span>' : ""}${s.folded ? '<span class="pk-tag fold">folded</span>' : ""}${s.allin ? '<span class="pk-tag allin">all-in</span>' : ""}`;
      const cards = me && hole.length ? hole.map(cardHtml).join("") : (s.inHand && !s.folded ? '<span class="pk-back">🂠 🂠</span>' : "");
      return `<div class="pk-seat${s.acting ? " acting" : ""}${me ? " me" : ""}">
        <div class="pk-name">${escapeHtml(s.nick)} ${badges}</div>
        <div class="pk-chips">${s.chips} chips${s.bet ? ` · bet ${s.bet}` : ""}</div>
        <div class="pk-cards">${cards}</div></div>`;
    }).join("");
    let sd = "";
    if (showdown && !table.handActive && (showdown.results || []).length) {
      sd = '<div class="pk-sd">' + showdown.results.map((r) => `${escapeHtml(r.nick)}: <b>${r.hand}</b> ${r.cards.map(cardHtml).join("")}`).join("<br>") + "</div>";
    }
    root.innerHTML = `<div class="poker">
      <div class="pk-board"><div class="pk-pot">POT ${table.pot || 0}</div><div class="pk-comm">${board}</div></div>
      <div class="pk-seats">${seats}</div>${sd}</div>`;
  }

  function act(a) {
    if (a === "raise") {
      const min = (table.currentBet || 0) + (table.minRaise || 10);
      const v = prompt(`Raise to (min ${min}):`, String(min));
      const amt = parseInt(v, 10);
      if (amt) pokerSend({ do: "raise", amount: amt });
    } else {
      pokerSend({ do: a });
    }
  }

  pokerSend({ do: "state" });
  render();
  return { onPoker, destroy() { root.innerHTML = ""; controls.innerHTML = ""; } };
}

function wireBotButtons(controls, send) {
  controls.querySelectorAll("[data-bot]").forEach((el) =>
    el.addEventListener("click", () => send({ a: "sit", color: Number(el.dataset.bot), bot: true })));
}

function cardHtml(code) {
  if (!code || code.length < 2) return "";
  const r = code[0], s = code[1];
  const sym = { c: "♣", d: "♦", h: "♥", s: "♠" }[s] || "?";
  const red = s === "d" || s === "h";
  return `<span class="pk-card${red ? " red" : ""}">${r === "T" ? "10" : r}${sym}</span>`;
}

// ---- Reversi session ------------------------------------------------------
function reversiSession(root, controls, { send, getNick }) {
  let needSync = true;
  let botPending = false;
  let st = {
    board: initBoard(),
    turn: B,
    seats: { 1: null, 2: null }, // color -> nick
    botOwner: { 1: null, 2: null }, // color -> owner nick (bot seats)
    winner: null, // null | 1 | 2 | 'draw'
  };
  const myNick = () => getNick();

  function driveBots() {
    if (st.winner) return;
    if (st.botOwner[st.turn] === myNick() && !botPending) {
      botPending = true;
      setTimeout(() => {
        botPending = false;
        if (!st.winner && st.botOwner[st.turn] === myNick()) {
          const mv = reversiBot(st);
          if (mv) send({ a: "move", r: mv.r, c: mv.c, bot: st.turn });
        }
      }, 650);
    }
  }
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
        if (!st.seats[col]) {
          if (g.bot) { st.seats[col] = BOT_NICK; st.botOwner[col] = from; }
          else if (st.seats[oppOf(col)] !== from) st.seats[col] = from;
        }
        break;
      }
      case "stand":
        if (st.seats[g.color] === from || st.botOwner[g.color] === from) { st.seats[g.color] = null; st.botOwner[g.color] = null; }
        break;
      case "reset":
        st.board = initBoard(); st.turn = B; st.winner = null;
        break;
      case "move": {
        if (st.winner) break;
        const allowed = g.bot != null ? (st.botOwner[g.bot] === from && g.bot === st.turn) : (from === st.seats[st.turn]);
        if (!allowed) break;
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
    wireBotButtons(controls, send);

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
    driveBots();
  }

  function seatBtn(color) {
    if (st.seats[color] === myNick()) return `<button class="minibtn" data-stand="${color}">stand</button>`;
    if (st.botOwner[color] === myNick()) return `<button class="minibtn" data-stand="${color}">remove bot</button>`;
    if (!st.seats[color]) {
      const sit = !mySeat() ? `<button class="minibtn" data-sit="${color}">sit</button> ` : "";
      return sit + `<button class="minibtn" data-bot="${color}">+ CPU</button>`;
    }
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
  let botPending = false;
  let st = { board: ckInit(), turn: "b", seats: { 1: null, 2: null }, botOwner: { 1: null, 2: null }, winner: null };
  let jpath = null; // in-progress selection/jump path

  const myNick = () => getNick();
  const seatColor = () => (st.seats[1] === myNick() ? "b" : st.seats[2] === myNick() ? "w" : null);
  const seatOfColor = (c) => (c === "b" ? 1 : 2);
  function driveBots() {
    if (st.winner) return;
    if (st.botOwner[seatOfColor(st.turn)] === myNick() && !botPending) {
      botPending = true;
      setTimeout(() => {
        botPending = false;
        const s2 = seatOfColor(st.turn);
        if (!st.winner && st.botOwner[s2] === myNick()) {
          const mv = checkersBot(st);
          if (mv) send({ a: "move", path: mv.path, bot: s2 });
        }
      }, 650);
    }
  }

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
        if (!st.seats[s]) {
          if (g.bot) { st.seats[s] = BOT_NICK; st.botOwner[s] = from; }
          else if (st.seats[s === 1 ? 2 : 1] !== from) st.seats[s] = from;
        }
        break;
      }
      case "stand": if (st.seats[g.color] === from || st.botOwner[g.color] === from) { st.seats[g.color] = null; st.botOwner[g.color] = null; } break;
      case "reset": st.board = ckInit(); st.turn = "b"; st.winner = null; jpath = null; break;
      case "move": {
        if (st.winner) break;
        const seat = seatOfColor(st.turn);
        const allowed = g.bot != null ? (st.botOwner[g.bot] === from && g.bot === seat) : (from === st.seats[seat]);
        if (!allowed) break;
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
    wireBotButtons(controls, send);

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
    driveBots();
  }

  function seatBtn(color) {
    const s = seatOfColor(color);
    if (st.seats[s] === myNick()) return `<button class="minibtn" data-stand="${s}">stand</button>`;
    if (st.botOwner[s] === myNick()) return `<button class="minibtn" data-stand="${s}">remove bot</button>`;
    if (!st.seats[s]) {
      const sit = !seatColor() ? `<button class="minibtn" data-sit="${s}">sit</button> ` : "";
      return sit + `<button class="minibtn" data-bot="${s}">+ CPU</button>`;
    }
    return "";
  }

  send({ a: "sync_req" });
  render();
  return { handle, destroy() { root.innerHTML = ""; controls.innerHTML = ""; } };
}

// ---- Chess rules ----------------------------------------------------------
// Board: index 0..63, row 0 = rank 8 (black back rank), row 7 = white back rank.
// Pieces: uppercase = White (PNBRQK), lowercase = black. "" = empty.
const CW = "w", CB2 = "b";
const pcColor = (p) => (p === "" ? null : p === p.toUpperCase() ? CW : CB2);
const other = (c) => (c === CW ? CB2 : CW);
const rc = (i) => [Math.floor(i / 8), i % 8];
const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function chInit() {
  const back = "rnbqkbnr";
  const b = new Array(64).fill("");
  for (let c = 0; c < 8; c++) {
    b[c] = back[c];
    b[8 + c] = "p";
    b[48 + c] = "P";
    b[56 + c] = back[c].toUpperCase();
  }
  return { board: b, turn: CW, castle: { K: true, Q: true, k: true, q: true }, ep: -1, result: null };
}

const KN = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const KG = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const DIAG = [[-1,-1],[-1,1],[1,-1],[1,1]];
const ORTH = [[-1,0],[1,0],[0,-1],[0,1]];

function isAttacked(board, idx, by) {
  const [r, c] = rc(idx);
  // pawns
  const pd = by === CW ? 1 : -1; // white pawns sit below (higher row); attack upward
  for (const dc of [-1, 1]) {
    const rr = r + pd, cc = c + dc;
    if (inb(rr, cc)) {
      const p = board[rr * 8 + cc];
      if (p && pcColor(p) === by && p.toLowerCase() === "p") return true;
    }
  }
  for (const [dr, dc] of KN) {
    const rr = r + dr, cc = c + dc;
    if (inb(rr, cc)) { const p = board[rr * 8 + cc]; if (p && pcColor(p) === by && p.toLowerCase() === "n") return true; }
  }
  for (const [dr, dc] of KG) {
    const rr = r + dr, cc = c + dc;
    if (inb(rr, cc)) { const p = board[rr * 8 + cc]; if (p && pcColor(p) === by && p.toLowerCase() === "k") return true; }
  }
  const ray = (dirs, types) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inb(rr, cc)) {
        const p = board[rr * 8 + cc];
        if (p) { if (pcColor(p) === by && types.includes(p.toLowerCase())) return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  };
  if (ray(DIAG, ["b", "q"])) return true;
  if (ray(ORTH, ["r", "q"])) return true;
  return false;
}

function kingIdx(board, color) {
  const k = color === CW ? "K" : "k";
  return board.indexOf(k);
}
function inCheck(board, color) {
  return isAttacked(board, kingIdx(board, color), other(color));
}

// Apply a (validated-enough) move to a state, returning a new state WITHOUT
// switching turn — used both for legality testing and real application.
function chApply(state, m) {
  const b = state.board.slice();
  const p = b[m.from];
  const color = pcColor(p);
  const [fr, fc] = rc(m.from), [tr, tc] = rc(m.to);
  const castle = { ...state.castle };
  let ep = -1;
  const low = p.toLowerCase();

  // en passant capture
  if (low === "p" && m.to === state.ep && b[m.to] === "") {
    b[(fr) * 8 + tc] = ""; // captured pawn sits on the from-rank, to-file
  }
  b[m.to] = p;
  b[m.from] = "";
  // promotion
  if (low === "p" && (tr === 0 || tr === 7)) {
    const pr = (m.promo || "q");
    b[m.to] = color === CW ? pr.toUpperCase() : pr.toLowerCase();
  }
  // double pawn push sets ep target
  if (low === "p" && Math.abs(tr - fr) === 2) ep = (fr + tr) / 2 * 8 + fc;
  // castling: move the rook
  if (low === "k" && Math.abs(tc - fc) === 2) {
    if (tc === 6) { b[tr * 8 + 5] = b[tr * 8 + 7]; b[tr * 8 + 7] = ""; }
    else if (tc === 2) { b[tr * 8 + 3] = b[tr * 8 + 0]; b[tr * 8 + 0] = ""; }
  }
  // update castling rights
  if (p === "K") { castle.K = false; castle.Q = false; }
  if (p === "k") { castle.k = false; castle.q = false; }
  if (m.from === 63 || m.to === 63) castle.K = false;
  if (m.from === 56 || m.to === 56) castle.Q = false;
  if (m.from === 7 || m.to === 7) castle.k = false;
  if (m.from === 0 || m.to === 0) castle.q = false;

  return { board: b, turn: state.turn, castle, ep, result: null };
}

function genPseudo(state, i, out) {
  const b = state.board, p = b[i], color = pcColor(p), [r, c] = rc(i);
  const low = p.toLowerCase();
  const add = (tr, tc, extra) => { if (inb(tr, tc)) { const t = b[tr * 8 + tc]; if (!t || pcColor(t) !== color) out.push({ from: i, to: tr * 8 + tc, ...extra }); } };
  const addEmptyOnly = (tr, tc) => inb(tr, tc) && b[tr * 8 + tc] === "";

  if (low === "p") {
    const dir = color === CW ? -1 : 1;
    const startRow = color === CW ? 6 : 1;
    const promoRow = color === CW ? 0 : 7;
    // forward
    if (addEmptyOnly(r + dir, c)) {
      pushPawn(out, i, (r + dir) * 8 + c, r + dir === promoRow);
      if (r === startRow && addEmptyOnly(r + 2 * dir, c)) out.push({ from: i, to: (r + 2 * dir) * 8 + c });
    }
    // captures
    for (const dc of [-1, 1]) {
      const tr = r + dir, tc = c + dc;
      if (inb(tr, tc)) {
        const t = b[tr * 8 + tc];
        if ((t && pcColor(t) !== color) || tr * 8 + tc === state.ep) pushPawn(out, i, tr * 8 + tc, tr === promoRow);
      }
    }
  } else if (low === "n") {
    for (const [dr, dc] of KN) add(r + dr, c + dc);
  } else if (low === "k") {
    for (const [dr, dc] of KG) add(r + dr, c + dc);
    // castling
    const row = color === CW ? 7 : 0;
    if (i === row * 8 + 4 && !inCheck(b, color)) {
      const kingSide = color === CW ? state.castle.K : state.castle.k;
      const queenSide = color === CW ? state.castle.Q : state.castle.q;
      if (kingSide && b[row * 8 + 5] === "" && b[row * 8 + 6] === "" && b[row * 8 + 7]?.toLowerCase() === "r" &&
          !isAttacked(b, row * 8 + 5, other(color)) && !isAttacked(b, row * 8 + 6, other(color)))
        out.push({ from: i, to: row * 8 + 6 });
      if (queenSide && b[row * 8 + 3] === "" && b[row * 8 + 2] === "" && b[row * 8 + 1] === "" && b[row * 8 + 0]?.toLowerCase() === "r" &&
          !isAttacked(b, row * 8 + 3, other(color)) && !isAttacked(b, row * 8 + 2, other(color)))
        out.push({ from: i, to: row * 8 + 2 });
    }
  } else {
    const dirs = low === "b" ? DIAG : low === "r" ? ORTH : DIAG.concat(ORTH);
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inb(rr, cc)) {
        const t = b[rr * 8 + cc];
        if (!t) out.push({ from: i, to: rr * 8 + cc });
        else { if (pcColor(t) !== color) out.push({ from: i, to: rr * 8 + cc }); break; }
        rr += dr; cc += dc;
      }
    }
  }
}
function pushPawn(out, from, to, promo) {
  if (promo) for (const pr of ["q", "r", "b", "n"]) out.push({ from, to, promo: pr });
  else out.push({ from, to });
}

function chLegal(state) {
  const out = [];
  for (let i = 0; i < 64; i++) if (pcColor(state.board[i]) === state.turn) genPseudo(state, i, out);
  return out.filter((m) => !inCheck(chApply(state, m).board, state.turn));
}

function chMove(state, m) {
  const legal = chLegal(state).find((x) => x.from === m.from && x.to === m.to && (x.promo || "q") === (m.promo || "q"));
  if (!legal) return null;
  const ns = chApply(state, legal);
  ns.turn = other(state.turn);
  const opp = ns.turn;
  if (chLegal(ns).length === 0) ns.result = inCheck(ns.board, opp) ? other(opp) : "draw"; // mate or stalemate
  return ns;
}

// ---- Chess session --------------------------------------------------------
const GLYPH = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘", P: "♙", k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };

function chessSession(root, controls, { send, getNick }) {
  let needSync = true;
  let botPending = false;
  let st = chInit();
  st.seats = { 1: null, 2: null }; // 1 = White, 2 = black
  st.botOwner = { 1: null, 2: null };
  let sel = null;

  const myNick = () => getNick();
  const seatColor = () => (st.seats[1] === myNick() ? CW : st.seats[2] === myNick() ? CB2 : null);
  const seatOf = (c) => (c === CW ? 1 : 2);
  function driveBots() {
    if (st.result) return;
    if (st.botOwner[seatOf(st.turn)] === myNick() && !botPending) {
      botPending = true;
      setTimeout(() => {
        botPending = false;
        const s2 = seatOf(st.turn);
        if (!st.result && st.botOwner[s2] === myNick()) {
          const mv = chessBot(st);
          if (mv) send({ a: "move", from: mv.from, to: mv.to, promo: mv.promo, bot: s2 });
        }
      }, 450);
    }
  }

  function onCell(i) {
    if (st.result || seatColor() !== st.turn) return;
    if (sel === null) {
      if (pcColor(st.board[i]) === st.turn) { sel = i; render(); }
      return;
    }
    if (i === sel) { sel = null; render(); return; }
    if (pcColor(st.board[i]) === st.turn) { sel = i; render(); return; }
    // attempt move sel -> i
    const moves = chLegal(st).filter((m) => m.from === sel && m.to === i);
    if (!moves.length) return;
    let promo;
    if (moves.length > 1 && moves[0].promo) {
      const ch = (prompt("Promote to (q,r,b,n):", "q") || "q").toLowerCase();
      promo = ["q", "r", "b", "n"].includes(ch) ? ch : "q";
    }
    send({ a: "move", from: sel, to: i, promo });
    sel = null;
  }

  function handle(g, from) {
    if (!g || typeof g !== "object") return;
    switch (g.a) {
      case "sit": {
        const s = g.color === 2 ? 2 : 1;
        if (!st.seats[s]) {
          if (g.bot) { st.seats[s] = BOT_NICK; st.botOwner[s] = from; }
          else if (st.seats[s === 1 ? 2 : 1] !== from) st.seats[s] = from;
        }
        break;
      }
      case "stand": if (st.seats[g.color] === from || st.botOwner[g.color] === from) { st.seats[g.color] = null; st.botOwner[g.color] = null; } break;
      case "reset": { const seats = st.seats, bo = st.botOwner; st = chInit(); st.seats = seats; st.botOwner = bo; sel = null; break; }
      case "move": {
        if (st.result) break;
        const seat = seatOf(st.turn);
        const allowed = g.bot != null ? (st.botOwner[g.bot] === from && g.bot === seat) : (from === st.seats[seat]);
        if (!allowed) break;
        const ns = chMove(st, { from: g.from, to: g.to, promo: g.promo });
        if (!ns) break;
        ns.seats = st.seats;
        ns.botOwner = st.botOwner;
        st = ns;
        break;
      }
      case "sync_req": if (seatColor()) send({ a: "state", st: JSON.parse(JSON.stringify(st)) }); break;
      case "state": if (needSync && g.st) { st = g.st; needSync = false; } break;
    }
    render();
  }

  function render() {
    const nm = (c) => st.seats[seatOf(c)] || "(open)";
    let status;
    if (st.result === "draw") status = "Draw.";
    else if (st.result) status = `${st.result === CW ? "White" : "Black"} wins — checkmate!`;
    else status = `${st.turn === CW ? "White" : "Black"} to move${inCheck(st.board, st.turn) ? " — check!" : ""}`;

    controls.innerHTML = `
      <div class="parlor-status">${status}</div>
      <div class="parlor-seats">
        <span class="seat w">♔ White: <b>${escapeHtml(nm(CW))}</b> ${seatBtn(CW)}</span>
        <span class="seat b">♚ Black: <b>${escapeHtml(nm(CB2))}</b> ${seatBtn(CB2)}</span>
        <button class="fbtn" data-act="reset">New game</button>
      </div>`;
    controls.querySelectorAll("[data-sit]").forEach((el) => el.addEventListener("click", () => send({ a: "sit", color: Number(el.dataset.sit) })));
    controls.querySelectorAll("[data-stand]").forEach((el) => el.addEventListener("click", () => send({ a: "stand", color: Number(el.dataset.stand) })));
    const rb = controls.querySelector('[data-act="reset"]');
    if (rb) rb.addEventListener("click", () => send({ a: "reset" }));
    wireBotButtons(controls, send);

    const targets = new Set();
    if (sel !== null) chLegal(st).filter((m) => m.from === sel).forEach((m) => targets.add(m.to));

    let html = '<div class="chess">';
    for (let i = 0; i < 64; i++) {
      const [r, c] = rc(i);
      const dark = (r + c) % 2 === 1;
      const p = st.board[i];
      const t = targets.has(i) ? " tgt" : "";
      const s = i === sel ? " selp" : "";
      html += `<div class="csq2 ${dark ? "d" : "l"}${t}${s}" data-i="${i}">${p ? `<span class="cpc ${pcColor(p) === CW ? "wp" : "bp"}">${GLYPH[p]}</span>` : ""}</div>`;
    }
    html += "</div>";
    root.innerHTML = html;
    root.querySelectorAll(".csq2").forEach((el) => el.addEventListener("click", () => onCell(Number(el.dataset.i))));
    driveBots();
  }

  function seatBtn(color) {
    const s = seatOf(color);
    if (st.seats[s] === myNick()) return `<button class="minibtn" data-stand="${s}">stand</button>`;
    if (st.botOwner[s] === myNick()) return `<button class="minibtn" data-stand="${s}">remove bot</button>`;
    if (!st.seats[s]) {
      const sit = !seatColor() ? `<button class="minibtn" data-sit="${s}">sit</button> ` : "";
      return sit + `<button class="minibtn" data-bot="${s}">+ CPU</button>`;
    }
    return "";
  }

  send({ a: "sync_req" });
  render();
  return { handle, destroy() { root.innerHTML = ""; controls.innerHTML = ""; } };
}

// ---- Bot AIs --------------------------------------------------------------
const BOT_NICK = "🤖 CPU";

// Reversi: greedy — most flips, weighted for corners/edges.
function reversiBot(st) {
  const weight = (r, c) => {
    const corner = (r === 0 || r === 7) && (c === 0 || c === 7);
    const nearCorner = (r <= 1 || r >= 6) && (c <= 1 || c >= 6) && !corner;
    const edge = r === 0 || r === 7 || c === 0 || c === 7;
    return corner ? 25 : nearCorner ? -8 : edge ? 3 : 0;
  };
  let best = null, bestScore = -1e9;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const f = flipsFor(st.board, r, c, st.turn);
    if (f.length) {
      const s = f.length + weight(r, c);
      if (s > bestScore) { bestScore = s; best = { r, c }; }
    }
  }
  return best;
}

// Checkers: enumerate legal complete moves, prefer longest capture.
function ckEnumJumps(board, path, out) {
  const partial = applyPartial(board, path);
  if (!partial) return;
  const nexts = partial.promoted ? [] : jumpsFrom(partial.bd, partial.cur);
  if (!nexts.length) { if (path.length > 1) out.push(path); return; }
  for (const j of nexts) ckEnumJumps(board, path.concat([j.land]), out);
}
function checkersMoves(board, color) {
  const jumps = [];
  for (let i = 0; i < 64; i++) if (colorOf(board[i]) === color) ckEnumJumps(board, [i], jumps);
  if (jumps.length) return jumps;
  const simple = [];
  for (let i = 0; i < 64; i++) if (colorOf(board[i]) === color) simpleFrom(board, i).forEach((t) => simple.push([i, t]));
  return simple;
}
function checkersBot(st) {
  const moves = checkersMoves(st.board, st.turn);
  if (!moves.length) return null;
  moves.sort((a, b) => b.length - a.length); // longest captures first
  const topLen = moves[0].length;
  const top = moves.filter((m) => m.length === topLen);
  return { path: top[Math.floor(botRand() * top.length)] };
}

// Chess: 2-ply negamax on material.
const CVAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
function evalSTM(st) {
  let s = 0;
  for (const p of st.board) if (p) s += pcColor(p) === st.turn ? CVAL[p.toLowerCase()] : -CVAL[p.toLowerCase()];
  return s;
}
function negamax(st, depth) {
  if (st.result) return st.result === "draw" ? 0 : -99999; // side to move was mated
  if (depth === 0) return evalSTM(st);
  let best = -1e9;
  for (const m of chLegal(st)) {
    const v = -negamax(chMove(st, m), depth - 1);
    if (v > best) best = v;
  }
  return best;
}
function chessBot(st) {
  const moves = chLegal(st);
  if (!moves.length) return null;
  let best = -1e9, pick = [];
  for (const m of moves) {
    const v = -negamax(chMove(st, m), 1); // 2-ply total
    if (v > best) { best = v; pick = [m]; }
    else if (v === best) pick.push(m);
  }
  const m = pick[Math.floor(botRand() * pick.length)];
  return { from: m.from, to: m.to, promo: m.promo };
}

// Cheap PRNG for bot variety (Math.random is fine here; not synced state).
function botRand() { return Math.random(); }

// Exposed for tests (rule functions are pure).
export const _ck = { ckInit, applyPath, jumpsFrom, simpleFrom, hasJump, ckWinner, P, colorOf };
export const _chess = { chInit, chLegal, chMove, inCheck, isAttacked, pcColor };
export const _bots = { reversiBot, checkersBot, chessBot, checkersMoves };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
