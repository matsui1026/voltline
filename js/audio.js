// VOLTLINE audio engine — everything synthesized with Web Audio, no assets.
// Public API: audio.unlock / setMusic / setEngine / sfx / setVolumes / setMuted
// Every public method is a safe no-op before unlock() and never throws.

const MAX_SFX_VOICES = 24;
const MAX_MUSIC_VOICES = 30;
const LOOKAHEAD = 0.1;      // seconds scheduled ahead
const TICK_MS = 25;
const FADE = 0.6;           // music crossfade seconds

let ctx = null;
let master = null, comp = null, musicBus = null, sfxBus = null, engineBus = null;
let noiseBuf = null;
let listenersInstalled = false;

const vol = { master: 0.9, music: 0.35, sfx: 0.8 };
let muted = false;

const live = { m: 0, s: 0 }; // live voice counters (music / sfx)

let wantMusic = null;   // requested music name (may be set before unlock)
let track = null;       // currently playing track object
let timer = null;

let eng = null;         // engine node graph
let engLastT = -1;
let engSilent = true;
let lastRoulette = 0;

/* ------------------------------------------------------------------ utils */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function resumeCtx() {
  try {
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    const p = ctx.resume();
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* ignore */ }
}

function applyVolumes() {
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(muted ? 0 : vol.master, t, 0.03);
    musicBus.gain.setTargetAtTime(vol.music, t, 0.03);
    sfxBus.gain.setTargetAtTime(vol.sfx, t, 0.03);
  } catch (e) { /* ignore */ }
}

function installListeners() {
  if (listenersInstalled || typeof document === 'undefined') return;
  listenersInstalled = true;
  const onGesture = function () { resumeCtx(); };
  try {
    document.addEventListener('visibilitychange', function () {
      try {
        if (!ctx || ctx.state === 'closed') return;
        if (document.hidden) {
          if (ctx.state === 'running') {
            const p = ctx.suspend();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }
        } else {
          resumeCtx();
        }
      } catch (e) { /* ignore */ }
    });
    document.addEventListener('touchend', onGesture, { passive: true });
    document.addEventListener('pointerup', onGesture, { passive: true });
    document.addEventListener('keydown', onGesture);
  } catch (e) { /* ignore */ }
}

function initContext() {
  const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return false;
  let c;
  try { c = new AC({ latencyHint: 'interactive' }); }
  catch (e) { c = new AC(); }

  // shared 2s white-noise buffer
  const len = Math.floor(c.sampleRate * 2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

  const m = c.createGain();
  const cp = c.createDynamicsCompressor();
  cp.threshold.value = -14;
  cp.knee.value = 12;
  cp.ratio.value = 6;
  cp.attack.value = 0.003;
  cp.release.value = 0.2;
  const mb = c.createGain();
  const sb = c.createGain();
  const eb = c.createGain();
  m.gain.value = muted ? 0 : vol.master;
  mb.gain.value = vol.music;
  sb.gain.value = vol.sfx;
  eb.gain.value = 0.55;
  mb.connect(m);
  sb.connect(m);
  eb.connect(sb);
  m.connect(cp);
  cp.connect(c.destination);

  ctx = c; noiseBuf = buf; master = m; comp = cp; musicBus = mb; sfxBus = sb; engineBus = eb;
  return true;
}

/* ------------------------------------------------------- one-shot voices */

// kind: 'm' (music) or 's' (sfx)
function track1(src, kind, extra) {
  live[kind]++;
  src.onended = function () {
    live[kind]--;
    if (live[kind] < 0) live[kind] = 0;
    try { if (extra) extra.disconnect(); } catch (e) { /* ignore */ }
  };
}

function envPerc(g, t, atk, dur, peak) {
  atk = Math.min(atk || 0.004, dur * 0.5);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

// SFX tone: oscillator with optional exponential pitch glide and percussive envelope.
function tone(dest, t, type, f0, f1, dur, peak, atk) {
  if (live.s >= MAX_SFX_VOICES) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  envPerc(g, t, atk, dur, peak);
  o.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.03);
  track1(o, 's', g);
}

// SFX noise: shared noise buffer through a swept biquad with percussive envelope.
function nz(dest, t, ftype, f0, f1, q, dur, peak, atk) {
  if (live.s >= MAX_SFX_VOICES) return;
  const s = ctx.createBufferSource();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  f.type = ftype;
  f.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + dur);
  f.Q.value = q;
  envPerc(g, t, atk, dur, peak);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.03);
  track1(s, 's', g);
}

/* -------------------------------------------------------------------- SFX */

