import { SIZE, W, H, BOMB_RADIUS, WIN_SCORE, newGame, gameFromMines, reveal, bomb, canBomb, bombCells, clampBombCenter, minesLeft } from './game.js';
import { aiMove, aiMoveExpert, coachEvaluate, exactProbs, explainCell } from './ai.js';
import { Net } from './net.js';
import { sfx, setSoundEnabled } from './sound.js';

const $ = id => document.getElementById(id);
const DEFAULT_MQTT = 'wss://test.mosquitto.org:8081/mqtt';

const settings = {
  get name() { return localStorage.getItem('mfe-name') || 'Player'; },
  set name(v) { localStorage.setItem('mfe-name', v); },
  get mqtt() { return localStorage.getItem('mfe-mqtt') || DEFAULT_MQTT; },
  set mqtt(v) { localStorage.setItem('mfe-mqtt', v); },
  get sound() { return localStorage.getItem('mfe-sound') !== '0'; },
  set sound(v) { localStorage.setItem('mfe-sound', v ? '1' : '0'); },
  get aiSpeed() { return localStorage.getItem('mfe-aispeed') || 'normal'; },
  set aiSpeed(v) { localStorage.setItem('mfe-aispeed', v); },
  get id() {
    let id = localStorage.getItem('mfe-id');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('mfe-id', id); }
    return id;
  },
};

let state = null;
let mode = null;          // 'ai' | 'hot' | 'online'
let myPlayer = 0;         // seat in ai/online mode; ignored in hotseat
let net = null;
let aiming = -1;          // bomb aim cell, -1 = not aiming
let armed = false;        // bomb button pressed, waiting for target
let aiTimer = null;
let aiLevel = 'casual';
let coach = false;
let coachMarks = { best: -1, why: [], pick: -1, group: [], colors: {} };
let oddsOn = false;
let whyMode = false;
let oddsCache = { seq: -1, prob: null };
let saved = false;        // result recorded for current game

/* ---------- screens ---------- */
const screens = ['home', 'game', 'tutorial', 'settings', 'history'];
function show(name) {
  for (const s of screens) $(`screen-${s}`).hidden = s !== name;
  if (name === 'history') renderHistory();
  if (name === 'home') updateContinue();
  window.scrollTo(0, 0);
}

/* ---------- AI game persistence ---------- */
function saveAiGame() {
  if ((mode !== 'ai' && mode !== 'hot') || !state) return;
  if (state.status === 'over') { localStorage.removeItem('mfe-ai-save'); return; }
  localStorage.setItem('mfe-ai-save', JSON.stringify({ state, aiLevel, coach, gmode: mode, date: Date.now() }));
}

function updateContinue() {
  const btn = $('btn-continue');
  try {
    const raw = localStorage.getItem('mfe-ai-save');
    if (!raw) { btn.hidden = true; return; }
    const { state: st, aiLevel: lvl, coach: co, gmode } = JSON.parse(raw);
    const what = gmode === 'hot' ? 'local game' : co ? 'training' : `vs ${lvl === 'expert' ? 'AI Expert' : 'AI'}`;
    btn.textContent = `Continue ${what} · ${st.scores[0]}–${st.scores[1]}`;
    btn.hidden = false;
  } catch {
    btn.hidden = true;
  }
}

function resumeAiGame() {
  try {
    const { state: st, aiLevel: lvl, coach: co, gmode } = JSON.parse(localStorage.getItem('mfe-ai-save'));
    mode = gmode === 'hot' ? 'hot' : 'ai';
    myPlayer = 0; aiLevel = lvl === 'expert' ? 'expert' : 'casual';
    coach = mode === 'hot' ? false : !!co;
    state = st;
    resetFlags();
    show('game');
    render();
    scheduleAi();
  } catch {
    localStorage.removeItem('mfe-ai-save');
    updateContinue();
  }
}

/* ---------- board DOM ---------- */
const boardEl = $('board');
const cells = [];
for (let i = 0; i < SIZE; i++) {
  const b = document.createElement('button');
  b.className = 'cell';
  b.dataset.i = i;
  boardEl.appendChild(b);
  cells.push(b);
}
boardEl.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const el = e.target.closest('.cell');
  if (el) onCellTap(+el.dataset.i);
});

/* ---------- zoom & pan ---------- */
// The board keeps its layout size and is scaled/translated inside the
// viewport (.board-view); tx/ty are in viewport pixels, origin top-left.
const viewEl = $('board-view');
const ZOOM_MIN = 1, ZOOM_MAX = 4, ZOOM_PRESET = 2;
let zoom = 1, tx = 0, ty = 0;
let suppressClick = false;
const pointers = new Map();
let gesture = null;

