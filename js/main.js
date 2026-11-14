// VOLTLINE — game flow: menus, lobby, race loop, glue between sim / render / audio / net / ui.
import { TRACKS, buildTrack } from './track.js';
import { createRace, C, COLORS, AI_NAMES, ITEM_LABEL } from './sim.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createUI } from './ui.js';
import { audio } from './audio.js';
import { createNet } from './net.js';

const GRID = 6;
const canvas = document.getElementById('game');
const root = document.getElementById('ui');

let R = null, race = null, track = null, trackIndex = 0, settings = null;
let mode = 'menu';            // 'menu' | 'race'
let paused = false, online = false, resultsShown = false, resultsT = 0, sendT = 0, rollTick = 0, calibrated = false;
const timers = [];
const later = (fn, ms) => timers.push(setTimeout(fn, ms));
const clearTimers = () => { while (timers.length) clearTimeout(timers.pop()); };

const ui = createUI(root, {
  onSolo() { prepControls(); startRace({ t: trackIndex, r: soloRoster() }); },
  async onHost() {
    prepControls();
    ui.show('loading');
    try { await net.host(ui.getName()); online = true; showLobby(); }
    catch (e) { ui.show('title'); ui.toast(e && e.message || 'Could not create room', 'bad'); }
  },
  async onJoin(code) {
    prepControls();
    ui.show('loading');
    try { await net.join(code, ui.getName()); online = true; showLobby(); }
    catch (e) { ui.show('join'); ui.toast(e && e.message || 'Could not join', 'bad'); }
  },
  onStart() {
    if (!net.isHost) return;
    const r = net.players.map(p => ({ id: p.id, name: p.name, color: COLORS[p.slot % COLORS.length], ai: false }));
    for (let i = 0; r.length < GRID; i++) r.push({ id: 'a' + i, name: AI_NAMES[i], color: COLORS[r.length % COLORS.length], ai: true });
    const msg = { t: trackIndex, r };
    net.setLocked(true);
    net.sendEvent('start', msg);
    startRace(msg);
  },
  onLeave() { leaveRoom(); toMenu(); },
  onRematch() {
    if (!online) { startRace({ t: trackIndex, r: soloRoster() }); return; }
    if (net.isHost) { net.sendEvent('lobby', {}); net.setLocked(false); endRace(); showLobby(); }
  },
  onMenu() { leaveRoom(); toMenu(); },
  onItem() { input.queueItem(); },
  onPause() { if (mode === 'race' && !resultsShown) setPaused(true); else ui.setPaused(false); },
  onResume() { setPaused(false); },
  onQuit() { leaveRoom(); toMenu(); },
  onSettings(s) { applySettings(s); },
  onTrack(i) { setTrack(i); },
  onRecalibrate() { input.calibrate(); ui.toast('TILT CALIBRATED', 'info'); },
  onUiSound(n) { audio.unlock(); audio.sfx(n); },
});

const input = createInput(ui, { onPause: () => { if (mode === 'race') togglePause(); } });

const net = createNet({
  onPlayers() { if (online && mode === 'menu') showLobby(); },
  onState(from, obj) { if (race) race.applyState(obj); },
  onEvent(from, type, data) {
    if (type === 'start') { if (!net.isHost) startRace(data); }
    else if (type === 'lobby') { endRace(); showLobby(); }
    else if (race) {
      race.applyEvent(from, type, data);
      if (type === 'left') { const k = race.karts.find(q => q.id === from); if (k) ui.toast(k.name + ' LEFT', 'info'); }
    }
  },
  onClosed() { online = false; toMenu(); ui.toast('ROOM CLOSED / 接続が切れました', 'bad'); },
  onError(m) { ui.toast(String(m).slice(0, 60), 'bad'); },
});

function soloRoster() {
  const r = [{ id: 'p0', name: ui.getName(), color: COLORS[0], ai: false }];
  for (let i = 0; r.length < GRID; i++) r.push({ id: 'a' + i, name: AI_NAMES[i], color: COLORS[r.length % COLORS.length], ai: true });
  return r;
}

