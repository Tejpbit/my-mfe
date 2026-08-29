import { SIZE, W, H, BOMB_RADIUS, neighbors, canBomb, minesLeft, bombCells } from './game.js';

// The AI only uses public information: revealed numbers and flagged mines.
export function analyze(s) {
  const prob = new Array(SIZE).fill(-1);
  const locked = new Array(SIZE).fill(false);
  let unrevealedTotal = 0;
  for (let i = 0; i < SIZE; i++) if (!s.revealed[i]) unrevealedTotal++;
  const prior = unrevealedTotal ? minesLeft(s) / unrevealedTotal : 0;

  for (let i = 0; i < SIZE; i++) {
    if (!s.revealed[i] || s.mines[i] || s.adj[i] === 0) continue;
    const ns = neighbors(i);
    const found = ns.reduce((n, j) => n + (s.owner[j] >= 0 ? 1 : 0), 0);
    const hidden = ns.filter(j => !s.revealed[j]);
    if (!hidden.length) continue;
    const remaining = s.adj[i] - found;
    const p = remaining / hidden.length;
    for (const j of hidden) {
      if (remaining <= 0) { prob[j] = 0; locked[j] = true; }
      else if (!locked[j]) prob[j] = Math.max(prob[j], p);
      if (p >= 1) locked[j] = true;
    }
  }

  const certainMines = [];
  for (let i = 0; i < SIZE; i++) {
    if (s.revealed[i]) continue;
    if (prob[i] < 0) prob[i] = prior;
    if (prob[i] >= 1) certainMines.push(i);
  }
  return { prob, certainMines };
}

function bestBombTarget(s, prob) {
  let best = { center: -1, expected: -1 };
  for (let y = BOMB_RADIUS; y < H - BOMB_RADIUS; y++) {
    for (let x = BOMB_RADIUS; x < W - BOMB_RADIUS; x++) {
      const c = y * W + x;
      let expected = 0;
      for (const i of bombCells(c)) if (!s.revealed[i]) expected += prob[i];
      if (expected > best.expected) best = { center: c, expected };
    }
  }
  return best;
}

export function aiMove(s, p, rng = Math.random) {
  if (s.status !== 'playing' || s.turn !== p) return null;
  const { prob, certainMines } = analyze(s);

  if (certainMines.length) {
    return { type: 'reveal', index: certainMines[(rng() * certainMines.length) | 0] };
  }

  if (canBomb(s, p)) {
    const deficit = s.scores[1 - p] - s.scores[p];
    if (deficit >= 4 || s.scores[1 - p] >= 20) {
      const best = bestBombTarget(s, prob);
      if (best.center >= 0 && best.expected >= 3) return { type: 'bomb', index: best.center };
    }
  }

  let max = -1;
  for (let i = 0; i < SIZE; i++) if (!s.revealed[i] && prob[i] > max) max = prob[i];
  const candidates = [];
  for (let i = 0; i < SIZE; i++) {
    if (!s.revealed[i] && prob[i] >= max - 0.03) candidates.push(i);
  }
  if (!candidates.length) return null;
  return { type: 'reveal', index: candidates[(rng() * candidates.length) | 0] };
}
