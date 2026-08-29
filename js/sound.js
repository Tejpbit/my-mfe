let ctx = null;
let enabled = true;

export function setSoundEnabled(on) { enabled = on; }

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, { start = 0, dur = 0.12, type = 'sine', gain = 0.12, slide = 0 } = {}) {
  const c = ac();
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ start = 0, dur = 0.4, gain = 0.3, cutoff = 900 } = {}) {
  const c = ac();
  const t0 = c.currentTime + start;
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, t0);
  filter.frequency.exponentialRampToValueAtTime(80, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(t0);
}

export const sfx = {
  tap() { if (enabled) tone(440, { dur: 0.05, type: 'triangle', gain: 0.06 }); },
  safe(count) {
    if (!enabled) return;
    tone(330, { dur: 0.08, type: 'sine', gain: 0.08 });
    if (count > 4) tone(392, { start: 0.06, dur: 0.1, type: 'sine', gain: 0.07 });
  },
  mine(isMe) {
    if (!enabled) return;
    const notes = isMe ? [523, 659, 784] : [392, 311, 262];
    notes.forEach((f, i) => tone(f, { start: i * 0.07, dur: 0.14, type: 'triangle', gain: 0.1 }));
  },
  bomb() {
    if (!enabled) return;
    noise({ dur: 0.6, gain: 0.35, cutoff: 1200 });
    tone(70, { dur: 0.5, type: 'sine', gain: 0.3, slide: -30 });
  },
  win() {
    if (!enabled) return;
    [523, 659, 784, 1047].forEach((f, i) => tone(f, { start: i * 0.12, dur: 0.22, type: 'triangle', gain: 0.12 }));
  },
  lose() {
    if (!enabled) return;
    [392, 330, 262, 196].forEach((f, i) => tone(f, { start: i * 0.14, dur: 0.25, type: 'sine', gain: 0.1 }));
  },
};