function sparks(o, t, base, shimmer) {
  for (let i = 0; i < 3; i++) {
    tone(o, t + i * 0.045, 'square', base * (1 + 0.25 * i), base * (1.5 + 0.25 * i), 0.07, 0.15);
  }
  nz(o, t, 'highpass', 5000, 8000, 0.7, 0.14, 0.16);
  if (shimmer) {
    tone(o, t + 0.09, 'sine', base * 3, base * 3.02, 0.35, 0.14);
    tone(o, t + 0.135, 'square', base * 2, base * 3, 0.08, 0.13);
  }
}

const SFX = {
  ui_move: function (o, t) {
    tone(o, t, 'triangle', 880, 1100, 0.05, 0.28);
  },
  ui_select: function (o, t) {
    tone(o, t, 'square', 660, 0, 0.07, 0.16);
    tone(o, t + 0.06, 'square', 990, 0, 0.13, 0.16);
    tone(o, t + 0.06, 'triangle', 1980, 0, 0.16, 0.12);
  },
  ui_back: function (o, t) {
    tone(o, t, 'triangle', 520, 290, 0.13, 0.3);
    tone(o, t, 'square', 260, 150, 0.1, 0.08);
  },
  count_beep: function (o, t) {
    tone(o, t, 'square', 440, 0, 0.18, 0.2);
    tone(o, t, 'sine', 880, 0, 0.2, 0.2);
  },
  count_go: function (o, t) {
    tone(o, t, 'square', 880, 0, 0.55, 0.2);
    tone(o, t, 'sawtooth', 1320, 0, 0.5, 0.1);
    tone(o, t, 'sine', 440, 0, 0.55, 0.25);
    nz(o, t, 'highpass', 3000, 7000, 0.7, 0.25, 0.18);
  },
  boost: function (o, t) {
    nz(o, t, 'bandpass', 400, 5200, 1.2, 0.65, 0.5, 0.04);
    tone(o, t, 'sawtooth', 120, 540, 0.5, 0.22, 0.02);
    tone(o, t, 'sine', 140, 55, 0.3, 0.5);
    tone(o, t + 0.05, 'triangle', 600, 1800, 0.35, 0.12, 0.05);
  },
  drift_start: function (o, t) {
    nz(o, t, 'bandpass', 2800, 1500, 5, 0.26, 0.4, 0.01);
    tone(o, t, 'sawtooth', 520, 380, 0.12, 0.08);
  },
  drift_tier1: function (o, t) { sparks(o, t, 700, false); },
  drift_tier2: function (o, t) { sparks(o, t, 1000, false); },
  drift_tier3: function (o, t) { sparks(o, t, 1400, true); },
  item_pick: function (o, t) {
    const f = [784, 988, 1175, 1568];
    for (let i = 0; i < 4; i++) tone(o, t + i * 0.045, 'triangle', f[i], 0, 0.12, 0.26);
    tone(o, t + 0.135, 'sine', 3136, 0, 0.2, 0.08);
  },
  item_roulette: function (o, t) {
    tone(o, t, 'square', 1150 + Math.random() * 250, 0, 0.03, 0.11, 0.002);
  },
  item_ready: function (o, t) {
    tone(o, t, 'sine', 1047, 0, 0.22, 0.26);
    tone(o, t, 'triangle', 2094, 0, 0.12, 0.08);
    tone(o, t + 0.09, 'sine', 1568, 0, 0.34, 0.26);
    tone(o, t + 0.09, 'triangle', 3136, 0, 0.2, 0.07);
  },
  item_use: function (o, t) {
    tone(o, t, 'sawtooth', 300, 950, 0.18, 0.18);
    nz(o, t, 'bandpass', 1000, 3400, 2, 0.22, 0.3, 0.02);
  },
  bolt_fire: function (o, t) {
    tone(o, t, 'sawtooth', 1900, 200, 0.24, 0.26);
    tone(o, t, 'square', 2500, 320, 0.16, 0.11);
    nz(o, t, 'highpass', 4000, 0, 0.7, 0.08, 0.25);
  },
  trap_drop: function (o, t) {
    tone(o, t, 'sine', 420, 90, 0.24, 0.4);
    tone(o, t + 0.2, 'square', 170, 120, 0.09, 0.14);
    nz(o, t + 0.2, 'lowpass', 900, 300, 0.7, 0.1, 0.3);
    tone(o, t + 0.26, 'sine', 1400, 0, 0.08, 0.1);
  },
  shield_on: function (o, t) {
    tone(o, t, 'sine', 300, 1200, 0.42, 0.26, 0.03);
    tone(o, t, 'triangle', 450, 1800, 0.42, 0.13, 0.03);
    nz(o, t, 'bandpass', 4000, 8000, 3, 0.45, 0.12, 0.1);
    tone(o, t + 0.36, 'sine', 2400, 0, 0.3, 0.1);
  },
  shield_hit: function (o, t) {
    tone(o, t, 'triangle', 1500, 480, 0.26, 0.3);
    tone(o, t, 'sine', 2250, 2000, 0.32, 0.14);
    nz(o, t, 'bandpass', 3000, 1200, 2, 0.12, 0.3);
  },
  storm: function (o, t) {
    nz(o, t, 'lowpass', 7000, 180, 0.9, 1.25, 0.6, 0.01);
    tone(o, t, 'sawtooth', 95, 30, 1.0, 0.32);
    tone(o, t, 'sine', 70, 38, 0.7, 0.6);
    for (let i = 0; i < 8; i++) {
      const tt = t + 0.03 + Math.random() * 0.8;
      const f = 900 + Math.random() * 3200;
      tone(o, tt, 'square', f, f * (0.4 + Math.random() * 0.4), 0.035 + Math.random() * 0.04, 0.14, 0.002);
    }
  },
  hit: function (o, t) {
    nz(o, t, 'lowpass', 2000, 200, 0.8, 0.26, 0.6);
    tone(o, t, 'sine', 165, 45, 0.3, 0.6);
    tone(o, t, 'square', 230, 80, 0.15, 0.16);
  },
  spinout: function (o, t) {
    for (let i = 0; i < 4; i++) {
      tone(o, t + i * 0.15, 'triangle', 1000 - 150 * i, 420 - 60 * i, 0.15, 0.24);
    }
    nz(o, t, 'bandpass', 1900, 700, 3, 0.7, 0.2, 0.02);
  },
  wall: function (o, t) {
    nz(o, t, 'lowpass', 1000, 150, 0.8, 0.18, 0.6);
    tone(o, t, 'sine', 115, 50, 0.2, 0.6);
    tone(o, t, 'square', 95, 60, 0.08, 0.18);
  },
  lap: function (o, t) {
    tone(o, t, 'triangle', 784, 0, 0.16, 0.26);
    tone(o, t, 'square', 784, 0, 0.1, 0.08);
    tone(o, t + 0.1, 'triangle', 1175, 0, 0.36, 0.26);
    tone(o, t + 0.1, 'square', 1175, 0, 0.22, 0.08);
  },
  final_lap: function (o, t) {
    const seq = [[0, 880, 0.1], [0.11, 880, 0.1], [0.22, 1319, 0.5]];
    for (let i = 0; i < seq.length; i++) {
      tone(o, t + seq[i][0], 'square', seq[i][1], 0, seq[i][2], 0.15);
      tone(o, t + seq[i][0], 'sawtooth', seq[i][1] * 1.005, 0, seq[i][2], 0.1);
    }
    tone(o, t + 0.22, 'sine', 659.5, 0, 0.5, 0.18);
  },
  finish: function (o, t) {
    const up = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < 4; i++) {
      tone(o, t + i * 0.09, 'triangle', up[i], 0, 0.16, 0.24);
      tone(o, t + i * 0.09, 'sawtooth', up[i], 0, 0.12, 0.07);
    }
    const ch = [1046.5, 1318.5, 1568];
    for (let i = 0; i < 3; i++) {
      tone(o, t + 0.36, 'triangle', ch[i], 0, 1.0, 0.17, 0.01);
      tone(o, t + 0.36, 'sawtooth', ch[i] * 0.5 * 1.004, 0, 0.9, 0.06, 0.01);
    }
    nz(o, t + 0.36, 'highpass', 6000, 9000, 0.7, 0.6, 0.1, 0.01);
  },
  overtake: function (o, t) {
    tone(o, t, 'triangle', 600, 1200, 0.09, 0.25);
    tone(o, t + 0.07, 'triangle', 900, 1800, 0.11, 0.22);
  },
  slipstream: function (o, t) {
    nz(o, t, 'bandpass', 800, 2600, 1.5, 0.55, 0.32, 0.2);
    tone(o, t, 'sine', 500, 720, 0.5, 0.07, 0.2);
  },
};