function applyView() {
  const vw = viewEl.clientWidth;
  if (zoom <= 1.02) { zoom = 1; tx = 0; ty = 0; }
  tx = Math.min(0, Math.max(vw - vw * zoom, tx));
  ty = Math.min(0, Math.max(vw - vw * zoom, ty));
  boardEl.style.transform = zoom === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${zoom})`;
  viewEl.classList.toggle('zoomed', zoom > 1);
  const btn = $('btn-zoom');
  btn.classList.toggle('on', zoom > 1);
  btn.title = zoom > 1 ? 'Reset zoom' : 'Zoom in (pinch or scroll on the board for more)';
  btn.innerHTML = zoom > 1 ? `${zoom.toFixed(1)}×` : '<svg viewBox="0 0 24 24"><use href="#i-zoom"/></svg>';
}

// Zoom so that the board point under viewport position (cx, cy) stays put.
function zoomAt(z, cx, cy) {
  z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const bx = (cx - tx) / zoom, by = (cy - ty) / zoom;
  zoom = z;
  tx = cx - bx * z;
  ty = cy - by * z;
  applyView();
}

function resetZoom() {
  boardEl.classList.add('glide');
  zoom = 1; tx = 0; ty = 0;
  applyView();
}

// Bring a move into view when it lands outside the zoomed viewport: the
// origin cell decides (own taps are always visible, so only floods or the
// opponent's moves trigger it); the whole move is then centred.
function ensureVisible(last) {
  if (zoom === 1 || !last || !last.cells?.length) return;
  const vw = viewEl.clientWidth, cs = vw / W;
  const origin = last.type === 'bomb' ? last.center : (last.origin ?? last.cells[0]);
  const ox = tx + (origin % W) * cs * zoom, oy = ty + Math.floor(origin / W) * cs * zoom;
  if (ox >= 0 && oy >= 0 && ox + cs * zoom <= vw && oy + cs * zoom <= vw) return;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (const i of last.cells) {
    const x = i % W, y = Math.floor(i / W);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const midX = (minX + maxX + 1) / 2 * cs, midY = (minY + maxY + 1) / 2 * cs;
  boardEl.classList.add('glide');
  tx = vw / 2 - midX * zoom;
  ty = vw / 2 - midY * zoom;
  applyView();
}

function capture(id) {
  try { viewEl.setPointerCapture(id); } catch { }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const local = e => { const r = viewEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

viewEl.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  suppressClick = false;
  boardEl.classList.remove('glide');
  pointers.set(e.pointerId, local(e));
  const pts = [...pointers.values()];
  if (pts.length === 1) {
    gesture = { kind: 'pan', start: pts[0], tx, ty, moved: false };
  } else if (pts.length === 2) {
    for (const id of pointers.keys()) capture(id);
    gesture = { kind: 'pinch', mid: mid(pts[0], pts[1]), dist: dist(pts[0], pts[1]), zoom, tx, ty, moved: true };
    viewEl.classList.add('dragging');
  }
});

viewEl.addEventListener('pointermove', e => {
  if (!gesture || !pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, local(e));
  const pts = [...pointers.values()];
  if (gesture.kind === 'pinch' && pts.length >= 2) {
    const m = mid(pts[0], pts[1]);
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, gesture.zoom * dist(pts[0], pts[1]) / gesture.dist));
    const bx = (gesture.mid.x - gesture.tx) / gesture.zoom, by = (gesture.mid.y - gesture.ty) / gesture.zoom;
    zoom = z;
    tx = m.x - bx * z;
    ty = m.y - by * z;
    applyView();
  } else if (gesture.kind === 'pan') {
    const dx = pts[0].x - gesture.start.x, dy = pts[0].y - gesture.start.y;
    if (!gesture.moved) {
      if (zoom === 1 || Math.hypot(dx, dy) < 6) return;
      gesture.moved = true;
      capture(e.pointerId);
      viewEl.classList.add('dragging');
    }
    tx = gesture.tx + dx;
    ty = gesture.ty + dy;
    applyView();
  }
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (gesture?.moved) suppressClick = true;
  const pts = [...pointers.values()];
  if (pts.length === 1 && gesture) {
    gesture = { kind: 'pan', start: pts[0], tx, ty, moved: true };
  } else if (pts.length === 0) {
    gesture = null;
    viewEl.classList.remove('dragging');
  }
}
viewEl.addEventListener('pointerup', endPointer);
viewEl.addEventListener('pointercancel', endPointer);

viewEl.addEventListener('wheel', e => {
  let d = e.deltaY;
  if (e.deltaMode === 1) d *= 16;
  else if (e.deltaMode === 2) d *= window.innerHeight;
  d = Math.max(-100, Math.min(100, d));
  const k = e.ctrlKey ? 0.01 : 0.002;
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * Math.exp(-d * k)));
  if (z === zoom && zoom === 1) return;
  e.preventDefault();
  boardEl.classList.remove('glide');
  const { x, y } = local(e);
  zoomAt(z, x, y);
}, { passive: false });

window.addEventListener('resize', applyView);

$('btn-zoom').onclick = () => {
  sfx.tap();
  if (zoom > 1) { resetZoom(); return; }
  boardEl.classList.add('glide');
  const vw = viewEl.clientWidth;
  zoomAt(ZOOM_PRESET, vw / 2, vw / 2);
};
// Desktop: aiming follows the mouse while the bomb is armed. Touch keeps the
// two-tap flow (pointerType guard, since taps also emit pointerover).
boardEl.addEventListener('pointerover', e => {
  if (!armed || e.pointerType === 'touch' || e.pointerType === 'pen') return;
  const el = e.target.closest('.cell');
  if (!el) return;
  const center = clampBombCenter(+el.dataset.i);
  if (aiming !== center) {
    aiming = center;
    render();
  }
});

function render() {
  if (!state) return;
  const s = state;
  const aimSet = new Set(aiming >= 0 ? bombCells(aiming) : []);
  const lastSet = new Set(s.last ? s.last.cells : []);
  const origin = s.last && s.last.type !== 'bomb' ? (s.last.origin ?? s.last.cells[0]) : -1;
  const corners = {};
  if (s.last?.type === 'bomb') {
    const cx = s.last.center % W, cy = (s.last.center / W) | 0;
    const x0 = Math.max(0, cx - BOMB_RADIUS), x1 = Math.min(W - 1, cx + BOMB_RADIUS);
    const y0 = Math.max(0, cy - BOMB_RADIUS), y1 = Math.min(H - 1, cy + BOMB_RADIUS);
    corners[y0 * W + x0] = 'bc-tl';
    corners[y0 * W + x1] = 'bc-tr';
    corners[y1 * W + x0] = 'bc-bl';
    corners[y1 * W + x1] = 'bc-br';
  }
  for (let i = 0; i < SIZE; i++) {
    const el = cells[i];
    const wasRevealed = el.classList.contains('revealed');
    el.className = 'cell';
    el.textContent = '';
    el.style.boxShadow = '';
    el.style.background = '';
    if (s.revealed[i]) {
      el.classList.add('revealed');
      if (!wasRevealed) el.classList.add('pop');
      if (s.owner[i] >= 0) {
        el.classList.add(`flag-${s.owner[i]}`);
        el.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-flag"/></svg>';
      } else if (s.adj[i] > 0) {
        el.dataset.n = s.adj[i];
        el.textContent = s.adj[i];
      }
      if (lastSet.has(i)) {
        const x = i % W, y = (i / W) | 0;
        el.classList.add('lastr');
        if (y === 0 || !lastSet.has(i - W)) el.classList.add('lt');
        if (y === H - 1 || !lastSet.has(i + W)) el.classList.add('lb');
        if (x === 0 || !lastSet.has(i - 1)) el.classList.add('ll');
        if (x === W - 1 || !lastSet.has(i + 1)) el.classList.add('lr');
      }
      if (i === origin) el.classList.add('last');
    } else {
      delete el.dataset.n;
      if (aimSet.has(i)) el.classList.add('aim');
    }
    if (corners[i]) el.classList.add(corners[i]);
    if (coach) {
      if (i === coachMarks.best && !s.revealed[i]) el.classList.add('coach-best');
      if (coachMarks.why.includes(i)) el.classList.add('coach-why');
      if (i === coachMarks.pick) el.classList.add('coach-pick');
      if (coachMarks.group.includes(i)) el.classList.add('coach-group');
      const oc = coachMarks.colors[i];
      if (oc && oc.length) {
        el.style.boxShadow = oc.map((c, k) => `inset 0 0 0 ${2 * (k + 1)}px ${c}`).join(', ');
        if (!s.revealed[i]) el.style.background = `color-mix(in srgb, ${oc[0]} 22%, #2a3346)`;
      }
    }
  }

  if (coach && oddsOn && (mode === 'review' || (s.status === 'playing' && s.turn === myPlayer))) {
    if (oddsCache.seq !== s.seq) oddsCache = { seq: s.seq, prob: exactProbs(s).prob };
    for (let i = 0; i < SIZE; i++) {
      if (!s.revealed[i]) {
        cells[i].classList.add('oddsview');
        cells[i].textContent = Math.round(oddsCache.prob[i] * 100);
      }
    }
  }

  $('p0-score').textContent = s.scores[0];
  $('p1-score').textContent = s.scores[1];
  $('mines-left').textContent = minesLeft(s);
  $('p0-name').textContent = s.players[0]?.name || 'Red';
  $('p1-name').textContent = s.players[1]?.name || (mode === 'online' ? 'Waiting…' : 'Blue');
  $('player-0').classList.toggle('active', s.status === 'playing' && s.turn === 0);
  $('player-1').classList.toggle('active', s.status === 'playing' && s.turn === 1);
  $('scorebar-red').style.width = `${(s.scores[0] / WIN_SCORE) * 50}%`;
  $('scorebar-blue').style.width = `${(s.scores[1] / WIN_SCORE) * 50}%`;

  const banner = $('turn-banner');
  if (mode === 'review') {
    banner.textContent = `Reviewing · move ${review.step} of ${review.moves.length}`;
    banner.classList.remove('me');
  } else if (s.status === 'over') {
    banner.textContent = '';
  } else if (mode === 'online' && !s.players[1]) {
    banner.textContent = 'Waiting for opponent to join…';
    banner.classList.remove('me');
  } else if (mode === 'hot') {
    banner.textContent = `${s.players[s.turn]?.name || (s.turn === 0 ? 'Red' : 'Blue')}'s turn`;
    banner.classList.add('me');
  } else if (myPlayer < 0) {
    banner.textContent = `Observing · ${s.players[s.turn]?.name || (s.turn === 0 ? 'Red' : 'Blue')}'s turn`;
    banner.classList.remove('me');
  } else {
    const mine = s.turn === myPlayer;
    banner.textContent = mine ? 'Your turn' : `${s.players[1 - myPlayer]?.name || 'Opponent'} is thinking…`;
    banner.classList.toggle('me', mine);
  }

  const p = mode === 'hot' ? s.turn : myPlayer;
  const bombBtn = $('btn-bomb');
  bombBtn.classList.toggle('used', !s.bombs[p]);
  bombBtn.classList.toggle('armed', armed);
  bombBtn.disabled = !canBomb(s, p) || (mode !== 'hot' && s.turn !== myPlayer) || (mode === 'online' && !s.players[1]);
  $('bomb-hint').hidden = !armed;

  if (s.status === 'over') showGameOver();
}

