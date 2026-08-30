import { SIZE, W, H, BOMB_RADIUS, WIN_SCORE, neighbors, canBomb, minesLeft, bombCells } from './game.js';

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

/* ---------------- Expert AI: exact combinatorial probabilities ----------------
 *
 * Enumerates every mine assignment of the constrained border cells that is
 * consistent with the revealed numbers (per connected component), then weights
 * each joint configuration by C(freeCells, minesLeft - borderMines) for the
 * unconstrained remainder. The resulting per-cell marginals are exact, which
 * the single-constraint heuristic above is not: it captures cross-constraint
 * deductions (1-2-1 patterns etc.) and the global mine-count.
 */

const logFact = new Float64Array(600);
for (let i = 2; i < 600; i++) logFact[i] = logFact[i - 1] + Math.log(i);
function nCr(n, r) {
  if (r < 0 || r > n || n < 0) return 0;
  return Math.exp(logFact[n] - logFact[r] - logFact[n - r]);
}

const COMPONENT_CAP = 26;

function buildComponents(s) {
  const constraints = [];
  for (let i = 0; i < SIZE; i++) {
    if (!s.revealed[i] || s.mines[i] || s.adj[i] === 0) continue;
    const ns = neighbors(i);
    const found = ns.reduce((n, j) => n + (s.owner[j] >= 0 ? 1 : 0), 0);
    const cells = ns.filter(j => !s.revealed[j]);
    if (cells.length) constraints.push({ cells, req: s.adj[i] - found });
  }
  const cellToCons = new Map();
  constraints.forEach((c, ci) => c.cells.forEach(j => {
    if (!cellToCons.has(j)) cellToCons.set(j, []);
    cellToCons.get(j).push(ci);
  }));
  const seen = new Array(constraints.length).fill(false);
  const components = [];
  for (let start = 0; start < constraints.length; start++) {
    if (seen[start]) continue;
    const consIdxs = [], cellList = [], cellIdx = new Map();
    const queue = [start];
    seen[start] = true;
    while (queue.length) {
      const ci = queue.shift();
      consIdxs.push(ci);
      for (const j of constraints[ci].cells) {
        if (!cellIdx.has(j)) { cellIdx.set(j, cellList.length); cellList.push(j); }
        for (const other of cellToCons.get(j)) {
          if (!seen[other]) { seen[other] = true; queue.push(other); }
        }
      }
    }
    components.push({
      cells: cellList,
      cons: consIdxs.map(ci => ({
        idxs: constraints[ci].cells.map(j => cellIdx.get(j)),
        req: constraints[ci].req,
      })),
    });
  }
  return { components, borderSet: new Set(cellToCons.keys()) };
}

// Enumerate all consistent 0/1 assignments of one component's cells.
// Returns count[k] = #solutions with k mines, cellCount[k][j] = #solutions
// with k mines where local cell j is a mine.
function enumerateComponent(comp) {
  const n = comp.cells.length;
  const count = new Float64Array(n + 1);
  const cellCount = Array.from({ length: n + 1 }, () => new Float64Array(n));
  const cellCons = Array.from({ length: n }, () => []);
  const state = comp.cons.map(c => ({ req: c.req, remaining: c.idxs.length, have: 0 }));
  comp.cons.forEach((c, ci) => c.idxs.forEach(li => cellCons[li].push(ci)));

  if (n > COMPONENT_CAP) {
    // Too big to enumerate: fall back to per-constraint ratios, approximated
    // as a single fractional "solution" at the expected mine count.
    const p = new Float64Array(n);
    for (const c of comp.cons) {
      const ratio = c.req / c.idxs.length;
      for (const li of c.idxs) p[li] = Math.max(p[li], ratio);
    }
    const k = Math.min(n, Math.round(p.reduce((a, b) => a + b, 0)));
    count[k] = 1;
    for (let j = 0; j < n; j++) cellCount[k][j] = p[j];
    return { count, cellCount, exact: false };
  }

  const assign = new Uint8Array(n);
  let placed = 0;
  (function rec(i) {
    if (i === n) {
      count[placed]++;
      const cc = cellCount[placed];
      for (let j = 0; j < n; j++) if (assign[j]) cc[j]++;
      return;
    }
    outer: for (let v = 0; v <= 1; v++) {
      for (const ci of cellCons[i]) {
        const c = state[ci];
        if (c.have + v > c.req || c.have + v + c.remaining - 1 < c.req) continue outer;
      }
      for (const ci of cellCons[i]) { state[ci].have += v; state[ci].remaining--; }
      assign[i] = v; placed += v;
      rec(i + 1);
      placed -= v; assign[i] = 0;
      for (const ci of cellCons[i]) { state[ci].have -= v; state[ci].remaining++; }
    }
  })(0);
  return { count, cellCount, exact: true };
}