function playSfx(name, opts) {
  if (!ctx || ctx.state !== 'running') return;
  if (typeof name !== 'string' || !has(SFX, name)) return;
  if (live.s >= MAX_SFX_VOICES) return;
  const now = ctx.currentTime;
  if (name === 'item_roulette') {
    if (now - lastRoulette < 0.03) return;
    lastRoulette = now;
  }
  const v = clamp(num(opts && opts.vol, 1), 0, 1);
  const pan = clamp(num(opts && opts.pan, 0), -1, 1);
  if (v <= 0) return;
  const o = ctx.createGain();
  o.gain.value = v;
  let p = null;
  if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(p);
    p.connect(sfxBus);
  } else {
    o.connect(sfxBus);
  }
  try {
    SFX[name](o, now + 0.005);
  } finally {
    setTimeout(function () {
      try { o.disconnect(); if (p) p.disconnect(); } catch (e) { /* ignore */ }
    }, 3500);
  }
}

/* ------------------------------------------------------------------ MUSIC */

const _ = null;

// chords: [semitone offset from root, third (3 = minor, 4 = major)]
const RACE = {
  bpm: 140, transpose: 0,
  root: 45, padBase: 57, arpBase: 69, leadBase: 69,
  chords: [[0, 3], [-4, 4], [-2, 4], [-5, 3]],          // Am F G Em
  kick:  'x.....x...x.....',
  snare: '....x.......x...',
  hat:   'x.x.x.x.x.x.x.o.',
  bass:  [1, 0, 1, 1, 0, 1, 2, 0, 1, 0, 1, 1, 0, 1, 2, 1],
  bassType: 'saw', bassLen: 0.9, bassCut: 900,
  arpEvery: 1, arp: [0, 2, 3, 2, 4, 2, 3, 1, 0, 2, 3, 2, 5, 4, 3, 2], arpType: 'square',
  leadType: 'saw',
  lead: [
    [12, _, _, 7, _, _, 10, _, 12, _, _, 15, _, 14, _, _],
    [12, _, _, 8, _, _, 12, _, 17, _, _, 15, _, _, 12, _],
    [14, _, _, 10, _, _, 14, _, 19, _, _, 17, _, 14, _, _],
    [19, _, _, _, 14, _, _, 10, _, _, 7, _, 10, _, 14, _],
  ],
  fill: true, duck: 0.3, padCut: 1500,
  lv: { kick: 0.95, snare: 0.5, hat: 0.2, bass: 0.26, arp: 0.085, pad: 0.07, lead: 0.11 },
};