/* ---------- moves ---------- */
function activePlayer() { return mode === 'hot' ? state.turn : myPlayer; }

function onCellTap(i) {
  if (!state) return;
  if (mode === 'review' || (whyMode && coach)) { explainAt(i); return; }
  if (state.status !== 'playing') return;
  if (mode === 'online' && !state.players[1]) return;
  const p = activePlayer();
  if (mode !== 'hot' && state.turn !== myPlayer) return;

  if (armed) {
    const center = clampBombCenter(i);
    if (aiming === center) {
      doMove({ type: 'bomb', index: center }, p);
      armed = false; aiming = -1;
    } else {
      aiming = center;
      sfx.tap();
      render();
    }
    return;
  }
  if (state.revealed[i]) return;
  doMove({ type: 'reveal', index: i }, p);
}

function doMove(move, p) {
  const evaluation = coach && p === myPlayer ? coachEvaluate(state, move, p) : null;
  const result = move.type === 'bomb' ? bomb(state, move.index, p) : reveal(state, move.index, p);
  if (!result) return;
  if (evaluation) showCoachFeedback(evaluation, move, result);
  playFx(result, p);
  render();
  if (mode === 'online') net?.publish({ t: 'state', state });
  saveAiGame();
  maybeSaveResult();
  scheduleAi();
}

function playFx(last, mover) {
  const meMoved = mode === 'hot' || mover === myPlayer;
  ensureVisible(last);
  if (last.type === 'bomb') sfx.bomb();
  else if (last.type === 'mine') sfx.mine(meMoved);
  else sfx.safe(last.cells.length);
  if (state.status === 'over') {
    const iWon = mode === 'hot' || myPlayer < 0 || state.winner === myPlayer;
    setTimeout(() => (iWon ? sfx.win() : sfx.lose()), 350);
    if (!iWon) $('screen-game').classList.add('shake');
  }
}

/* ---------- coach ---------- */
const pct = x => `${Math.round(x * 100)}%`;
const VERDICT_LABEL = {
  best: 'Best move.', good: 'Good.', inaccuracy: 'Inaccuracy.', mistake: 'Mistake.',
  'missed-certain': 'Missed a sure thing!', 'missed-bomb': 'Bomb moment missed!',
};

function clearMarks() {
  coachMarks = { best: -1, why: [], pick: -1, group: [], colors: {} };
}

const WHY_COLORS = ['#58d5c9', '#b48eff', '#ff8fab', '#6fd18a'];
const PICK_COLOR = '#ffb02e';
const GOOD_COLOR = '#6fd18a';
const chip = (text, color) => `<span class="chip" style="color:${color};border-color:${color}">${text}</span>`;

function addOverlay(i, color) {
  (coachMarks.colors[i] = coachMarks.colors[i] || []).push(color);
}

// Advice shared by live coaching and game review. Sets coach marks as a
// side effect; returns the explanation sentences (without the header).
function adviceParts(ev, move, result) {
  const parts = [];
  if (ev.kind === 'bomb') {
    if (ev.verdict === 'inaccuracy' || ev.verdict === 'mistake') {
      parts.push(`The richest 5×5 held ~${ev.bombBest.expected.toFixed(1)} expected mines — aim where the numbers point before spending it.`);
    }
    if (!ev.bombAdvice && ev.verdict !== 'good') {
      parts.push(`The coach would have held the bomb: it shines on dense areas, desperation, or endgame grabs that skip 50/50 guessing.`);
    }
  } else {
    if (ev.verdict === 'missed-certain') {
      coachMarks.best = ev.certainMines[0];
      if (ev.whyBest >= 0) coachMarks.why = [ev.whyBest];
      parts.push(`A ${chip('guaranteed mine', GOOD_COLOR)} was available — ${chip('this number', '#4da3ff')} accounts for every one of its hidden neighbors, so they must all be mines.`);
    } else if (ev.verdict === 'missed-bomb') {
      coachMarks.best = ev.bombAdvice.index;
      parts.push(`The bomb was ripe: ~${ev.bombAdvice.expected.toFixed(1)} expected mines around ${chip('the marked cell', GOOD_COLOR)}, with no guessing.`);
    } else if (ev.verdict !== 'best' && ev.bestIndex >= 0 && ev.bestIndex !== move.index) {
      coachMarks.best = ev.bestIndex;
      if (ev.whyBest >= 0) coachMarks.why = [ev.whyBest];
      parts.push(`Stronger was ${chip('the marked cell', GOOD_COLOR)}: ${pct(ev.bestProb)} odds${ev.whyBest >= 0 ? ` — ${chip('this number', '#4da3ff')} implicates it` : ''}.`);
    }
    if (ev.chosenFloodRisk > 0.35 && ev.verdict !== 'best') {
      parts.push(`Risky dive: ${pct(ev.chosenFloodRisk)} chance of blowing open an empty field${result.type === 'safe' && result.cells.length > 4 ? ` — and it opened ${result.cells.length} squares` : ''}.`);
    }
  }
  return parts;
}

