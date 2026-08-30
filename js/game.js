export const W = 16;
export const H = 16;
export const SIZE = W * H;
export const MINES = 51;
export const WIN_SCORE = 26;
export const BOMB_RADIUS = 2;

export function neighbors(i) {
  const x = i % W, y = (i / W) | 0, out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H) out.push(ny * W + nx);
    }
  }
  return out;
}

function computeAdj(mines) {
  return mines.map((_, i) => neighbors(i).reduce((n, j) => n + (mines[j] ? 1 : 0), 0));
}

export function newGame(rng = Math.random) {
  const mines = new Array(SIZE).fill(false);
  let placed = 0;
  while (placed < MINES) {
    const i = (rng() * SIZE) | 0;
    if (!mines[i]) { mines[i] = true; placed++; }
  }
  const adj = computeAdj(mines);
  return {
    mines,
    adj,
    revealed: new Array(SIZE).fill(false),
    owner: new Array(SIZE).fill(-1),
    scores: [0, 0],
    turn: 0,
    bombs: [true, true],
    status: 'playing',
    winner: null,
    last: null,
    players: [null, null],
    seq: 0,
    moves: [],
  };
}

// Rebuild a game position from a known mine layout (for replay/review).
// Replaying the recorded moves is deterministic: the final layout already
// reflects any first-click mine relocation, so that branch never re-fires.
export function gameFromMines(mines) {
  const s = newGame();
  s.mines = mines.slice();
  s.adj = computeAdj(s.mines);
  return s;
}

function floodReveal(s, i) {
  const out = [], stack = [i];
  while (stack.length) {
    const c = stack.pop();
    if (s.revealed[c] || s.mines[c]) continue;
    s.revealed[c] = true;
    out.push(c);
    if (s.adj[c] === 0) {
      for (const n of neighbors(c)) if (!s.revealed[n]) stack.push(n);
    }
  }
  return out;
}

function checkWin(s) {
  for (const p of [0, 1]) {
    if (s.scores[p] >= WIN_SCORE) {
      s.status = 'over';
      s.winner = p;
    }
  }
}

export function reveal(s, i, p, rng = Math.random) {
  if (s.status !== 'playing' || p !== s.turn || i < 0 || i >= SIZE || s.revealed[i]) return null;
  // The game's opening click never flood-fills: that would gift the opponent
  // a board full of clues. Relocate one distant mine next to the clicked cell
  // so the opener reveals a number instead.
  if (!s.mines[i] && s.adj[i] === 0 && !s.revealed.some(Boolean)) {
    const ns = neighbors(i);
    const sources = [];
    for (let j = 0; j < SIZE; j++) {
      if (s.mines[j] && j !== i && !ns.includes(j)) sources.push(j);
    }
    s.mines[sources[(rng() * sources.length) | 0]] = false;
    s.mines[ns[(rng() * ns.length) | 0]] = true;
    s.adj = computeAdj(s.mines);
  }
  s.seq++;
  if (!s.moves) s.moves = [];
  s.moves.push({ t: 'r', i, p });
  if (s.mines[i]) {
    s.revealed[i] = true;
    s.owner[i] = p;
    s.scores[p]++;
    s.last = { type: 'mine', cells: [i], player: p, origin: i };
    checkWin(s);
  } else {
    const cells = floodReveal(s, i);
    s.last = { type: 'safe', cells, player: p, origin: i };
    s.turn = 1 - p;
  }
  return s.last;
}

export function canBomb(s, p) {
  return s.status === 'playing' && s.turn === p && s.bombs[p] && s.scores[p] <= s.scores[1 - p];
}

export function bombCells(center) {
  const x0 = center % W, y0 = (center / W) | 0, out = [];
  for (let dy = -BOMB_RADIUS; dy <= BOMB_RADIUS; dy++) {
    for (let dx = -BOMB_RADIUS; dx <= BOMB_RADIUS; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x >= 0 && x < W && y >= 0 && y < H) out.push(y * W + x);
    }
  }
  return out;
}

export function bomb(s, center, p) {
  if (!canBomb(s, p) || center < 0 || center >= SIZE) return null;
  s.seq++;
  if (!s.moves) s.moves = [];
  s.moves.push({ t: 'b', i: center, p });
  s.bombs[p] = false;
  const cells = [], minesHit = [];
  for (const i of bombCells(center)) {
    if (s.revealed[i]) continue;
    if (s.mines[i]) {
      s.revealed[i] = true;
      s.owner[i] = p;
      s.scores[p]++;
      minesHit.push(i);
      cells.push(i);
    } else {
      cells.push(...floodReveal(s, i));
    }
  }
  s.last = { type: 'bomb', center, cells, minesHit, player: p };
  checkWin(s);
  if (s.status === 'playing') s.turn = 1 - p;
  return s.last;
}

export function minesLeft(s) {
  return MINES - s.scores[0] - s.scores[1];
}