const FINAL = Object.assign({}, RACE, {
  bpm: 151.2, transpose: 1,
  hat: 'x-x-x-x-x-x-x-o-',
});

const MENU = {
  bpm: 100, transpose: 0,
  root: 50, padBase: 62, arpBase: 62, leadBase: 62,
  chords: [[0, 3], [-2, 4], [-4, 4], [-7, 3]],          // Dm C Bb Gm
  kick:  'x.........x.....',
  snare: '........x.......',
  hat:   '..-...-...-...-.',
  bass:  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  bassType: 'sub', bassLen: 5.5, bassCut: 600,
  arpEvery: 2, arp: [0, 2, 4, 3, 2, 4, 5, 3], arpType: 'triangle',
  leadType: 'bell',
  lead: [
    [_, _, _, _, 12, _, _, _, _, _, 15, _, _, _, 14, _],
    [12, _, _, _, _, _, _, _, 10, _, _, _, 7, _, _, _],
    [_, _, _, _, 8, _, _, _, _, _, 12, _, _, _, 10, _],
    [12, _, _, _, _, _, _, _, 8, _, _, _, 5, _, _, _],
  ],
  fill: false, duck: 0.75, padCut: 1100,
  lv: { kick: 0.5, snare: 0.14, hat: 0.1, bass: 0.3, arp: 0.1, pad: 0.11, lead: 0.13 },
};

const RESULTS = {
  bpm: 112, transpose: 0,
  root: 48, padBase: 60, arpBase: 72, leadBase: 60,
  chords: [[0, 4], [5, 4], [-3, 3], [-5, 4]],           // C F Am G
  kick:  'x...x...x...x...',
  snare: '....x.......x...',
  hat:   '..x...x...x...o.',
  bass:  [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 2, 0],
  bassType: 'saw', bassLen: 1.6, bassCut: 700,
  arpEvery: 2, arp: [0, 1, 2, 3, 2, 3, 4, 5], arpType: 'triangle',
  leadType: 'saw',
  lead: [
    [12, _, _, _, 16, _, _, _, 19, _, _, _, _, _, 16, _],
    [21, _, _, _, _, _, 17, _, _, _, _, _, 12, _, _, _],
    [16, _, _, _, _, _, 21, _, _, _, _, _, 24, _, _, _],
    [23, _, _, _, _, _, 19, _, _, _, 14, _, _, _, 19, _],
  ],
  fill: false, duck: 0.5, padCut: 1800,
  lv: { kick: 0.7, snare: 0.3, hat: 0.13, bass: 0.22, arp: 0.1, pad: 0.09, lead: 0.1 },
};