function coachPanel(verdictHtml, parts, verdictClass) {
  const el = $('coach');
  el.className = `coach v-${verdictClass}`;
  el.innerHTML = `<span class="cv">${verdictHtml}</span>${parts.join(' ')}`;
  el.hidden = false;
}

function showCoachFeedback(ev, move, result) {
  clearMarks();
  const header = ev.kind === 'bomb'
    ? `Your blast was expected to net ~${ev.bombExpected.toFixed(1)} mines and got ${result.minesHit.length}.`
    : `Your press had ${pct(ev.chosenProb)} mine odds — ${result.type === 'mine' ? (ev.chosenProb < 0.3 ? 'lucky hit!' : 'and it paid off.') : 'no mine.'}`;
  coachPanel(VERDICT_LABEL[ev.verdict], [header, ...adviceParts(ev, move, result)], ev.verdict);
}

function explainAt(i) {
  const ex = explainCell(state, i);
  const el = $('coach');
  clearMarks();
  if (!ex) {
    el.className = 'coach v-good';
    el.innerHTML = '<span class="cv">Why?</span>Tap a covered cell to see where its odds come from, or a number to see what it still demands.';
    el.hidden = false;
    render();
    return;
  }
  const parts = [];
  if (ex.kind === 'number') {
    const color = WHY_COLORS[0];
    addOverlay(i, PICK_COLOR);
    for (const j of ex.hiddenCells) addOverlay(j, color);
    parts.push(`${chip('This ' + ex.total, PICK_COLOR)} touches ${ex.total} mine${ex.total > 1 ? 's' : ''}, ${ex.found} already flagged.`);
    parts.push(ex.need === 0
      ? `It's satisfied — the ${chip('shaded cells', color)} are all safe.`
      : ex.need === ex.hiddenCells.length
        ? `It still needs ${ex.need} — so the ${chip('shaded cells', color)} are ALL mines.`
        : `It still needs ${ex.need} of the ${ex.hiddenCells.length} ${chip('shaded cells', color)} (${pct(ex.need / ex.hiddenCells.length)} each, before combining).`);
  } else {
    addOverlay(i, PICK_COLOR);
    if (!ex.cons.length) {
      parts.push(`No number touches ${chip('this cell', PICK_COLOR)}. Only the global count speaks: ${ex.left} mines over ${ex.unknown} unknown cells ≈ ${pct(ex.p)}.`);
    } else {
      ex.cons.slice(0, WHY_COLORS.length).forEach((c, k) => {
        const color = WHY_COLORS[k];
        addOverlay(c.cell, color);
        for (const j of c.hiddenCells) addOverlay(j, color);
        parts.push(`${chip('The ' + c.num, color)} needs ${c.need} more of its ${c.hiddenCells.length} ${chip('shaded', color)} cells → ${pct(c.need / c.hiddenCells.length)} alone.`);
      });
      if (ex.forced === 0) {
        parts.push(`Deduction: other numbers already account for all their mines, ruling this cell out — provably safe → 0%.`);
      } else if (ex.forced === 1) {
        parts.push(`Deduction: once other numbers rule out the safe cells, a number needs ALL of its remaining hidden cells — provably a mine → 100%.`);
      } else if (ex.component && ex.component.layouts > 1) {
        const raw = ex.component.mineLayouts / ex.component.layouts;
        parts.push(`Counting every layout that satisfies all linked numbers: ${ex.component.layouts} exist, ${chip('this cell', PICK_COLOR)} is a mine in ${Math.round(ex.component.mineLayouts)}.`);
        parts.push(Math.abs(raw - ex.p) > 0.03
          ? `Layouts using fewer mines weigh more (more room for the other ${ex.left} mines elsewhere) → ${pct(ex.p)}.`
          : `→ ${pct(ex.p)}.`);
      } else if (ex.exact) {
        parts.push(`Combined exactly across overlapping numbers → ${pct(ex.p)}${ex.naive != null && Math.abs(ex.naive - ex.p) > 0.03 ? ` (naive read: ${pct(ex.naive)})` : ''}.`);
      } else {
        parts.push(`≈ ${pct(ex.p)} — this area is too tangled to enumerate fully, so this is an estimate.`);
      }
    }
  }
  el.className = 'coach v-good';
  el.innerHTML = `<span class="cv">Why ${ex.kind === 'cell' ? pct(ex.p) : 'this number'}?</span>${parts.join(' ')}`;
  el.hidden = false;
  render();
}

function showHint() {
  if (!state || state.status !== 'playing' || state.turn !== myPlayer) return;
  const move = aiMoveExpert(state, myPlayer);
  if (!move) return;
  clearMarks();
  coachMarks.best = move.index;
  const el = $('coach');
  el.className = 'coach v-good';
  el.innerHTML = move.type === 'bomb'
    ? `<span class="cv">Hint:</span> bomb the area around ${chip('the marked cell', GOOD_COLOR)} (~${move.expected.toFixed(1)} expected mines).`
    : `<span class="cv">Hint:</span> ${chip('the marked cell', GOOD_COLOR)} is the coach's pick (${pct(exactProbs(state).prob[move.index])} mine odds).`;
  el.hidden = false;
  render();
}

/* ---------- game review ---------- */
let review = null; // { mines, moves, players, myPlayer, gmode, step, evals }

function enterReview(data) {
  clearTimeout(aiTimer);
  net?.close();
  net = null;
  review = { ...data, step: data.moves.length, evals: {} };
  mode = 'review';
  coach = true;
  myPlayer = data.myPlayer ?? 0;
  resetFlags();
  $('btn-hint').hidden = true;
  buildTimeline();
  buildReviewChart();
  try { history.replaceState(null, '', `${location.pathname}?g=${encodeGame(review.mines, review.moves, review.players)}`); } catch { }
  show('game');
  stepTo(review.step);
}

// Evaluate every move once up front: powers the chart and makes stepping free.
function buildTimeline() {
  const s = gameFromMines(review.mines);
  s.players = review.players;
  review.timeline = [];
  review.moves.forEach((mv, j) => {
    const move = { type: mv.t === 'b' ? 'bomb' : 'reveal', index: mv.i };
    review.evals[j] = coachEvaluate(s, move, mv.p);
    if (mv.t === 'b') bomb(s, mv.i, mv.p); else reveal(s, mv.i, mv.p);
    review.timeline.push({ p: mv.p, verdict: review.evals[j].verdict, diff: s.scores[0] - s.scores[1] });
  });
}