function prepControls() {
  audio.unlock();
  if (settings.control === 'tilt') input.enableTilt();   // inside the tap: iOS permission prompt
}

function applySettings(s) {
  const q = settings && settings.quality;
  settings = s;
  audio.setVolumes({ master: s.master, music: s.music, sfx: s.sfx });
  ui.setControlMode(s.control, s.autoAccel);
  if (R && q && q !== s.quality) R.setQuality(s.quality);
}

function setTrack(i) {
  trackIndex = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
  track = buildTrack(TRACKS[trackIndex]);
  if (R) R.loadTrack(track);
  const pts = [];
  for (let j = 0; j < track.n; j += 3) pts.push({ x: track.px[j], z: track.pz[j] });
  ui.setMinimap(pts);
  ui.setTracks(TRACKS.map(t => t.name), trackIndex);
  if (online && mode === 'menu' && net.active) showLobby();
}

function showLobby() {
  mode = 'menu';
  ui.setLobby({
    code: net.code, isHost: net.isHost, trackName: TRACKS[trackIndex].name, status: '',
    players: net.players.map(p => ({ ...p, isYou: p.id === net.myId, isHost: p.id === 'p0' })),
  });
  ui.show('lobby');
  audio.setMusic('menu');
}

function leaveRoom() {
  if (online) { try { net.leave(); } catch (e) { /* ignore */ } }
  online = false;
}

function endRace() {
  clearTimers();
  race = null; mode = 'menu'; paused = false; resultsShown = false;
  ui.setPaused(false); ui.countdown(null);
  audio.setEngine({ active: false, speed01: 0, boost: false, drifting: false, offroad: false });
}

function toMenu() {
  endRace();
  ui.show('title');
  audio.setMusic('menu');
}

function setPaused(p) {
  paused = p;
  ui.setPaused(p);
}
function togglePause() { if (mode === 'race' && !resultsShown) setPaused(!paused); }

function startRace(msg) {
  endRace();
  if (msg.t !== trackIndex || !track) setTrack(msg.t);
  const myId = online ? net.myId : 'p0';
  const roster = msg.r.map(e => ({ id: e.id, name: e.name, color: e.color, kind: e.id === myId ? 'local' : e.ai ? 'ai' : 'remote' }));
  race = createRace(track, roster, !online || net.isHost, {
    sfx(name, k) {
      const me = race && race.local;
      if (!k || k === me || !me) { audio.sfx(name); return; }
      const d = Math.hypot(k.x - me.x, k.z - me.z);
      if (d < 70 && name !== 'item_pick' && name !== 'drift_start') audio.sfx(name, { vol: 0.55 * (1 - d / 70) });
    },
    net(type, data) { if (online) net.sendEvent(type, data); },
    local: onRaceEvent,
  });
  R.setRace(race);
  mode = 'race'; calibrated = false; sendT = 0;
  ui.show('hud');
  ui.setControlMode(settings.control, settings.autoAccel);
  audio.setMusic(null);
  input.calibrate();
}

function onRaceEvent(type, k, d) {
  const me = race && race.local;
  if (type === 'count') {
    ui.countdown(d > 0 ? d : 'GO');
    audio.sfx(d > 0 ? 'count_beep' : 'count_go');
    if (d === 0) { audio.setMusic('race'); later(() => ui.countdown(null), 900); }
    return;
  }
  if (type === 'storm') { ui.flash('#fff36b'); R.shake(0.5); if (k && k !== me) ui.toast('STORM — ' + k.name, 'bad'); return; }
  if (k !== me) return;
  if (type === 'lap') {
    if (d === race.laps - 1) { ui.banner('FINAL LAP'); audio.sfx('final_lap'); audio.setMusic('final'); }
    else { ui.toast('LAP ' + (d + 1) + ' / ' + race.laps, 'info'); audio.sfx('lap'); }
  } else if (type === 'finish') {
    ui.banner('FINISH'); audio.sfx('finish'); audio.setMusic('results');
    later(() => { resultsShown = true; resultsT = 0; showResults(); }, 2600);
  } else if (type === 'hit') { ui.flash(d === 'storm' ? '#fff36b' : '#ff2b5a'); R.shake(0.9); }
  else if (type === 'blocked') ui.toast('AEGIS BLOCK', 'good');
  else if (type === 'rocket') ui.toast('ROCKET START!', 'good');
  else if (type === 'miniboost') ui.toast(['', 'BOOST', 'SUPER BOOST', 'ULTRA BOOST'][d], 'good');
  else if (type === 'overtake') audio.sfx('overtake', { vol: 0.5 });
  else if (type === 'wall') R.shake(0.35);
}