const SONGS = { menu: MENU, race: RACE, final: FINAL, results: RESULTS };

function mkFilter(type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function makeTrack(song) {
  const now = ctx.currentTime;
  const stepDur = 60 / song.bpm / 4;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.linearRampToValueAtTime(1, now + FADE);
  out.connect(musicBus);

  const duck = ctx.createGain();
  duck.connect(out);

  const bassF = mkFilter('lowpass', song.bassCut, 3);
  const padF = mkFilter('lowpass', song.padCut, 0.7);
  const arpF = mkFilter('lowpass', 2800, 1.5);
  const leadF = mkFilter('lowpass', 4200, 0.8);
  const hatF = mkFilter('highpass', 7500, 0.7);
  const snF = mkFilter('highpass', 1300, 0.7);
  bassF.connect(duck);
  padF.connect(duck);
  arpF.connect(duck);
  leadF.connect(out);
  hatF.connect(out);
  snF.connect(out);

  // light feedback delay for arp + lead
  const send = ctx.createGain();
  const delay = ctx.createDelay(1.0);
  const fb = ctx.createGain();
  const wet = ctx.createGain();
  send.gain.value = 1;
  delay.delayTime.value = Math.min(0.95, stepDur * 3);
  fb.gain.value = 0.3;
  wet.gain.value = 0.28;
  arpF.connect(send);
  leadF.connect(send);
  send.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(out);

  return {
    song: song, out: out, duck: duck, bassF: bassF, padF: padF, arpF: arpF,
    leadF: leadF, hatF: hatF, snF: snF,
    nodes: [out, duck, bassF, padF, arpF, leadF, hatF, snF, send, delay, fb, wet],
    step: 0, next: now + 0.08, stepDur: stepDur,
  };
}

function killTrack(tr) {
  if (!tr) return;
  try {
    const now = ctx.currentTime;
    const g = tr.out.gain;
    const cur = Math.max(0.0001, g.value);
    g.cancelScheduledValues(now);
    g.setValueAtTime(cur, now);
    g.linearRampToValueAtTime(0, now + FADE);
  } catch (e) { /* ignore */ }
  setTimeout(function () {
    for (let i = 0; i < tr.nodes.length; i++) {
      try { tr.nodes[i].disconnect(); } catch (e) { /* ignore */ }
    }
  }, (FADE + 1.2) * 1000);
}

/* --- music instruments --- */

function mKick(tr, t, v) {
  if (live.m >= MAX_MUSIC_VOICES) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(165, t);
  o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  o.connect(g); g.connect(tr.out);
  o.start(t); o.stop(t + 0.28);
  track1(o, 'm', g);
  // sidechain pump
  const dk = tr.duck.gain;
  dk.setValueAtTime(tr.song.duck, t);
  dk.linearRampToValueAtTime(1, t + Math.min(0.24, tr.stepDur * 1.8));
}

function mSnare(tr, t, v) {
  if (live.m >= MAX_MUSIC_VOICES - 1) return;
  const s = ctx.createBufferSource();
  const g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  s.connect(g); g.connect(tr.snF);
  s.start(t, Math.random() * 1.5); s.stop(t + 0.18);
  track1(s, 'm', g);

  const o = ctx.createOscillator();
  const g2 = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(215, t);
  o.frequency.exponentialRampToValueAtTime(150, t + 0.09);
  g2.gain.setValueAtTime(v * 0.7, t);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  o.connect(g2); g2.connect(tr.out);
  o.start(t); o.stop(t + 0.12);
  track1(o, 'm', g2);
}

function mHat(tr, t, v, open) {
  if (live.m >= MAX_MUSIC_VOICES) return;
  const d = open ? 0.2 : 0.04;
  const s = ctx.createBufferSource();
  const g = ctx.createGain();
  s.buffer = noiseBuf; s.loop = true;
  g.gain.setValueAtTime(v, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  s.connect(g); g.connect(tr.hatF);
  s.start(t, Math.random() * 1.5); s.stop(t + d + 0.02);
  track1(s, 'm', g);
}

function mBass(tr, t, midi, dur, v) {
  const sub = tr.song.bassType === 'sub';
  if (live.m >= MAX_MUSIC_VOICES - 2) return;
  const f = mtof(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + (sub ? 0.04 : 0.006));
  g.gain.setValueAtTime(v, t + dur * 0.65);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  g.connect(tr.bassF);
  const types = sub ? ['triangle', 'sine'] : ['sawtooth', 'sawtooth', 'sine'];
  const det = sub ? [0, 0] : [-9, 9, 0];
  for (let i = 0; i < types.length; i++) {
    const o = ctx.createOscillator();
    o.type = types[i];
    o.frequency.value = f;
    o.detune.value = det[i];
    o.connect(g);
    o.start(t); o.stop(t + dur + 0.02);
    track1(o, 'm', i === 0 ? g : null);
  }
}

function mArp(tr, t, midi, dur, v) {
  if (live.m >= MAX_MUSIC_VOICES) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = tr.song.arpType;
  o.frequency.value = mtof(midi);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(tr.arpF);
  o.start(t); o.stop(t + dur + 0.02);
  track1(o, 'm', g);
}

function mPad(tr, t, midis, dur, v) {
  if (live.m >= MAX_MUSIC_VOICES - 3) return;
  const g = ctx.createGain();
  const end = t + dur + 0.35;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + 0.25);
  g.gain.setValueAtTime(v, t + dur);
  g.gain.linearRampToValueAtTime(0.0001, end);
  g.connect(tr.padF);
  for (let i = 0; i < midis.length; i++) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midis[i]);
    o.detune.value = (i % 2 ? 8 : -8);
    o.connect(g);
    o.start(t); o.stop(end + 0.02);
    track1(o, 'm', i === 0 ? g : null);
  }
}