function buildReviewChart() {
  const N = review.timeline.length;
  if (!N) { $('rv-chart').innerHTML = ''; return; }
  const MID = 12;
  const maxAbs = Math.max(1, ...review.timeline.map(t => Math.abs(t.diff)));
  const pts = review.timeline.map((t, j) => `${j + 1},${(MID - (t.diff / maxAbs) * (MID - 1.5)).toFixed(2)}`).join(' ');
  const tickColor = v => V_COLORS[v === 'best' ? 'best' : v === 'good' ? 'good' : v === 'inaccuracy' ? 'inaccuracy' : 'bad'];
  const ticks = review.timeline.map((t, j) =>
    `<rect x="${j + 0.15}" y="${t.p === 0 ? 29 : 43}" width="0.7" height="10" fill="${tickColor(t.verdict)}"/>`).join('');
  $('rv-chart').innerHTML = `
    <svg viewBox="0 0 ${N + 1} 56" preserveAspectRatio="none">
      <rect x="0" y="29" width="0.35" height="10" fill="var(--red)"/>
      <rect x="0" y="43" width="0.35" height="10" fill="var(--blue)"/>
      <line x1="0" y1="${MID}" x2="${N + 1}" y2="${MID}" stroke="rgba(139,152,169,0.4)" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
      <polyline points="0.5,${MID} ${pts}" fill="none" stroke="#aeb9c7" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
      ${ticks}
      <line id="rv-cursor" x1="0" y1="0" x2="0" y2="56" stroke="var(--gold)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>`;
  $('rv-chart').onclick = e => {
    const r = $('rv-chart').getBoundingClientRect();
    sfx.tap();
    stepTo(Math.round(((e.clientX - r.left) / r.width) * (N + 1)));
  };
}

function replayTo(k) {
  const s = gameFromMines(review.mines);
  s.players = review.players;
  let ev = null, res = null;
  for (let j = 0; j < k; j++) {
    const mv = review.moves[j];
    const move = { type: mv.t === 'b' ? 'bomb' : 'reveal', index: mv.i };
    if (j === k - 1) ev = review.evals[j] ??= coachEvaluate(s, move, mv.p);
    res = mv.t === 'b' ? bomb(s, mv.i, mv.p) : reveal(s, mv.i, mv.p);
  }
  return { s, ev, res };
}

function stepTo(k) {
  k = Math.max(0, Math.min(k, review.moves.length));
  review.step = k;
  const { s, ev, res } = replayTo(k);
  state = s;
  oddsCache = { seq: -1, prob: null };
  clearMarks();
  ensureVisible(res);
  $('review-label').textContent = `${k}/${review.moves.length}`;
  const slider = $('rv-slider');
  slider.max = review.moves.length;
  if (+slider.value !== k) slider.value = k;
  const cursor = document.getElementById('rv-cursor');
  if (cursor) { cursor.setAttribute('x1', k); cursor.setAttribute('x2', k); }
  if (k === 0) {
    coachPanel('Review.', ['Step through the game with the arrows. Tap any cell to ask why, or toggle Odds.'], 'good');
  } else {
    const mv = review.moves[k - 1];
    const name = esc(s.players[mv.p]?.name || (mv.p === 0 ? 'Red' : 'Blue'));
    const header = ev.kind === 'bomb'
      ? `${name} bombed: ~${ev.bombExpected.toFixed(1)} expected, got ${res.minesHit.length}.`
      : `${name} pressed at ${pct(ev.chosenProb)} odds — ${res.type === 'mine' ? 'mine!' : `no mine${res.cells.length > 4 ? `, opened ${res.cells.length} squares` : ''}.`}`;
    coachMarks.pick = mv.i;
    coachPanel(VERDICT_LABEL[ev.verdict], [header, ...adviceParts(ev, { type: mv.t === 'b' ? 'bomb' : 'reveal', index: mv.i }, res)], ev.verdict);
  }
  render();
}

/* ---------- game sharing ---------- */
// Compact binary: version, two length-prefixed UTF-8 names, 32-byte mine
// bitmap, 2-byte move count, one byte (cell index) per move, then the
// ordinals of bomb moves. Players are derivable by replaying (mover = turn).
function encodeGame(mines, moves, players) {
  const enc = new TextEncoder();
  const na = enc.encode((players[0]?.name || 'Red').slice(0, 16));
  const nb = enc.encode((players[1]?.name || 'Blue').slice(0, 16));
  const bombs = moves.map((m, j) => (m.t === 'b' ? j : -1)).filter(j => j >= 0);
  const bytes = [1, na.length, ...na, nb.length, ...nb];
  for (let byte = 0; byte < 32; byte++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) if (mines[byte * 8 + bit]) v |= 1 << bit;
    bytes.push(v);
  }
  bytes.push(moves.length >> 8, moves.length & 0xff);
  for (const m of moves) bytes.push(m.i);
  bytes.push(bombs.length);
  for (const j of bombs) bytes.push(j >> 8, j & 0xff);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeGame(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  let o = 0;
  if (bytes[o++] !== 1) throw new Error('version');
  const dec = new TextDecoder();
  const la = bytes[o++]; const nameA = dec.decode(bytes.slice(o, o + la)); o += la;
  const lb = bytes[o++]; const nameB = dec.decode(bytes.slice(o, o + lb)); o += lb;
  const mines = new Array(SIZE).fill(false);
  for (let byte = 0; byte < 32; byte++, o++) {
    for (let bit = 0; bit < 8; bit++) if (bytes[o] & (1 << bit)) mines[byte * 8 + bit] = true;
  }
  const n = (bytes[o] << 8) | bytes[o + 1]; o += 2;
  const idx = [...bytes.slice(o, o + n)]; o += n;
  const bombSet = new Set();
  const bc = bytes[o++];
  for (let k = 0; k < bc; k++, o += 2) bombSet.add((bytes[o] << 8) | bytes[o + 1]);
  const s = gameFromMines(mines);
  const moves = [];
  idx.forEach((i, j) => {
    const t = bombSet.has(j) ? 'b' : 'r';
    const p = s.turn;
    const res = t === 'b' ? bomb(s, i, p) : reveal(s, i, p);
    if (!res) throw new Error('bad move ' + j);
    moves.push({ t, i, p });
  });
  return { mines, moves, players: [{ name: nameA }, { name: nameB }], myPlayer: 0, gmode: 'shared' };
}

function shareText() {
  const { s } = replayTo(review.moves.length);
  const url = `${location.origin}${location.pathname}?g=${encodeGame(review.mines, review.moves, review.players)}`;
  const nameA = s.players[0]?.name || 'Red', nameB = s.players[1]?.name || 'Blue';
  const winner = s.winner != null ? ` · ${s.players[s.winner]?.name || (s.winner === 0 ? 'Red' : 'Blue')} wins 🏆` : '';
  const per = computeStats(review.mines, review.moves, review.players);
  const line = (st, name) =>
    `${name}: 🎯 ${Math.round(performanceScore(st) * 100)}% · 🧠 ${st.read} well-read · 🍀 ${st.lucky} lucky · 🌊 ${st.dives} dive${st.dives === 1 ? '' : 's'} · 🙈 ${st['missed-certain'] + st['missed-bomb']} missed`;
  return `Minesweeper Flags Extreme\n${nameA} ${s.scores[0]} – ${s.scores[1]} ${nameB}${winner}\n${line(per[0], nameA)}\n${line(per[1], nameB)}\n\nWatch the replay: ${url}`;
}

