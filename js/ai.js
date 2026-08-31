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

const COMPONENT_CAP = 34;
const NODE_BUDGET = 250000;

function buildConstraints(s) {
  const constraints = [];
  for (let i = 0; i < SIZE; i++) {
    if (!s.revealed[i] || s.mines[i] || s.adj[i] === 0) continue;
    const ns = neighbors(i);
    const found = ns.reduce((n, j) => n + (s.owner[j] >= 0 ? 1 : 0), 0);
    const cells = ns.filter(j => !s.revealed[j]);
    if (cells.length) constraints.push({ cells, req: s.adj[i] - found });
  }
  return constraints;
}

// Iterate the two forcing rules to a fixpoint: a satisfied number makes its
// remaining cells safe, a number needing all its remaining cells makes them
// mines. This resolves cells outright AND splits the border into far smaller
// components before enumeration.
function propagate(constraints) {
  const forced = new Map();
  let changed = true, guard = 0;
  while (changed && guard++ < 300) {
    changed = false;
    for (const c of constraints) {
      const cells = c.cells.filter(j => !forced.has(j));
      if (!cells.length) continue;
      const req = c.req - c.cells.reduce((n, j) => n + (forced.get(j) === 1 ? 1 : 0), 0);
      if (req <= 0) {
        for (const j of cells) forced.set(j, 0);
        changed = true;
      } else if (req >= cells.length) {
        for (const j of cells) forced.set(j, 1);
        changed = true;
      }
    }
  }
  const reduced = [];
  for (const c of constraints) {
    const cells = c.cells.filter(j => !forced.has(j));
    if (!cells.length) continue;
    const req = c.req - c.cells.reduce((n, j) => n + (forced.get(j) === 1 ? 1 : 0), 0);
    reduced.push({ cells, req: Math.max(0, Math.min(req, cells.length)) });
  }
  return { forced, reduced };
}

function buildComponentsFrom(constraints) {
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
  return components;
}

