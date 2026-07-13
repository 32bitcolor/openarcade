// OpenArcade parlor games — the classic hosted casual games (GameSpy Arcade
// bundled chess/checkers/reversi/cards, etc.).
//
// Sync model: deterministic lockstep. The room hub broadcasts every "game"
// message to all members in the same order, so every client replays the same
// move stream onto the same start state and stays in sync — no authority server.
// Late joiners send {a:"sync_req"}; a seated player replies {a:"state", ...}.

export const PARLOR_GAMES = [
  { key: "reversi", title: "Reversi (Othello)", ready: true },
  { key: "checkers", title: "Checkers", ready: false },
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
export function createParlorSession(gameKey, root, controls, { send, getNick }) {
  const game = PARLOR_GAMES.find((g) => g.key === gameKey);
  let needSync = true;

  let st = {
    board: initBoard(),
    turn: B,
    seats: { 1: null, 2: null }, // color -> nick
    winner: null, // null | 1 | 2 | 'draw'
  };

  if (!game || !game.ready) {
    root.innerHTML = `<div class="parlor-soon">${game ? game.title : "Game"} — coming soon.<br>
      The parlor engine is live; this board lands in the next update.</div>`;
    controls.innerHTML = "";
    return { handle() {}, destroy() {} };
  }

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
