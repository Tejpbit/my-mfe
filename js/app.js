import { SIZE, W, H, BOMB_RADIUS, WIN_SCORE, newGame, reveal, bomb, canBomb, bombCells, minesLeft } from './game.js';
import { aiMove, aiMoveExpert } from './ai.js';
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
  if (mode !== 'ai' || !state) return;
  if (state.status === 'over') { localStorage.removeItem('mfe-ai-save'); return; }
  localStorage.setItem('mfe-ai-save', JSON.stringify({ state, aiLevel, date: Date.now() }));
}

function updateContinue() {
  const btn = $('btn-continue');
  try {
    const raw = localStorage.getItem('mfe-ai-save');
    if (!raw) { btn.hidden = true; return; }
    const { state: st, aiLevel: lvl } = JSON.parse(raw);
    btn.textContent = `Continue vs ${lvl === 'expert' ? 'AI Expert' : 'AI'} · ${st.scores[0]}–${st.scores[1]}`;
    btn.hidden = false;
  } catch {
    btn.hidden = true;
  }
}

function resumeAiGame() {
  try {
    const { state: st, aiLevel: lvl } = JSON.parse(localStorage.getItem('mfe-ai-save'));
    mode = 'ai'; myPlayer = 0; aiLevel = lvl === 'expert' ? 'expert' : 'casual';
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
  const el = e.target.closest('.cell');
  if (el) onCellTap(+el.dataset.i);
});
// Desktop: aiming follows the mouse while the bomb is armed. Touch keeps the
// two-tap flow (pointerType guard, since taps also emit pointerover).
boardEl.addEventListener('pointerover', e => {
  if (!armed || e.pointerType === 'touch' || e.pointerType === 'pen') return;
  const el = e.target.closest('.cell');
  if (el && aiming !== +el.dataset.i) {
    aiming = +el.dataset.i;
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
  if (s.status === 'over') {
    banner.textContent = '';
  } else if (mode === 'online' && !s.players[1]) {
    banner.textContent = 'Waiting for opponent to join…';
    banner.classList.remove('me');
  } else if (mode === 'hot') {
    banner.textContent = `${s.players[s.turn]?.name || (s.turn === 0 ? 'Red' : 'Blue')}'s turn`;
    banner.classList.add('me');
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
  if (!state || state.status !== 'playing') return;
  if (mode === 'online' && !state.players[1]) return;
  const p = activePlayer();
  if (mode !== 'hot' && state.turn !== myPlayer) return;

  if (armed) {
    if (aiming === i) {
      doMove({ type: 'bomb', index: i }, p);
      armed = false; aiming = -1;
    } else {
      aiming = i;
      sfx.tap();
      render();
    }
    return;
  }
  if (state.revealed[i]) return;
  doMove({ type: 'reveal', index: i }, p);
}

function doMove(move, p) {
  const result = move.type === 'bomb' ? bomb(state, move.index, p) : reveal(state, move.index, p);
  if (!result) return;
  playFx(result, p);
  render();
  if (mode === 'online') net?.publish({ t: 'state', state });
  saveAiGame();
  maybeSaveResult();
  scheduleAi();
}

function playFx(last, mover) {
  const meMoved = mode === 'hot' || mover === myPlayer;
  if (last.type === 'bomb') sfx.bomb();
  else if (last.type === 'mine') sfx.mine(meMoved);
  else sfx.safe(last.cells.length);
  if (state.status === 'over') {
    const iWon = mode === 'hot' || state.winner === myPlayer;
    setTimeout(() => (iWon ? sfx.win() : sfx.lose()), 350);
    if (!iWon) $('screen-game').classList.add('shake');
  }
}

/* ---------- AI ---------- */
function scheduleAi() {
  if (mode !== 'ai' || !state || state.status !== 'playing' || state.turn === myPlayer) return;
  clearTimeout(aiTimer);
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
  }, 600 + Math.random() * 700);
}

/* ---------- game over / history ---------- */
function showGameOver() {
  const s = state;
  const over = $('gameover');
  if (!over.hidden) return;
  const iWon = mode === 'hot' || s.winner === myPlayer;
  const winName = s.players[s.winner]?.name || (s.winner === 0 ? 'Red' : 'Blue');
  $('gameover-title').textContent = mode === 'hot' ? `${winName} wins!` : iWon ? 'Victory!' : 'Defeat';
  $('gameover-sub').textContent = `${s.players[0]?.name || 'Red'} ${s.scores[0]} — ${s.scores[1]} ${s.players[1]?.name || 'Blue'}`;
  over.hidden = false;
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
    won: mode === 'hot' ? null : state.winner === myPlayer,
  });
  localStorage.setItem('mfe-history', JSON.stringify(list.slice(0, 100)));
}