async function copyReviewGame() {
  const text = shareText();
  const url = text.slice(text.indexOf('http'));
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('rv-copy');
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = '📋'; }, 1500);
  } catch {
    coachPanel('Copy failed.', [`Your browser blocked the clipboard — here is the link: ${url}`], 'inaccuracy');
  }
}

function emptyStats() {
  return { n: 0, qSum: 0, best: 0, good: 0, inaccuracy: 0, mistake: 0, 'missed-certain': 0, 'missed-bomb': 0, dives: 0, divesOpened: 0, lucky: 0, read: 0 };
}

function computeStats(mines, moves, players) {
  const s = gameFromMines(mines);
  s.players = players;
  const per = [emptyStats(), emptyStats()];
  for (const mv of moves) {
    const move = { type: mv.t === 'b' ? 'bomb' : 'reveal', index: mv.i };
    const ev = coachEvaluate(s, move, mv.p);
    const st = per[mv.p];
    st.n++;
    st.qSum += ev.quality ?? 0;
    st[ev.verdict] = (st[ev.verdict] || 0) + 1;
    const res = mv.t === 'b' ? bomb(s, mv.i, mv.p) : reveal(s, mv.i, mv.p);
    if (ev.kind === 'reveal') {
      if (ev.chosenFloodRisk > 0.35) {
        st.dives++;
        if (res.type === 'safe' && res.cells.length >= 5) st.divesOpened++;
      }
      if (res.type === 'mine' && ev.chosenProb < 0.3) st.lucky++;
      if (res.type === 'mine' && ev.chosenProb >= 0.55) st.read++;
    }
  }
  return per;
}

const V_COLORS = { best: '#6fd18a', good: '#4da3ff', inaccuracy: '#ffb02e', bad: '#ff5470' };

function performanceScore(st) {
  return st.n ? st.qSum / st.n : 0;
}

function statsBoxHtml(per, s, meSeat) {
  const opp = 1 - meSeat;
  const seatColor = seat => (seat === 0 ? 'var(--red)' : 'var(--blue)');
  const name = seat => esc(s.players[seat]?.name || (seat === 0 ? 'Red' : 'Blue'));
  const leftName = mode === 'hot' || mode === 'review' ? name(meSeat) : 'You';
  const a = per[meSeat], b = per[opp];

  const segs = st => {
    const bad = st.mistake + st['missed-certain'] + st['missed-bomb'];
    return [['best', st.best], ['good', st.good], ['inaccuracy', st.inaccuracy], ['bad', bad]];
  };
  const vbar = st => `<div class="vbar">${segs(st).filter(([, v]) => v > 0)
    .map(([k, v]) => `<div class="vseg" style="flex:${v};background:${V_COLORS[k]}"></div>`).join('') || '<div class="vseg" style="flex:1;background:var(--line)"></div>'}</div>`;

  const TIPS = {
    performance: 'Average move quality, 0-100%. Every move is compared to the best available move at that moment, judged before the outcome: risk costs points even when it pays off, and taking the best available guess scores full marks.',
    missed: 'Guaranteed mines or clearly ripe bombs that were available but not taken.',
    dives: 'Presses with a high chance of blowing open an empty area, handing the opponent free information. Counted whether or not it actually blew open — and even if the press hit a mine.',
    lucky: 'Mines found on presses with under 30% odds: bad guess, good result.',
    read: 'Mines found on presses with at least 55% odds: earned by reading the board.',
  };
  const rows = [
    ['Missed chances', st => st['missed-certain'] + st['missed-bomb'], TIPS.missed],
    ['Risky dives', st => st.dives, TIPS.dives],
    ['Lucky hits', st => st.lucky, TIPS.lucky],
    ['Well-read hits', st => st.read, TIPS.read],
  ];
  const cmp = rows.map(([label, f, tip]) => {
    const va = f(a), vb = f(b), max = Math.max(va, vb, 1);
    return `<div class="cmp" title="${tip}">
      <span class="cmp-v">${va}</span>
      <div class="cmp-bar l"><i style="width:${(va / max) * 100}%;background:${seatColor(meSeat)}"></i></div>
      <span class="cmp-label">${label}</span>
      <div class="cmp-bar r"><i style="width:${(vb / max) * 100}%;background:${seatColor(opp)}"></i></div>
      <span class="cmp-v">${vb}</span>
    </div>`;
  }).join('');
  const help = `<details class="stats-help"><summary>What do these numbers mean?</summary>
    <p><b>Performance</b> — ${TIPS.performance}</p>
    <p><b>Missed chances</b> — ${TIPS.missed}</p>
    <p><b>Risky dives</b> — ${TIPS.dives}</p>
    <p><b>Lucky hits</b> — ${TIPS.lucky}</p>
    <p><b>Well-read hits</b> — ${TIPS.read}</p>
  </details>`;

  return `
    <div class="acc-row">
      <div class="acc"><span class="acc-num" style="color:${seatColor(meSeat)}">${Math.round(performanceScore(a) * 100)}%</span><span class="acc-name">${leftName}</span></div>
      <span class="acc-label" title="${TIPS.performance}">performance</span>
      <div class="acc right"><span class="acc-num" style="color:${seatColor(opp)}">${Math.round(performanceScore(b) * 100)}%</span><span class="acc-name">${name(opp)}</span></div>
    </div>
    <div class="vbar-line"><span class="vbar-name">${leftName}</span>${vbar(a)}</div>
    <div class="vbar-line"><span class="vbar-name">${name(opp)}</span>${vbar(b)}</div>
    <div class="legend">
      <span><i style="background:${V_COLORS.best}"></i>best</span>
      <span><i style="background:${V_COLORS.good}"></i>good</span>
      <span><i style="background:${V_COLORS.inaccuracy}"></i>inaccurate</span>
      <span><i style="background:${V_COLORS.bad}"></i>poor/missed</span>
    </div>
    ${cmp}
    ${help}`;
}

/* ---------- AI ---------- */
const AI_DELAYS = { instant: [60, 40], fast: [220, 220], normal: [600, 700], slow: [1300, 1200] };

function scheduleAi() {
  if (mode !== 'ai' || !state || state.status !== 'playing' || state.turn === myPlayer) return;
  clearTimeout(aiTimer);
  const [base, jitter] = AI_DELAYS[settings.aiSpeed] || AI_DELAYS.normal;
  aiTimer = setTimeout(() => {
    const move = (aiLevel === 'expert' ? aiMoveExpert : aiMove)(state, 1 - myPlayer);
    if (!move) return;
    const result = move.type === 'bomb' ? bomb(state, move.index, 1 - myPlayer) : reveal(state, move.index, 1 - myPlayer);
    if (result) {
      playFx(result, 1 - myPlayer);
      render();
      saveAiGame();
      maybeSaveResult();
      scheduleAi();
    }
  }, base + Math.random() * jitter);
}

