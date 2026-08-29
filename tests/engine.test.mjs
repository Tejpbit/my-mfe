import assert from 'node:assert/strict';
import { SIZE, MINES, WIN_SCORE, newGame, reveal, bomb, canBomb, bombCells, minesLeft, neighbors } from '../js/game.js';
import { aiMove, analyze } from '../js/ai.js';

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let s = newGame(mulberry32(42));
assert.equal(s.mines.filter(Boolean).length, MINES, '51 mines placed');
assert.equal(minesLeft(s), MINES);

// adjacency sanity
for (let i = 0; i < SIZE; i++) {
  assert.equal(s.adj[i], neighbors(i).filter(n => s.mines[n]).length);
}

// hitting a mine: score + keep turn
const mineIdx = s.mines.findIndex(Boolean);
let r = reveal(s, mineIdx, 0);
assert.equal(r.type, 'mine');
assert.equal(s.scores[0], 1);
assert.equal(s.turn, 0, 'mine keeps the turn');
assert.equal(s.owner[mineIdx], 0);

// out-of-turn move rejected
assert.equal(reveal(s, s.mines.findIndex((m, i) => m && !s.revealed[i]), 1), null);

// safe reveal passes the turn
const safeIdx = s.mines.findIndex((m, i) => !m && !s.revealed[i]);
r = reveal(s, safeIdx, 0);
assert.equal(r.type, 'safe');
assert.ok(r.cells.length >= 1);
assert.equal(s.turn, 1, 'safe passes the turn');

// bomb only when not leading
s = newGame(mulberry32(7));
assert.ok(canBomb(s, 0), 'tied at 0-0 counts as not leading');
const m1 = s.mines.findIndex(Boolean);
reveal(s, m1, 0);
assert.ok(!canBomb(s, 0), 'leader cannot bomb');
const sSafe = s.mines.findIndex((m, i) => !m && !s.revealed[i]);
reveal(s, sSafe, 0);
assert.ok(canBomb(s, 1), 'trailing player can bomb');
const before = s.scores[1];
const blast = bombCells(8 * 16 + 8);
assert.equal(blast.length, 25);
const expectMines = blast.filter(i => s.mines[i] && !s.revealed[i]).length;
r = bomb(s, 8 * 16 + 8, 1);
assert.equal(r.type, 'bomb');
assert.equal(s.scores[1] - before, expectMines, 'bomb captures all unrevealed mines in 5x5');
assert.equal(s.bombs[1], false);
assert.equal(s.turn, 0, 'bomb passes the turn');
assert.equal(bomb(s, 0, 1), null, 'bomb only once');

// corner blast is clamped
assert.equal(bombCells(0).length, 9);

// win detection: play a full AI-vs-AI game
s = newGame(mulberry32(1234));
s.players = [{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }];
const rng = mulberry32(99);
let guard = 0;
while (s.status === 'playing' && guard++ < 2000) {
  const p = s.turn;
  const move = aiMove(s, p, rng);
  assert.ok(move, 'AI always finds a move');
  const res = move.type === 'bomb' ? bomb(s, move.index, p) : reveal(s, move.index, p);
  assert.ok(res, `AI move is legal (${move.type} @ ${move.index})`);
}
assert.equal(s.status, 'over', 'game terminates');
assert.ok(s.scores[s.winner] >= WIN_SCORE, 'winner reached 26');
assert.ok(s.scores[0] + s.scores[1] <= MINES);

// the game's first click never opens a flood
{
  const rng2 = mulberry32(77);
  for (let seed = 0; seed < 20; seed++) {
    const g = newGame(mulberry32(seed));
    const zero = g.adj.findIndex((a, i) => a === 0 && !g.mines[i]);
    if (zero < 0) continue;
    const res = reveal(g, zero, 0, rng2);
    assert.equal(res.type, 'safe');
    assert.equal(res.cells.length, 1, 'first click reveals exactly one cell');
    assert.ok(g.adj[zero] > 0, 'clicked cell now shows a number');
    assert.equal(g.mines.filter(Boolean).length, MINES, 'mine count preserved');
  }
}

// analyze never marks a non-mine as certain
s = newGame(mulberry32(5));
reveal(s, s.mines.findIndex((m, i) => !m), 0);
for (let step = 0; step < 40 && s.status === 'playing'; step++) {
  const { certainMines } = analyze(s);
  for (const i of certainMines) assert.ok(s.mines[i], 'certain mine really is a mine');
  const move = aiMove(s, s.turn, rng);
  const res = move.type === 'bomb' ? bomb(s, move.index, s.turn) : reveal(s, move.index, s.turn);
  assert.ok(res);
}

console.log('All engine tests passed.');