function showResults() {
  if (!race) return;
  const order = race.rank();
  ui.showResults({
    rows: order.map(k => ({ pos: k.pos, name: k.name, timeMs: k.finished ? Math.round(k.finishTime * 1000) : null, isYou: k === race.local, color: k.color })),
    canRematch: !online || net.isHost,
    waiting: order.some(k => !k.finished),
  });
}

const hud = {};
const dots = [];
function frameRace(dt) {
  const me = race.local;
  if (!(paused && !online)) {
    const inp = input.read(settings, dt);
    if (!calibrated && race.countT < 1.2) { calibrated = true; input.calibrate(); }
    race.step(dt, inp);
    if (online) {
      sendT += dt;
      if (sendT > 1 / 15) { sendT = 0; net.sendState(race.snapshot()); }
    }
  }
  if (!race) return;
  R.update(race, me, dt);
  if (!me) return;
  if (me.rollT > 0) { rollTick -= dt; if (rollTick <= 0) { rollTick = 0.085; audio.sfx('item_roulette'); } }
  audio.setEngine({
    active: !paused && !resultsShown, speed01: Math.abs(me.speed) / C.MAX,
    boost: me.boostT > 0, drifting: me.drifting, offroad: me.offroad && me.speed > 8,
  });
  if (resultsShown) {
    resultsT += dt;
    if (resultsT > 1) { resultsT = 0; showResults(); }
    return;
  }
  let total = 0;
  dots.length = 0;
  for (const k of race.karts) {
    if (k.gone) continue;
    total++;
    dots.push({ x: k.x, z: k.z, color: k.color, you: k === me });
  }
  hud.speed = Math.round(Math.abs(me.speed) * C.KMH);
  hud.lap = Math.min(race.laps, me.lap + 1); hud.laps = race.laps;
  hud.pos = me.pos; hud.total = total;
  hud.timeMs = Math.round(race.time * 1000);
  hud.item = me.item; hud.rolling = me.rollT > 0;
  hud.charge = me.drifting ? Math.min(1, me.charge / C.TIER[2]) : 0;
  hud.tier = me.tier; hud.boosting = me.boostT > 0;
  hud.wrongWay = me.wrongWay; hud.slip = me.slip; hud.shield = me.shield > 0;
  ui.setHud(hud);
  ui.updateMinimap(dots);
}

let last = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
  last = t;
  try {
    if (mode === 'race' && race) frameRace(dt);
    else R.orbit(dt);
    R.render();
  } catch (e) {
    console.error(e);
  }
}

async function boot() {
  ui.show('loading');
  applySettings(ui.getSettings());
  R = await createRenderer(canvas, settings.quality);
  setTrack(0);
  ui.show('title');
  const unlock = () => { audio.unlock(); if (mode === 'menu') audio.setMusic('menu'); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock);
  document.addEventListener('visibilitychange', () => { if (document.hidden && mode === 'race' && !online && !resultsShown) setPaused(true); });
  window.__voltline = { get race() { return race; }, get R() { return R; }, ui, net, input, ITEM_LABEL };
  requestAnimationFrame(frame);
}
boot().catch(e => { console.error(e); root.insertAdjacentHTML('beforeend', '<p style="color:#fff;padding:20px">Failed to start: ' + String(e && e.message) + '</p>'); });