/* ---------- game over / history ---------- */
function showGameOver() {
  if (mode === 'review') return;
  const s = state;
  const over = $('gameover');
  if (!over.hidden) return;
  const neutral = mode === 'hot' || myPlayer < 0;
  const iWon = neutral || s.winner === myPlayer;
  const winName = s.players[s.winner]?.name || (s.winner === 0 ? 'Red' : 'Blue');
  $('gameover-title').textContent = neutral ? `${winName} wins!` : iWon ? 'Victory!' : 'Defeat';
  $('btn-rematch').hidden = myPlayer < 0;
  if (s.moves?.length) {
    try { history.replaceState(null, '', `${location.pathname}?g=${encodeGame(s.mines, s.moves, s.players)}`); } catch { }
  }
  $('gameover-sub').textContent = `${s.players[0]?.name || 'Red'} ${s.scores[0]} — ${s.scores[1]} ${s.players[1]?.name || 'Blue'}`;
  const statsEl = $('gameover-stats');
  try {
    const per = computeStats(s.mines, s.moves, s.players);
    statsEl.innerHTML = statsBoxHtml(per, s, mode === 'hot' ? 0 : myPlayer);
    statsEl.hidden = false;
  } catch {
    statsEl.hidden = true;
  }
  over.hidden = false;
}

function reviewCurrentGame() {
  if (!state || !state.moves?.length) return;
  enterReview({
    mines: state.mines, moves: state.moves, players: state.players,
    myPlayer: mode === 'hot' ? 0 : Math.max(0, myPlayer), gmode: mode,
  });
}

function maybeSaveResult() {
  if (!state || state.status !== 'over' || saved) return;
  saved = true;
  const list = JSON.parse(localStorage.getItem('mfe-history') || '[]');
  list.unshift({
    date: Date.now(),
    mode,
    names: [state.players[0]?.name || 'Red', state.players[1]?.name || 'Blue'],
    scores: state.scores,
    winner: state.winner,
    won: mode === 'hot' || myPlayer < 0 ? null : state.winner === myPlayer,
    replay: { mines: state.mines, moves: state.moves, myPlayer: Math.max(0, myPlayer) },
  });
  // full replays are kept for the 20 most recent games
  for (let i = 20; i < list.length; i++) delete list[i].replay;
  localStorage.setItem('mfe-history', JSON.stringify(list.slice(0, 100)));
}

function renderHistory() {
  const list = JSON.parse(localStorage.getItem('mfe-history') || '[]');
  const el = $('history-list');
  if (!list.length) {
    el.innerHTML = '<div class="history-empty">No games played yet.</div>';
    return;
  }
  el.innerHTML = list.map((g, idx) => {
    const d = new Date(g.date);
    const when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const label = g.won === null ? `${g.names[g.winner]} won` : g.won ? 'You won' : 'You lost';
    const modeTag = { ai: 'vs AI', hot: 'local', online: 'online' }[g.mode] || g.mode;
    const reviewBtn = g.replay?.moves?.length ? `<button class="link review-link" data-review="${idx}">Review</button>` : '';
    return `<div class="history-item ${g.won ? 'won' : ''}">
      <div><div class="who">${esc(label)} · ${modeTag}${reviewBtn}</div><div class="when">${esc(g.names[0])} vs ${esc(g.names[1])} · ${when}</div></div>
      <div class="score">${g.scores[0]}–${g.scores[1]}</div>
    </div>`;
  }).join('');
}

$('history-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-review]');
  if (!btn) return;
  const g = JSON.parse(localStorage.getItem('mfe-history') || '[]')[+btn.dataset.review];
  if (!g?.replay) return;
  enterReview({
    mines: g.replay.mines, moves: g.replay.moves,
    players: [{ name: g.names[0] }, { name: g.names[1] }],
    myPlayer: g.replay.myPlayer ?? 0, gmode: g.mode,
  });
});

function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

/* ---------- start games ---------- */
function resetFlags() {
  armed = false; aiming = -1; saved = false;
  zoom = 1; tx = 0; ty = 0;
  applyView();
  clearMarks();
  oddsCache = { seq: -1, prob: null };
  whyMode = false;
  $('gameover').hidden = true;
  $('screen-game').classList.remove('shake');
  $('coach').hidden = true;
  $('btn-hint').hidden = $('btn-odds').hidden = $('btn-why').hidden = !coach;
  $('btn-odds').classList.toggle('on', oddsOn);
  $('btn-why').classList.remove('on');
  $('screen-game').classList.toggle('coach-on', coach);
  $('btn-bomb').hidden = mode === 'review';
  $('review-nav').hidden = mode !== 'review';
  $('btn-why').classList.toggle('on', mode === 'review');
}

function startAi(level = 'casual', withCoach = false) {
  mode = 'ai'; myPlayer = 0; aiLevel = level; coach = withCoach;
  state = newGame();
  const aiName = withCoach ? 'AI (training)' : level === 'expert' ? 'AI Expert' : 'AI';
  state.players = [{ name: settings.name, id: settings.id }, { name: aiName, id: 'ai' }];
  resetFlags();
  show('game');
  render();
  saveAiGame();
}

function startHotseat() {
  mode = 'hot'; myPlayer = 0; coach = false;
  state = newGame();
  state.players = [{ name: 'Red', id: 'p0' }, { name: 'Blue', id: 'p1' }];
  resetFlags();
  show('game');
  render();
  saveAiGame();
}

async function startOnline(role) {
  const pass = $('inp-pass').value.trim();
  const statusEl = $('online-status');
  if (pass.length < 4) {
    statusEl.hidden = false;
    statusEl.classList.add('err');
    statusEl.textContent = 'Passphrase must be at least 4 characters.';
    return;
  }
  statusEl.hidden = false;
  statusEl.classList.remove('err');
  statusEl.textContent = 'Connecting to broker…';
  $('btn-create').disabled = $('btn-join').disabled = true;

  net?.close();
  let opened = false;
  net = new Net({
    uri: settings.mqtt,
    pass,
    onStatus: st => {
      if (st === 'connected' && !opened) {
        opened = true;
        statusEl.hidden = true;
        localStorage.setItem('mfe-pass', pass);
        enterOnlineGame(role);
      } else if (st === 'error' && !opened) {
        statusEl.classList.add('err');
        statusEl.textContent = 'Could not reach the broker. Check the MQTT URI in Settings.';
        $('btn-create').disabled = $('btn-join').disabled = false;
      } else if (opened) {
        $('turn-banner').textContent = st === 'connected' ? '' : 'Reconnecting…';
        if (st === 'connected') render();
      }
    },
    onMessage: onNetMessage,
  });
  await net.connect();
}