function renderHistory() {
  const list = JSON.parse(localStorage.getItem('mfe-history') || '[]');
  const el = $('history-list');
  if (!list.length) {
    el.innerHTML = '<div class="history-empty">No games played yet.</div>';
    return;
  }
  el.innerHTML = list.map(g => {
    const d = new Date(g.date);
    const when = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const label = g.won === null ? `${g.names[g.winner]} won` : g.won ? 'You won' : 'You lost';
    const modeTag = { ai: 'vs AI', hot: 'local', online: 'online' }[g.mode] || g.mode;
    return `<div class="history-item ${g.won ? 'won' : ''}">
      <div><div class="who">${esc(label)} · ${modeTag}</div><div class="when">${esc(g.names[0])} vs ${esc(g.names[1])} · ${when}</div></div>
      <div class="score">${g.scores[0]}–${g.scores[1]}</div>
    </div>`;
  }).join('');
}

function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

/* ---------- start games ---------- */
function resetFlags() {
  armed = false; aiming = -1; saved = false;
  $('gameover').hidden = true;
  $('screen-game').classList.remove('shake');
}

function startAi(level = 'casual') {
  mode = 'ai'; myPlayer = 0; aiLevel = level;
  state = newGame();
  state.players = [{ name: settings.name, id: settings.id }, { name: level === 'expert' ? 'AI Expert' : 'AI', id: 'ai' }];
  resetFlags();
  show('game');
  render();
  saveAiGame();
}

function startHotseat() {
  mode = 'hot'; myPlayer = 0;
  state = newGame();
  state.players = [{ name: 'Red', id: 'p0' }, { name: 'Blue', id: 'p1' }];
  resetFlags();
  show('game');
  render();
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
  mode = 'online';
  resetFlags();
  $('btn-create').disabled = $('btn-join').disabled = false;
  if (role === 'create') {
    myPlayer = 0;
    state = newGame();
    state.players = [{ name: settings.name, id: settings.id }, null];
    net.publish({ t: 'state', state });
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
      $('turn-banner').textContent = 'Room is full (two players already joined).';
      return;
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
  } else if (mode === 'ai') { startAi(aiLevel); return; }
  else { startHotseat(); return; }
  resetFlags();
  render();
}

function quit() {
  clearTimeout(aiTimer);
  net?.close();
  net = null;
  state = null;
  show('home');
}

/* ---------- wire up ---------- */
$('btn-ai').onclick = () => { sfx.tap(); startAi('casual'); };
$('btn-ai-expert').onclick = () => { sfx.tap(); startAi('expert'); };
$('btn-continue').onclick = () => { sfx.tap(); resumeAiGame(); };
$('btn-hotseat').onclick = () => { sfx.tap(); startHotseat(); };
$('btn-create').onclick = () => { sfx.tap(); startOnline('create'); };
$('btn-join').onclick = () => { sfx.tap(); startOnline('join'); };
$('btn-tutorial').onclick = () => show('tutorial');
$('btn-history').onclick = () => show('history');
$('btn-settings').onclick = () => show('settings');
for (const el of document.querySelectorAll('.nav-back')) el.onclick = () => show('home');

$('btn-quit').onclick = quit;
$('btn-home').onclick = quit;
$('btn-rematch').onclick = () => { sfx.tap(); rematch(); };
$('btn-bomb').onclick = () => {
  armed = !armed;
  aiming = -1;
  sfx.tap();
  render();
};
$('btn-bomb-cancel').onclick = () => { armed = false; aiming = -1; render(); };

$('set-name').value = settings.name;
$('set-name').onchange = e => { settings.name = e.target.value.trim() || 'Player'; };
$('set-sound').checked = settings.sound;
setSoundEnabled(settings.sound);
$('set-sound').onchange = e => { settings.sound = e.target.checked; setSoundEnabled(e.target.checked); };
$('set-mqtt').value = settings.mqtt;
$('set-mqtt').onchange = e => { settings.mqtt = e.target.value.trim() || DEFAULT_MQTT; };
$('btn-mqtt-default').onclick = () => { settings.mqtt = DEFAULT_MQTT; $('set-mqtt').value = DEFAULT_MQTT; };

$('btn-tut-play').onclick = () => show('home');

window.mfe = { get state() { return state; } };

if (!localStorage.getItem('mfe-tut-seen')) {
  localStorage.setItem('mfe-tut-seen', '1');
  show('tutorial');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}