function mLead(tr, t, midi, dur, v) {
  if (live.m >= MAX_MUSIC_VOICES - 1) return;
  const bell = tr.song.leadType === 'bell';
  const f = mtof(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + (bell ? 0.004 : 0.012));
  if (bell) {
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.5);
  } else {
    g.gain.setValueAtTime(v, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.04);
  }
  g.connect(tr.leadF);
  const stopAt = t + dur + (bell ? 0.52 : 0.06);
  const types = bell ? ['sine', 'triangle'] : ['sawtooth', 'square'];
  const mult = bell ? [1, 2] : [1, 1];
  const det = bell ? [0, 3] : [-6, 7];
  for (let i = 0; i < 2; i++) {
    const o = ctx.createOscillator();
    o.type = types[i];
    o.frequency.value = f * mult[i];
    o.detune.value = det[i];
    o.connect(g);
    o.start(t); o.stop(stopAt);
    track1(o, 'm', i === 0 ? g : null);
  }
}

function scheduleStep(tr, step, t) {
  const S = tr.song;
  const lv = S.lv;
  const sd = tr.stepDur;
  const s16 = step % 16;
  const bar = Math.floor(step / 16);
  const chord = S.chords[bar % S.chords.length];
  const off = chord[0] + S.transpose;
  const third = chord[1];
  const inFill = S.fill && (bar % 8 === 7) && s16 >= 12;

  // drums
  if (S.kick.charAt(s16) !== '.' && !inFill) mKick(tr, t, lv.kick);
  if (inFill) {
    mSnare(tr, t, lv.snare * (0.45 + 0.18 * (s16 - 12)));
  } else if (S.snare.charAt(s16) !== '.') {
    mSnare(tr, t, lv.snare);
  }
  const h = S.hat.charAt(s16);
  if (h === 'x') mHat(tr, t, lv.hat, false);
  else if (h === '-') mHat(tr, t, lv.hat * 0.5, false);
  else if (h === 'o') mHat(tr, t, lv.hat * 0.9, true);

  // bass
  const b = S.bass[s16];
  if (b) mBass(tr, t, S.root + off + (b === 2 ? 12 : 0), sd * S.bassLen, lv.bass);

  // pad: one chord per bar
  if (s16 === 0) {
    const pb = S.padBase + off;
    mPad(tr, t, [pb, pb + third, pb + 7], sd * 16, lv.pad);
  }

  // arpeggio
  if (s16 % S.arpEvery === 0) {
    const tones = [0, third, 7, 12, 12 + third, 19];
    const idx = S.arp[(s16 / S.arpEvery) % S.arp.length];
    const accent = (s16 % 4 === 0) ? 1 : 0.75;
    mArp(tr, t, S.arpBase + off + tones[idx], sd * S.arpEvery * 0.95, lv.arp * accent);
  }

  // lead motif: second half of every 8-bar phrase
  if (S.lead && (bar % 8) >= 4) {
    const row = S.lead[bar % S.lead.length];
    const n = row[s16];
    if (n !== null && n !== undefined) {
      let len = 1;
      while (len < 4 && s16 + len < 16 && (row[s16 + len] === null || row[s16 + len] === undefined)) len++;
      mLead(tr, t, S.leadBase + S.transpose + n, sd * len * 0.92, lv.lead);
    }
  }
}