function enterOnlineGame(role) {
  mode = 'online'; coach = false;
  resetFlags();
  $('btn-create').disabled = $('btn-join').disabled = false;
  if (role === 'create') {
    myPlayer = 0;
    state = newGame();
    state.players = [{ name: settings.name, id: settings.id }, null];
    net.publish({ t: 'state', state });
  } else if (role === 'observe') {
    myPlayer = -1;
    state = null;
    $('btn-bomb').hidden = true;
  } else {
    myPlayer = 1;
    state = null;
    $('p1-name').textContent = settings.name;
  }
  show('game');
  if (state) render();
  else $('turn-banner').textContent = 'Looking for a game in this room…';
}

function onNetMessage(msg) {
  if (msg.t !== 'state' || !msg.state) return;
  const incoming = msg.state;

  // Claim the empty seat when joining.
  const me = { name: settings.name, id: settings.id };
  if (mode === 'online' && myPlayer === 1) {
    if (incoming.players[0]?.id === settings.id) { myPlayer = 0; }
    else if (!incoming.players[1]) {
      incoming.players[1] = me;
      incoming.seq++;
      adopt(incoming);
      net.publish({ t: 'state', state });
      return;
    } else if (incoming.players[1].id !== settings.id) {
      // Both seats taken by others: watch instead of playing.
      myPlayer = -1;
      $('btn-bomb').hidden = true;
    }
  }

  if (!state || incoming.seq > state.seq) {
    const prevSeq = state?.seq ?? -1;
    adopt(incoming);
    if (state.last && prevSeq >= 0 && state.last.player !== myPlayer) playFx(state.last, state.last.player);
    maybeSaveResult();
  }
}

function adopt(s) {
  state = s;
  render();
}

/* ---------- rematch / quit ---------- */
function rematch() {
  if (mode === 'online' && state) {
    const fresh = newGame();
    fresh.players = state.players;
    fresh.seq = state.seq + 1;
    state = fresh;
    net.publish({ t: 'state', state });
  } else if (mode === 'ai') { startAi(aiLevel, coach); return; }
  else { startHotseat(); return; }
  resetFlags();
  render();
}

function quit() {
  clearTimeout(aiTimer);
  net?.close();
  net = null;
  state = null;
  review = null;
  mode = null;
  history.replaceState(null, '', location.pathname);
  show('home');
}

/* ---------- wire up ---------- */
$('btn-ai').onclick = () => { sfx.tap(); startAi('casual'); };
$('btn-ai-expert').onclick = () => { sfx.tap(); startAi('expert'); };
$('btn-train').onclick = () => { sfx.tap(); startAi('casual', true); };
$('btn-continue').onclick = () => { sfx.tap(); resumeAiGame(); };
$('btn-hint').onclick = () => { sfx.tap(); showHint(); };
$('btn-odds').onclick = () => {
  oddsOn = !oddsOn;
  $('btn-odds').classList.toggle('on', oddsOn);
  sfx.tap();
  render();
};
$('btn-hotseat').onclick = () => { sfx.tap(); startHotseat(); };
$('btn-create').onclick = () => { sfx.tap(); startOnline('create'); };
$('btn-join').onclick = () => { sfx.tap(); startOnline('join'); };
$('btn-observe').onclick = () => { sfx.tap(); startOnline('observe'); };
let settingsReturn = 'home';
$('btn-tutorial').onclick = () => show('tutorial');
$('btn-history').onclick = () => show('history');
$('btn-settings').onclick = () => { settingsReturn = 'home'; show('settings'); };
$('btn-gear').onclick = () => { settingsReturn = 'game'; show('settings'); };
$('settings-back').onclick = () => {
  const target = settingsReturn === 'game' && state ? 'game' : 'home';
  show(target);
  if (target === 'game') render();
};
for (const el of document.querySelectorAll('.nav-back')) el.onclick = () => show('home');

$('btn-quit').onclick = quit;
$('btn-home').onclick = quit;
$('btn-review').onclick = () => { sfx.tap(); reviewCurrentGame(); };
$('rv-first').onclick = () => { sfx.tap(); stepTo(0); };
$('rv-prev').onclick = () => { sfx.tap(); stepTo(review.step - 1); };
$('rv-next').onclick = () => { sfx.tap(); stepTo(review.step + 1); };
$('rv-last').onclick = () => { sfx.tap(); stepTo(review.moves.length); };
$('rv-slider').oninput = e => stepTo(+e.target.value);
$('rv-copy').onclick = () => { sfx.tap(); copyReviewGame(); };
$('btn-rematch').onclick = () => { sfx.tap(); rematch(); };
$('btn-bomb').onclick = () => {
  armed = !armed;
  aiming = -1;
  whyMode = false;
  $('btn-why').classList.remove('on');
  sfx.tap();
  render();
};
$('btn-why').onclick = () => {
  whyMode = !whyMode;
  armed = false; aiming = -1;
  $('btn-why').classList.toggle('on', whyMode);
  sfx.tap();
  if (whyMode) {
    const el = $('coach');
    el.className = 'coach v-good';
    el.innerHTML = '<span class="cv">Why?</span>Tap any covered cell to see where its odds come from, or a number to see what it still demands. Tap Why? again to go back to playing.';
    el.hidden = false;
  } else {
    clearMarks();
  }
  render();
};
$('btn-bomb-cancel').onclick = () => { armed = false; aiming = -1; render(); };

$('inp-pass').value = localStorage.getItem('mfe-pass') || '';

$('set-name').value = settings.name;
$('set-name').onchange = e => { settings.name = e.target.value.trim() || 'Player'; };
$('set-sound').checked = settings.sound;
setSoundEnabled(settings.sound);
$('set-sound').onchange = e => { settings.sound = e.target.checked; setSoundEnabled(e.target.checked); };
$('set-aispeed').value = settings.aiSpeed;
$('set-aispeed').onchange = e => { settings.aiSpeed = e.target.value; };
$('set-mqtt').value = settings.mqtt;
$('set-mqtt').onchange = e => { settings.mqtt = e.target.value.trim() || DEFAULT_MQTT; };
$('btn-mqtt-default').onclick = () => { settings.mqtt = DEFAULT_MQTT; $('set-mqtt').value = DEFAULT_MQTT; };

$('btn-tut-play').onclick = () => show('home');

window.mfe = { get state() { return state; }, get mode() { return mode; }, get myPlayer() { return myPlayer; }, encodeGame, decodeGame, shareText };

const sharedGame = new URLSearchParams(location.search).get('g');
let sharedOpened = false;
if (sharedGame) {
  try {
    const data = decodeGame(sharedGame);
    history.replaceState(null, '', location.pathname);
    enterReview(data);
    sharedOpened = true;
  } catch {
    history.replaceState(null, '', location.pathname);
  }
}

if (!sharedOpened && !localStorage.getItem('mfe-tut-seen')) {
  localStorage.setItem('mfe-tut-seen', '1');
  show('tutorial');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}