function convolve(a, b) {
  const out = new Float64Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

export function exactProbs(s) {
  const M = minesLeft(s);
  const { components, borderSet } = buildComponents(s);
  const enums = components.map(enumerateComponent);
  let freeCells = 0;
  for (let i = 0; i < SIZE; i++) if (!s.revealed[i] && !borderSet.has(i)) freeCells++;

  const prob = new Array(SIZE).fill(-1);
  // Weight distribution over total border mines, per component and combined.
  let convAll = new Float64Array([1]);
  for (const e of enums) convAll = convolve(convAll, e.count);
  let W = 0;
  for (let k = 0; k < convAll.length; k++) W += convAll[k] * nCr(freeCells, M - k);
  if (!(W > 0)) return { ...analyze(s), exact: false };

  for (let c = 0; c < components.length; c++) {
    let others = new Float64Array([1]);
    for (let o = 0; o < components.length; o++) if (o !== c) others = convolve(others, enums[o].count);
    const { count, cellCount } = enums[c];
    // T[k] = weight of all configurations of everything-but-this-component
    // when this component holds k mines.
    const T = new Float64Array(count.length);
    for (let k = 0; k < count.length; k++) {
      for (let ko = 0; ko < others.length; ko++) T[k] += others[ko] * nCr(freeCells, M - k - ko);
    }
    components[c].cells.forEach((cell, j) => {
      let sum = 0;
      for (let k = 0; k < count.length; k++) if (cellCount[k][j]) sum += cellCount[k][j] * T[k];
      prob[cell] = Math.min(1, Math.max(0, sum / W));
    });
  }

  let outsideP = 0;
  if (freeCells > 0) {
    let sum = 0;
    for (let k = 0; k < convAll.length; k++) sum += convAll[k] * nCr(freeCells - 1, M - k - 1);
    outsideP = sum / W;
  }
  for (let i = 0; i < SIZE; i++) {
    if (!s.revealed[i] && prob[i] < 0) prob[i] = outsideP;
  }

  const certainMines = [];
  for (let i = 0; i < SIZE; i++) if (!s.revealed[i] && prob[i] > 0.999999) certainMines.push(i);
  return { prob, certainMines, exact: enums.every(e => e.exact) };
}

// Move scoring: a press is worth its mine chance, minus what a miss would
// hand the opponent. A miss reveals a number (more informative the more
// hidden neighbors it touches) and can dive into a flood if the cell turns
// out to be a zero. Weights tuned by self-play against the plain
// max-probability policy.
export const EXPERT_TUNING = { mine: 10, info: 0.05, flood: 2 };

// Bomb doctrine: the engine only allows bombing while not leading; on top of
// that, only spend it when the moment is right —
//   winReach:  the blast is expected to finish the game outright
//   juicy:     an unusually mine-dense window (well above the ~5 a blind
//              early bomb averages) has been identified
//   desperate: far behind or the opponent is closing on 26; take any decent area
//   endgame:   few cells left and the best press is a coin flip — the bomb
//              grabs a large share of the remaining mines with zero guessing
export const BOMB_TUNING = {
  minE: 2, juicy: 6.5,
  desperateDeficit: 5, desperateScore: 20, desperateE: 3,
  endUnrevealed: 45, endGuess: 0.55, endShare: 0.45,
};

function bestBombWindow(s, prob) {
  let best = { center: -1, expected: -1 };
  for (let y = BOMB_RADIUS; y < H - BOMB_RADIUS; y++) {
    for (let x = BOMB_RADIUS; x < W - BOMB_RADIUS; x++) {
      const center = y * W + x;
      let expected = 0;
      for (const i of bombCells(center)) if (!s.revealed[i]) expected += prob[i];
      if (expected > best.expected) best = { center, expected };
    }
  }
  return best;
}

export function considerBomb(s, p, prob, bt = BOMB_TUNING) {
  const { center, expected } = bestBombWindow(s, prob);
  if (center < 0 || expected < bt.minE) return null;
  const move = { type: 'bomb', index: center };
  if (s.scores[p] + expected >= WIN_SCORE) return move;
  if (expected >= bt.juicy) return move;
  const deficit = s.scores[1 - p] - s.scores[p];
  if ((deficit >= bt.desperateDeficit || s.scores[1 - p] >= bt.desperateScore) && expected >= bt.desperateE) return move;
  let unrevealed = 0, pBest = 0;
  for (let i = 0; i < SIZE; i++) {
    if (s.revealed[i]) continue;
    unrevealed++;
    if (prob[i] > pBest) pBest = prob[i];
  }
  if (unrevealed <= bt.endUnrevealed && pBest <= bt.endGuess &&
      expected >= Math.max(bt.minE, minesLeft(s) * bt.endShare)) return move;
  return null;
}

export function aiMoveExpert(s, p, rng = Math.random, opts = {}) {
  if (s.status !== 'playing' || s.turn !== p) return null;
  const tuning = opts.tuning || EXPERT_TUNING;
  const { prob, certainMines } = exactProbs(s);

  if (certainMines.length) {
    return { type: 'reveal', index: certainMines[(rng() * certainMines.length) | 0] };
  }

  if (canBomb(s, p)) {
    const move = considerBomb(s, p, prob, opts.bomb || BOMB_TUNING);
    if (move) return move;
  }

  const scores = new Array(SIZE).fill(-Infinity);
  let best = -Infinity;
  for (let i = 0; i < SIZE; i++) {
    if (s.revealed[i]) continue;
    const pm = prob[i];
    const ns = neighbors(i);
    let pZero = 0, hiddenN = 0;
    if (!ns.some(j => s.owner[j] >= 0)) {
      pZero = 1;
      for (const j of ns) if (!s.revealed[j]) pZero *= 1 - prob[j];
    }
    for (const j of ns) if (!s.revealed[j]) hiddenN++;
    const missCost = (1 - pm) * (tuning.info * hiddenN + tuning.flood * pZero);
    scores[i] = tuning.mine * pm - missCost;
    if (scores[i] > best) best = scores[i];
  }
  const candidates = [];
  for (let i = 0; i < SIZE; i++) {
    if (!s.revealed[i] && scores[i] >= best - 0.05) candidates.push(i);
  }
  if (!candidates.length) return null;
  return { type: 'reveal', index: candidates[(rng() * candidates.length) | 0] };
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