// Enumerate all consistent 0/1 assignments of one component's cells.
// Returns count[k] = #solutions with k mines, cellCount[k][j] = #solutions
// with k mines where local cell j is a mine.
function heuristicComponent(comp) {
  // Last resort for a component too tangled to enumerate: per-constraint
  // ratios, approximated as a single fractional "solution".
  const n = comp.cells.length;
  const count = new Float64Array(n + 1);
  const cellCount = Array.from({ length: n + 1 }, () => new Float64Array(n));
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

function enumerateComponent(comp) {
  const n = comp.cells.length;
  if (n > COMPONENT_CAP) return heuristicComponent(comp);
  const count = new Float64Array(n + 1);
  const cellCount = Array.from({ length: n + 1 }, () => new Float64Array(n));
  const cellCons = Array.from({ length: n }, () => []);
  const state = comp.cons.map(c => ({ req: c.req, remaining: c.idxs.length, have: 0 }));
  comp.cons.forEach((c, ci) => c.idxs.forEach(li => cellCons[li].push(ci)));

  const assign = new Uint8Array(n);
  let placed = 0, nodes = 0, aborted = false;
  (function rec(i) {
    if (aborted || ++nodes > NODE_BUDGET) { aborted = true; return; }
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
  if (aborted) return heuristicComponent(comp);
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
  const { forced, reduced } = propagate(buildConstraints(s));
  const components = buildComponentsFrom(reduced);
  const enums = components.map(enumerateComponent);
  let forcedMines = 0;
  forced.forEach(v => { forcedMines += v; });
  const Mr = M - forcedMines;

  const inBorder = new Set(forced.keys());
  for (const comp of components) for (const j of comp.cells) inBorder.add(j);
  let freeCells = 0;
  for (let i = 0; i < SIZE; i++) if (!s.revealed[i] && !inBorder.has(i)) freeCells++;

  const prob = new Array(SIZE).fill(-1);
  forced.forEach((v, j) => { prob[j] = v; });

  // Weight distribution over total border mines, per component and combined.
  let convAll = new Float64Array([1]);
  for (const e of enums) convAll = convolve(convAll, e.count);
  let W = 0;
  for (let k = 0; k < convAll.length; k++) W += convAll[k] * nCr(freeCells, Mr - k);
  if (!(W > 0)) return { ...analyze(s), exact: false };

  for (let c = 0; c < components.length; c++) {
    let others = new Float64Array([1]);
    for (let o = 0; o < components.length; o++) if (o !== c) others = convolve(others, enums[o].count);
    const { count, cellCount } = enums[c];
    // T[k] = weight of all configurations of everything-but-this-component
    // when this component holds k mines.
    const T = new Float64Array(count.length);
    for (let k = 0; k < count.length; k++) {
      for (let ko = 0; ko < others.length; ko++) T[k] += others[ko] * nCr(freeCells, Mr - k - ko);
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
    for (let k = 0; k < convAll.length; k++) sum += convAll[k] * nCr(freeCells - 1, Mr - k - 1);
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
export const EXPERT_TUNING = { mine: 10, info: 0.05, flood: 2, freebie: 3 };

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
  const move = { type: 'bomb', index: center, expected };
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

export function floodRisk(s, prob, i) {
  const ns = neighbors(i);
  if (ns.some(j => s.owner[j] >= 0)) return 0;
  let pZero = 1;
  for (const j of ns) if (!s.revealed[j]) pZero *= 1 - prob[j];
  return pZero;
}

export function scoreCells(s, prob, tuning = EXPERT_TUNING) {
  const scores = new Array(SIZE).fill(-Infinity);
  // A miss can hand the opponent free mines: if a number needs all-but-one of
  // its hidden cells, revealing one of them safe makes the rest certain. This
  // is why a 50/50 pair guess has ~zero net expected value.
  const freebieAt = new Float64Array(SIZE);
  for (let j = 0; j < SIZE; j++) {
    if (!s.revealed[j] || s.mines[j] || s.adj[j] === 0) continue;
    const ns = neighbors(j);
    const found = ns.reduce((n, k) => n + (s.owner[k] >= 0 ? 1 : 0), 0);
    const hidden = ns.filter(k => !s.revealed[k]);
    const req = s.adj[j] - found;
    if (hidden.length >= 2 && req === hidden.length - 1) {
      for (const k of hidden) freebieAt[k] += req;
    }
  }
  let best = -Infinity, bestIndex = -1;
  for (let i = 0; i < SIZE; i++) {
    if (s.revealed[i]) continue;
    const pm = prob[i];
    let hiddenN = 0;
    for (const j of neighbors(i)) if (!s.revealed[j]) hiddenN++;
    const freebies = Math.min(freebieAt[i], 3);
    const missCost = (1 - pm) * (tuning.info * hiddenN + tuning.flood * floodRisk(s, prob, i) + (tuning.freebie || 0) * freebies);
    scores[i] = tuning.mine * pm - missCost;
    if (scores[i] > best) { best = scores[i]; bestIndex = i; }
  }
  return { scores, best, bestIndex };
}

// Which revealed number most strongly implicates `cell`? Used by the coach
// to explain WHY a cell is (un)likely to be a mine.
export function strongestConstraint(s, cell) {
  let best = -1, bestRatio = -1;
  for (const j of neighbors(cell)) {
    if (!s.revealed[j] || s.mines[j] || s.adj[j] === 0) continue;
    const ns = neighbors(j);
    const found = ns.reduce((n, k) => n + (s.owner[k] >= 0 ? 1 : 0), 0);
    const hidden = ns.filter(k => !s.revealed[k]).length;
    if (!hidden) continue;
    const ratio = (s.adj[j] - found) / hidden;
    if (ratio > bestRatio) { bestRatio = ratio; best = j; }
  }
  return best;
}

// Full derivation of one cell's odds, for training mode's "Why?" inspector.
export function explainCell(s, i) {
  if (s.revealed[i]) {
    if (s.mines[i] || s.adj[i] === 0) return null;
    const ns = neighbors(i);
    const found = ns.reduce((n, k) => n + (s.owner[k] >= 0 ? 1 : 0), 0);
    return { kind: 'number', total: s.adj[i], found, need: s.adj[i] - found, hiddenCells: ns.filter(k => !s.revealed[k]) };
  }
  const { prob, exact } = exactProbs(s);
  const M = minesLeft(s);
  let unknown = 0;
  for (let k = 0; k < SIZE; k++) if (!s.revealed[k]) unknown++;
  const cons = [];
  for (const j of neighbors(i)) {
    if (!s.revealed[j] || s.mines[j] || s.adj[j] === 0) continue;
    const ns2 = neighbors(j);
    const found = ns2.reduce((n, k) => n + (s.owner[k] >= 0 ? 1 : 0), 0);
    const hiddenCells = ns2.filter(k => !s.revealed[k]);
    if (hiddenCells.length) cons.push({ cell: j, num: s.adj[j], need: s.adj[j] - found, hiddenCells });
  }
  const { forced, reduced } = propagate(buildConstraints(s));
  const out = { kind: 'cell', p: prob[i], left: M, unknown, cons, exact };
  if (forced.has(i)) {
    out.forced = forced.get(i);
    return out;
  }
  let component = null;
  if (cons.length) {
    const comp = buildComponentsFrom(reduced).find(c => c.cells.includes(i));
    if (comp) {
      const e = enumerateComponent(comp);
      if (e.exact) {
        const li = comp.cells.indexOf(i);
        let layouts = 0, mineLayouts = 0;
        for (let k = 0; k < e.count.length; k++) { layouts += e.count[k]; mineLayouts += e.cellCount[k][li]; }
        component = { size: comp.cells.length, numbers: comp.cons.length, layouts, mineLayouts };
      }
    }
  }
  out.component = component;
  out.naive = cons.length ? Math.max(...cons.map(c => c.need / c.hiddenCells.length)) : (unknown ? M / unknown : 0);
  return out;
}

// Pre-move evaluation of a player's chosen move, for training mode.
export function coachEvaluate(s, move, p) {
  const { prob, certainMines } = exactProbs(s);
  const { scores, best, bestIndex } = scoreCells(s, prob);
  const bombAdvice = canBomb(s, p) ? considerBomb(s, p, prob) : null;
  const out = {
    prob, certainMines, bestIndex,
    bestProb: bestIndex >= 0 ? prob[bestIndex] : 0,
    bombAdvice,
    whyBest: bestIndex >= 0 ? strongestConstraint(s, bestIndex) : -1,
  };
  if (move.type === 'bomb') {
    let expected = 0;
    for (const i of bombCells(move.index)) if (!s.revealed[i]) expected += prob[i];
    const bw = bestBombWindow(s, prob);
    out.kind = 'bomb';
    out.bombExpected = expected;
    out.bombBest = bw;
    out.verdict = bombAdvice ? (expected >= bw.expected - 0.75 ? 'best' : 'inaccuracy')
      : (expected >= bw.expected - 0.5 && expected >= 4 ? 'good' : 'mistake');
    out.quality = Math.max(0, Math.min(1, (expected / Math.max(0.001, bw.expected)) * (bombAdvice ? 1 : 0.6)));
    return out;
  }
  out.kind = 'reveal';
  out.chosenProb = prob[move.index];
  out.chosenFloodRisk = floodRisk(s, prob, move.index);
  out.whyChosen = strongestConstraint(s, move.index);
  if (certainMines.length && out.chosenProb > 0.999) out.verdict = 'best';
  else if (certainMines.length) out.verdict = 'missed-certain';
  else if (bombAdvice && bombAdvice.expected >= 5) out.verdict = 'missed-bomb';
  else {
    const delta = best - scores[move.index];
    out.verdict = delta <= 0.25 ? 'best' : delta <= 0.8 ? 'good' : delta <= 1.8 ? 'inaccuracy' : 'mistake';
  }
  // Continuous move quality, outcome-independent: how close was the choice to
  // the best available? The expert score already prices in mine probability
  // and the cost of diving, so a lucky dive still loses points here.
  const delta = best - scores[move.index];
  out.quality = Math.max(0, Math.min(1, 1 - delta / 5));
  if (out.verdict === 'missed-bomb') out.quality = Math.min(out.quality, 0.4);
  return out;
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

  const { scores, best } = scoreCells(s, prob, tuning);
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