function musicTick() {
  try {
    if (!ctx || !track || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (track.next < now - 0.05) {
      // fell behind (throttled timer): skip ahead, keep step grid moving
      const missed = Math.ceil((now + 0.03 - track.next) / track.stepDur);
      track.step += missed;
      track.next += missed * track.stepDur;
    }
    let guard = 0;
    while (track.next < now + LOOKAHEAD && guard < 8) {
      scheduleStep(track, track.step, Math.max(track.next, now + 0.002));
      track.next += track.stepDur;
      track.step++;
      guard++;
    }
  } catch (e) { /* ignore */ }
}

function startMusic(name) {
  if (!ctx) return;
  if (track) { killTrack(track); track = null; }
  if (name && has(SONGS, name)) {
    track = makeTrack(SONGS[name]);
    if (timer === null) timer = setInterval(musicTick, TICK_MS);
  } else if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/* ----------------------------------------------------------------- ENGINE */

function buildEngine() {
  const t = ctx.currentTime;
  const e = {};

  // turbine core: two detuned saws + sub (+ boost layer) -> lowpass -> gain
  e.lp = mkFilter('lowpass', 300, 2);
  e.gain = ctx.createGain();
  e.gain.gain.value = 0;
  e.lp.connect(e.gain);
  e.gain.connect(engineBus);

  e.saw1 = ctx.createOscillator();
  e.saw2 = ctx.createOscillator();
  e.sub = ctx.createOscillator();
  e.bst = ctx.createOscillator();
  e.saw1.type = 'sawtooth';
  e.saw2.type = 'sawtooth';
  e.sub.type = 'triangle';
  e.bst.type = 'sawtooth';
  e.saw1.frequency.value = 52;
  e.saw2.frequency.value = 52;
  e.saw2.detune.value = 14;
  e.sub.frequency.value = 26;
  e.bst.frequency.value = 104;
  e.bst.detune.value = -9;

  const g1 = ctx.createGain(); g1.gain.value = 0.45;
  const g2 = ctx.createGain(); g2.gain.value = 0.45;
  const g3 = ctx.createGain(); g3.gain.value = 0.7;
  e.bstGain = ctx.createGain(); e.bstGain.gain.value = 0;
  e.saw1.connect(g1); g1.connect(e.lp);
  e.saw2.connect(g2); g2.connect(e.lp);
  e.sub.connect(g3); g3.connect(e.lp);
  e.bst.connect(e.bstGain); e.bstGain.connect(e.lp);

  // one looping noise source feeds whoosh, drift screech and offroad rumble
  e.noise = ctx.createBufferSource();
  e.noise.buffer = noiseBuf;
  e.noise.loop = true;

  e.whF = mkFilter('bandpass', 600, 0.8);
  e.whGain = ctx.createGain(); e.whGain.gain.value = 0;
  e.noise.connect(e.whF); e.whF.connect(e.whGain); e.whGain.connect(engineBus);

  e.drF = mkFilter('bandpass', 2000, 6);
  const drAM = ctx.createGain(); drAM.gain.value = 0.55;
  e.drGain = ctx.createGain(); e.drGain.gain.value = 0;
  e.drLfo = ctx.createOscillator();
  e.drLfo.type = 'sawtooth';
  e.drLfo.frequency.value = 47;
  const drDepth = ctx.createGain(); drDepth.gain.value = 0.45;
  e.drLfo.connect(drDepth); drDepth.connect(drAM.gain);
  e.noise.connect(e.drF); e.drF.connect(drAM); drAM.connect(e.drGain); e.drGain.connect(engineBus);

  e.ruF = mkFilter('lowpass', 320, 1.2);
  const ruAM = ctx.createGain(); ruAM.gain.value = 0.55;
  e.ruGain = ctx.createGain(); e.ruGain.gain.value = 0;
  e.ruLfo = ctx.createOscillator();
  e.ruLfo.type = 'square';
  e.ruLfo.frequency.value = 17;
  const ruDepth = ctx.createGain(); ruDepth.gain.value = 0.45;
  e.ruLfo.connect(ruDepth); ruDepth.connect(ruAM.gain);
  e.noise.connect(e.ruF); e.ruF.connect(ruAM); ruAM.connect(e.ruGain); e.ruGain.connect(engineBus);

  e.saw1.start(t); e.saw2.start(t); e.sub.start(t); e.bst.start(t);
  e.drLfo.start(t); e.ruLfo.start(t); e.noise.start(t);
  return e;
}

function updateEngine(s) {
  if (!ctx) return;
  const active = !!(s && s.active);
  if (!eng) {
    if (!active) return;
    eng = buildEngine();
  }
  const t = ctx.currentTime;
  const e = eng;

  if (!active) {
    if (engSilent) return;
    engSilent = true;
    engLastT = -1;
    e.gain.gain.setTargetAtTime(0, t, 0.12);
    e.whGain.gain.setTargetAtTime(0, t, 0.12);
    e.bstGain.gain.setTargetAtTime(0, t, 0.1);
    e.drGain.gain.setTargetAtTime(0, t, 0.08);
    e.ruGain.gain.setTargetAtTime(0, t, 0.08);
    return;
  }

  // throttle automation to ~30Hz (frames arrive at 60-120Hz)
  if (!engSilent && engLastT >= 0 && t - engLastT < 0.03 && t >= engLastT) return;
  engLastT = t;
  engSilent = false;

  const sp = clamp(num(s.speed01, 0), 0, 1.4);
  const boost = !!s.boost;
  const drift = !!s.drifting;
  const off = !!s.offroad;

  const f = (52 + 95 * sp) * (boost ? 1.12 : 1);
  const cut = Math.min(6000, (280 + 2100 * sp * sp) * (boost ? 1.6 : 1));
  const tc = 0.08;

  e.saw1.frequency.setTargetAtTime(f, t, tc);
  e.saw2.frequency.setTargetAtTime(f, t, tc);
  e.sub.frequency.setTargetAtTime(f * 0.5, t, tc);
  e.bst.frequency.setTargetAtTime(f * 2, t, tc);
  e.lp.frequency.setTargetAtTime(cut, t, tc);
  e.gain.gain.setTargetAtTime(0.1 + 0.1 * Math.min(sp, 1), t, 0.1);
  e.bstGain.gain.setTargetAtTime(boost ? 0.35 : 0, t, 0.07);

  e.whF.frequency.setTargetAtTime(500 + 2600 * sp, t, tc);
  e.whGain.gain.setTargetAtTime(0.02 + 0.15 * sp * sp + (boost ? 0.08 : 0), t, 0.1);

  e.drF.frequency.setTargetAtTime(1800 + 900 * sp, t, tc);
  e.drGain.gain.setTargetAtTime(drift ? 0.1 + 0.07 * sp : 0, t, 0.05);

  e.ruGain.gain.setTargetAtTime(off ? 0.25 * (0.3 + Math.min(sp, 1)) : 0, t, 0.06);
}

/* ------------------------------------------------------------- public API */

export const audio = {
  unlock() {
    try {
      try {
        if (typeof navigator !== 'undefined' && navigator.audioSession) {
          navigator.audioSession.type = 'playback';
        }
      } catch (e) { /* ignore */ }

      const fresh = !ctx;
      if (fresh) {
        if (!initContext()) return;
      }
      installListeners();
      resumeCtx();

      // iOS: play a silent buffer inside the gesture to fully unlock output
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        b.start(0);
      } catch (e) { /* ignore */ }

      if (fresh && wantMusic) startMusic(wantMusic);
    } catch (e) { /* never throw */ }
  },

  setMusic(name) {
    try {
      const n = (typeof name === 'string' && has(SONGS, name)) ? name : null;
      if (n === wantMusic) return;
      wantMusic = n;
      if (ctx) startMusic(n);
    } catch (e) { /* never throw */ }
  },

  setEngine(s) {
    try { updateEngine(s); } catch (e) { /* never throw */ }
  },

  sfx(name, opts) {
    try { playSfx(name, opts); } catch (e) { /* never throw */ }
  },

  setVolumes(v) {
    try {
      if (!v || typeof v !== 'object') return;
      if (typeof v.master === 'number' && isFinite(v.master)) vol.master = clamp(v.master, 0, 1);
      if (typeof v.music === 'number' && isFinite(v.music)) vol.music = clamp(v.music, 0, 1);
      if (typeof v.sfx === 'number' && isFinite(v.sfx)) vol.sfx = clamp(v.sfx, 0, 1);
      applyVolumes();
    } catch (e) { /* never throw */ }
  },

  setMuted(m) {
    try {
      muted = !!m;
      applyVolumes();
    } catch (e) { /* never throw */ }
  },
};

export default audio;
