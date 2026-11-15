// Race simulation: craft physics, drift boosts, items, AI, and network state hooks.
import { wrapAngle } from './track.js';

export const C = {
  MAX: 62, ACC: 34, BRAKE: 70, TURN: 1.9, KMH: 5,
  TIER: [0.7, 1.7, 3.0], TIER_BOOST: [0, 0.7, 1.3, 2.2],
  RADIUS: 1.5,
};
export const COLORS = ['#22e6ff', '#ff2bd6', '#ffc531', '#7cff4f', '#ff6a3d', '#a78bfa'];
export const AI_NAMES = ['VEGA', 'NOVA', 'ORION', 'LYRA', 'ATLAS', 'ECHO'];
export const ITEM_LABEL = { surge: 'SURGE', bolt: 'BOLT', trap: 'TRAP', aegis: 'AEGIS', overdrive: 'OVERDRIVE', storm: 'STORM' };

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const loc = { i: 0, lat: 0, s: 0 };
const NO_INPUT = { steer: 0, accel: false, brake: false, drift: false, item: false, launch: false };

function pickItem(rank01) {
  const r = rank01;
  const w = {
    surge: 3,
    bolt: 1.5 + 2.5 * r,
    trap: 4 * (1 - r),
    aegis: 0.6 + 2.6 * (1 - r),
    overdrive: 5 * r * r,
    storm: r > 0.55 ? 2.6 * r : 0,
  };
  let tot = 0;
  for (const k in w) tot += w[k];
  let x = Math.random() * tot;
  for (const k in w) { x -= w[k]; if (x <= 0) return k; }
  return 'surge';
}

// roster: [{id, name, color, kind:'local'|'ai'|'remote'}]; authority: this client simulates AI craft.
// hooks: sfx(name, kart), net(type, data), local(type, kart, data)
export function createRace(track, roster, authority, hooks) {
  const def = track.def;
  const race = {
    track, laps: def.laps, karts: [], traps: [], bolts: [], time: 0, countT: 3.8, state: 'count',
    boxes: track.boxes.map(b => ({ x: b.x, z: b.z, t: 0 })),
    pads: track.pads, lastCount: 4, uid: 0, local: null,
  };

  roster.forEach((r, slot) => {
    const g = track.grid(slot);
    const k = {
      id: r.id, name: r.name, color: r.color, kind: r.kind, slot,
      owned: r.kind === 'local' || (r.kind === 'ai' && authority),
      ai: r.kind === 'ai',
      x: g.x, z: g.z, h: g.h, speed: 0, steer: 0,
      idx: g.i, lat: 0, lastS: 0, dist: 0, lap: 0, pos: slot + 1,
      drifting: false, driftDir: 0, driftAmt: 0, charge: 0, tier: 0, driftLock: false, hop: 0,
      boostT: 0, spinT: 0, spin: 0, inv: 0, shield: 0, stormT: 0,
      item: null, rollT: 0, slipAcc: 0, slip: false, offroad: false, wrongWay: false,
      padCd: 0, wallCd: 0, bumpCd: 0, launchAt: -1,
      finished: false, finishTime: null, gone: false,
      topMul: 1, turnMul: 1, aiLat: 0, aiT: 0, aiItemT: 0, aiBase: 1,
      net: null, yawVis: 0, lean: 0,
    };
    track.locate(k.x, k.z, -1, loc);
    k.idx = loc.i; k.lat = loc.lat; k.lastS = loc.s;
    k.dist = loc.s > track.len / 2 ? loc.s - track.len : loc.s;
    if (k.ai) {
      k.aiBase = 0.94 + 0.022 * (slot % 5) + Math.random() * 0.015;
      k.turnMul = 1.3;
      k.aiLat = (Math.random() * 2 - 1) * track.half * 0.5;
    }
    if (r.kind === 'local') race.local = k;
    race.karts.push(k);
  });

  const byId = id => race.karts.find(k => k.id === id);
  const sfx = (n, k) => hooks.sfx && hooks.sfx(n, k);
  const net = (t, d) => hooks.net && hooks.net(t, d);
  const localEv = (t, k, d) => hooks.local && hooks.local(t, k, d);

  function boost(k, t) {
    k.boostT = Math.max(k.boostT, t);
    sfx('boost', k);
  }

  function hitKart(k, kind) {
    if (k.inv > 0 || k.finished) return;
    if (k.shield > 0) { k.shield = 0; k.inv = 1; sfx('shield_hit', k); localEv('blocked', k); return; }
    k.drifting = false; k.charge = 0; k.tier = 0; k.boostT = 0;
    if (kind === 'storm') { k.stormT = 2.6; k.speed *= 0.55; k.inv = 0.5; sfx('hit', k); }
    else { k.spinT = 1.2; k.inv = 3.2; sfx('spinout', k); }
    localEv('hit', k, kind);
  }

  function useItem(k) {
    const it = k.item;
    if (!it || k.rollT > 0 || k.spinT > 0) return;
    k.item = null;
    sfx('item_use', k);
    if (it === 'surge') boost(k, 1.5);
    else if (it === 'overdrive') boost(k, 3.6);
    else if (it === 'aegis') { k.shield = 9; sfx('shield_on', k); }
    else if (it === 'bolt') {
      const b = { id: k.id + ':' + (race.uid++), o: k.id, s: k.lastS + 3, lat: k.lat, life: 4, owned: true, x: k.x, z: k.z, h: k.h };
      race.bolts.push(b);
      net('bolt', { id: b.id, o: b.o, s: +b.s.toFixed(1), lat: +b.lat.toFixed(1) });
      sfx('bolt_fire', k);
    } else if (it === 'trap') {
      const t = { id: k.id + ':' + (race.uid++), o: k.id, age: 0, x: k.x - Math.sin(k.h) * 3.5, z: k.z - Math.cos(k.h) * 3.5 };
      race.traps.push(t);
      net('trap', { id: t.id, o: t.o, x: +t.x.toFixed(1), z: +t.z.toFixed(1) });
      sfx('trap_drop', k);
    } else if (it === 'storm') {
      net('storm', { o: k.id, d: k.dist });
      applyStorm(k.id, k.dist);
    }
  }

  function applyStorm(ownerId, d) {
    sfx('storm', null);
    localEv('storm', byId(ownerId));
    for (const k of race.karts) if (k.owned && k.id !== ownerId && k.dist > d) hitKart(k, 'storm');
  }

  function aiInput(k, dt) {
    const tr = track, n = tr.n;
    k.aiT -= dt;
    if (k.aiT <= 0) { k.aiT = 2 + Math.random() * 3; k.aiLat = (Math.random() * 2 - 1) * tr.half * 0.6; }
    const j = (k.idx + 6 + ((Math.max(0, k.speed) * 0.3) | 0)) % n;
    const gx = tr.px[j] + tr.nx[j] * k.aiLat, gz = tr.pz[j] + tr.nz[j] * k.aiLat;
    const d = wrapAngle(Math.atan2(gx - k.x, gz - k.z) - k.h);
    let c = 0;
    const far = 10 + ((Math.max(0, k.speed) * 0.55) | 0);
    for (let q = 2; q < far; q += 2) c = Math.max(c, Math.abs(tr.curv[(k.idx + q) % n]));
    const vmax = (1.75 * k.turnMul) / (c + 0.0107 * k.turnMul);
    // rubber band against the best human
    let lead = -1e9;
    for (const o of race.karts) if (!o.ai && !o.gone) lead = Math.max(lead, o.dist);
    const band = lead > -1e8 ? clamp((lead - k.dist) / 160, -0.07, 0.1) : 0;
    k.topMul = k.aiBase + band * (k.lap >= race.laps - 1 ? 0.6 : 1);
    let item = false;
    if (k.item && k.rollT <= 0) {
      k.aiItemT += dt;
      let ok = k.aiItemT > 1.2 + (k.slot % 3);
      if (ok && k.item === 'bolt' && k.aiItemT < 8) {
        ok = false;
        for (const o of race.karts) { const dd = o.dist - k.dist; if (o !== k && dd > 4 && dd < 70) ok = true; }
      }
      if (ok) { item = true; k.aiItemT = 0; }
    } else k.aiItemT = 0;
    return { steer: clamp(-d * 2.6, -1, 1), accel: k.speed < vmax, brake: k.speed > vmax + 7, drift: false, item, launch: false };
  }

  function stepOwned(k, inp, dt) {
    const tr = track;
    k.inv = Math.max(0, k.inv - dt);
    k.shield = Math.max(0, k.shield - dt);
    k.stormT = Math.max(0, k.stormT - dt);
    k.padCd -= dt; k.wallCd -= dt; k.bumpCd -= dt;
    k.hop = Math.max(0, k.hop - dt * 4);

    if (k.spinT > 0) {
      k.spinT -= dt; k.spin += dt * 15;
      k.speed *= Math.exp(-2.4 * dt);
      inp = NO_INPUT;
      if (k.spinT <= 0) k.spin = 0;
    }
    k.steer += (clamp(inp.steer, -1, 1) - k.steer) * Math.min(1, dt * 11);

    // item roulette
    if (k.rollT > 0) {
      k.rollT -= dt;
      if (k.rollT <= 0) {
        const total = race.karts.length;
        k.item = pickItem(total > 1 ? (k.pos - 1) / (total - 1) : 0);
        if (k === race.local) sfx('item_ready', k);
      }
    }
    if (inp.item) useItem(k);

    // speed
    k.offroad = Math.abs(k.lat) > tr.half + 0.3;
    let top = C.MAX * k.topMul, acc = C.ACC;
    if (k.boostT > 0) { k.boostT -= dt; top *= 1.32; acc *= 3.2; }
    else if (k.offroad) top *= 0.55;
    if (k.stormT > 0) top *= 0.6;
    if (k.slip) top *= 1.09;
    if (inp.brake) k.speed = Math.max(-14, k.speed - C.BRAKE * dt * (k.speed > 0 ? 1 : 0.35));
    else if (inp.accel) {
      if (k.speed < top) k.speed += acc * (1 - k.speed / top) * dt + (k.speed < 0 ? 40 * dt : 0);
      else k.speed -= (k.speed - top) * Math.min(1, dt * (k.offroad ? 3.5 : 1.6));
    } else k.speed -= k.speed * 0.7 * dt;

    // drift
    const sp01 = k.speed / C.MAX;
    if (!inp.drift) k.driftLock = false;
    if (!k.drifting) {
      if (inp.drift && !k.driftLock && Math.abs(k.steer) > 0.3 && sp01 > 0.45 && k.spinT <= 0) {
        k.drifting = true; k.driftDir = Math.sign(k.steer); k.charge = 0; k.tier = 0; k.hop = 1;
        sfx('drift_start', k);
      }
    } else if (!inp.drift || sp01 < 0.3 || k.spinT > 0) {
      if (!inp.drift && k.tier > 0 && k.spinT <= 0) { boost(k, C.TIER_BOOST[k.tier]); localEv('miniboost', k, k.tier); }
      if (inp.drift) k.driftLock = true;
      k.drifting = false; k.charge = 0; k.tier = 0;
    } else {
      k.charge += dt * (1 + 0.55 * k.steer * k.driftDir) * (k.offroad ? 0.3 : 1);
      const t = k.charge > C.TIER[2] ? 3 : k.charge > C.TIER[1] ? 2 : k.charge > C.TIER[0] ? 1 : 0;
      if (t > k.tier) { k.tier = t; sfx('drift_tier' + t, k); }
    }

    // turning: blend from grip steering into the drift arc over ~0.4s (and back out smoothly)
    k.driftAmt += ((k.drifting ? 1 : 0) - k.driftAmt) * Math.min(1, dt * (k.drifting ? 4.5 : 7));
    const grip = k.steer * C.TURN * k.turnMul * (1 - 0.35 * clamp(sp01, 0, 1));
    const arc = (k.driftDir * 0.6 + k.steer * 0.4) * C.TURN * 1.1;   // inner steer = tight, counter-steer = wide
    let turn = grip + (arc - grip) * k.driftAmt;
    turn *= clamp(k.speed / 12, -1, 1);
    k.h = wrapAngle(k.h - turn * dt);

    // move (+ outward slide while drifting)
    const sh = Math.sin(k.h), ch = Math.cos(k.h);
    k.x += sh * k.speed * dt; k.z += ch * k.speed * dt;
    if (k.driftAmt > 0.01) {
      const sl = k.driftDir * k.speed * 0.1 * k.driftAmt * dt;
      k.x += ch * sl; k.z += -sh * sl;
    }

    // craft-to-craft bumps
    for (const o of race.karts) {
      if (o === k || o.gone) continue;
      const dx = k.x - o.x, dz = k.z - o.z, d2 = dx * dx + dz * dz, R = C.RADIUS * 2;
      if (d2 < R * R && d2 > 1e-4) {
        const d = Math.sqrt(d2), push = (R - d) * (o.owned ? 0.5 : 1);
        k.x += dx / d * push; k.z += dz / d * push;
        k.speed *= 0.985;
        if (k.bumpCd <= 0) { k.bumpCd = 0.5; if (k === race.local || o === race.local) sfx('hit', k); }
      }
    }

    // track relation, walls, progress
    tr.locate(k.x, k.z, k.idx, loc);
    const W = tr.wall - 1.3;
    if (Math.abs(loc.lat) > W) {
      const sg = Math.sign(loc.lat), over = Math.abs(loc.lat) - W, i = loc.i;
      k.x -= tr.nx[i] * sg * over; k.z -= tr.nz[i] * sg * over;
      loc.lat = sg * W;
      const d = wrapAngle(k.h - tr.heading[i]);
      if (d * sg > 0 && k.speed > 0) {
        const impact = Math.min(1, Math.abs(Math.sin(d)));
        k.speed *= 1 - 0.45 * impact * Math.min(1, dt * 30);
        k.h = wrapAngle(k.h - d * Math.min(1, dt * 7 + impact * 0.25));
        if (impact > 0.2 && k.wallCd <= 0) { k.wallCd = 0.45; k.speed *= 0.82; sfx('wall', k); localEv('wall', k); }
      }
    }
    k.idx = loc.i; k.lat = loc.lat;
    let ds = loc.s - k.lastS;
    if (ds < -tr.len / 2) ds += tr.len; else if (ds > tr.len / 2) ds -= tr.len;
    k.lastS = loc.s; k.dist += ds;
    k.wrongWay = k.speed > 6 && Math.cos(k.h - tr.heading[k.idx]) < -0.25;
    const lap = Math.max(0, Math.floor(k.dist / tr.len));
    if (lap > k.lap) {
      k.lap = lap;
      if (lap >= race.laps && !k.finished) {
        k.finished = true; k.finishTime = race.time; k.ai = true; k.aiBase = 0.8; k.turnMul = 1.3;
        net('finish', { k: k.id, t: Math.round(race.time * 1000) });
        localEv('finish', k);
      } else localEv('lap', k, lap);
    }

    // boost pads, item boxes, traps
    for (const p of race.pads) {
      const dx = k.x - p.x, dz = k.z - p.z;
      if (dx * dx + dz * dz < 12 && k.padCd <= 0) { k.padCd = 1; boost(k, 1.0); }
    }
    if (!k.item && k.rollT <= 0 && !k.finished) {
      for (const b of race.boxes) {
        if (b.t > 0) continue;
        const dx = k.x - b.x, dz = k.z - b.z;
        if (dx * dx + dz * dz < 8.5) { b.t = 5; k.rollT = 1.3; sfx('item_pick', k); break; }
      }
    }
    for (let i = race.traps.length - 1; i >= 0; i--) {
      const t = race.traps[i];
      if (t.age < (t.o === k.id ? 1.2 : 0.4)) continue;
      const dx = k.x - t.x, dz = k.z - t.z;
      if (dx * dx + dz * dz < 6) { race.traps.splice(i, 1); net('trapGone', { id: t.id }); hitKart(k, 'trap'); }
    }

    // slipstream
    let drafting = false;
    for (const o of race.karts) {
      if (o === k || o.gone || o.speed < 30) continue;
      const dx = o.x - k.x, dz = o.z - k.z;
      const f = dx * sh + dz * ch, s = dx * ch - dz * sh;
      if (f > 3 && f < 17 && Math.abs(s) < 2.6) drafting = true;
    }
    k.slipAcc = clamp(k.slipAcc + (drafting ? dt : -dt * 1.5), 0, 2);
    const slip = k.slipAcc > 1.1;
    if (slip && !k.slip && k === race.local) sfx('slipstream', k);
    k.slip = slip;

    // visuals
    const da = k.driftAmt;
    const yawT = -k.driftDir * 0.38 * da - k.steer * 0.1 * (1 - da);
    k.yawVis += (yawT - k.yawVis) * Math.min(1, dt * 7);
    k.lean += ((k.driftDir * 0.28 * da + k.steer * 0.22 * (1 - da)) * clamp(sp01, 0, 1) - k.lean) * Math.min(1, dt * 7);
  }

  function stepRemote(k, dt) {
    const n = k.net;
    if (!n) return;
    n.x += Math.sin(n.h) * n.sp * dt; n.z += Math.cos(n.h) * n.sp * dt;
    const a = 1 - Math.exp(-12 * dt);
    k.x += (n.x - k.x) * a; k.z += (n.z - k.z) * a;
    k.h = wrapAngle(k.h + wrapAngle(n.h - k.h) * a);
    k.speed = n.sp; k.dist += n.sp * dt;
    if (k.spinT > 0) k.spin += dt * 15; else k.spin = 0;
    const yawT = k.drifting ? -k.driftDir * 0.38 : 0;
    k.yawVis += (yawT - k.yawVis) * Math.min(1, dt * 5);
    k.lean += ((k.drifting ? k.driftDir * 0.3 : 0) - k.lean) * Math.min(1, dt * 8);
    track.locate(k.x, k.z, k.idx, loc);
    k.idx = loc.i; k.lat = loc.lat; k.lastS = loc.s;
  }

  function stepBolts(dt) {
    for (let i = race.bolts.length - 1; i >= 0; i--) {
      const b = race.bolts[i];
      b.life -= dt; b.s += 125 * dt;
      let tgt = null, best = 90;
      const bs = ((b.s % track.len) + track.len) % track.len;
      for (const k of race.karts) {
        if (k.id === b.o || k.gone) continue;
        let d = k.lastS - bs;
        if (d < -track.len / 2) d += track.len;
        if (d > -3 && d < best) { best = d; tgt = k; }
      }
      if (tgt) b.lat += clamp(tgt.lat - b.lat, -22 * dt, 22 * dt);
      const p = track.posAt(b.s, b.lat);
      b.x = p.x; b.z = p.z; b.h = p.h;
      let dead = b.life <= 0;
      if (b.owned && !dead) {
        for (const k of race.karts) {
          if (k.id === b.o || k.gone) continue;
          const dx = k.x - b.x, dz = k.z - b.z;
          if (dx * dx + dz * dz < 9) {
            if (k.owned) hitKart(k, 'bolt'); else net('hit', { t: k.id });
            dead = true; net('boltEnd', { id: b.id });
            break;
          }
        }
      }
      if (dead) race.bolts.splice(i, 1);
    }
  }

  function rank() {
    const a = race.karts.filter(k => !k.gone).sort((p, q) => {
      if (p.finished && q.finished) return p.finishTime - q.finishTime;
      if (p.finished !== q.finished) return p.finished ? -1 : 1;
      return q.dist - p.dist;
    });
    a.forEach((k, i) => { k.pos = i + 1; });
    return a;
  }
  race.rank = rank;

  race.step = (dt, inp) => {
    if (race.state === 'count') {
      race.countT -= dt;
      const c = Math.ceil(race.countT);
      if (c !== race.lastCount && c <= 3) { race.lastCount = c; localEv('count', null, c); }
      const k = race.local;
      if (k && inp.launch) k.launchAt = race.countT;
      if (race.countT <= 0) {
        race.state = 'run';
        localEv('count', null, 0);
        if (k && k.launchAt >= 0 && k.launchAt < 0.5) { boost(k, 1.4); localEv('rocket', k); }
        for (const o of race.karts) if (o.owned && o.ai && Math.random() < 0.4) o.boostT = 1;
      }
      return;
    }
    race.time += dt;
    for (const b of race.boxes) if (b.t > 0) b.t -= dt;
    for (const t of race.traps) t.age += dt;
    for (const k of race.karts) {
      if (k.gone) continue;
      if (k.owned) stepOwned(k, k.ai ? aiInput(k, dt) : inp, dt);
      else stepRemote(k, dt);
    }
    stepBolts(dt);
    const prev = race.local ? race.local.pos : 0;
    rank();
    if (race.local && prev && race.local.pos < prev && !race.local.finished) localEv('overtake', race.local);
  };

  // ---- network ----
  race.snapshot = () => {
    const out = [];
    for (const k of race.karts) {
      if (!k.owned) continue;
      const f = (k.drifting ? 1 : 0) | (k.boostT > 0 ? 2 : 0) | (k.spinT > 0 ? 4 : 0) | (k.shield > 0 ? 8 : 0)
        | (k.stormT > 0 ? 32 : 0) | (k.driftDir > 0 ? 64 : 0) | (k.tier << 8);
      out.push([k.id, +k.x.toFixed(2), +k.z.toFixed(2), +k.h.toFixed(3), +k.speed.toFixed(1), f, +k.dist.toFixed(1)]);
    }
    return out;
  };

  race.applyState = arr => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) {
      const k = byId(e[0]);
      if (!k || k.owned) continue;
      if (!k.net) { k.x = e[1]; k.z = e[2]; k.h = e[3]; track.locate(k.x, k.z, -1, loc); k.idx = loc.i; }
      k.net = { x: e[1], z: e[2], h: e[3], sp: e[4] };
      const f = e[5];
      k.drifting = !!(f & 1); k.boostT = (f & 2) ? 0.2 : 0; k.spinT = (f & 4) ? 0.2 : 0;
      k.shield = (f & 8) ? 1 : 0; k.stormT = (f & 32) ? 0.2 : 0; k.driftDir = (f & 64) ? 1 : -1; k.tier = (f >> 8) & 3;
      k.dist = e[6];
    }
  };

  race.applyEvent = (from, type, d) => {
    if (!d) d = {};
    if (type === 'bolt') race.bolts.push({ id: d.id, o: d.o, s: d.s, lat: d.lat, life: 4, owned: false, x: 0, z: 0, h: 0 });
    else if (type === 'boltEnd') { const i = race.bolts.findIndex(b => b.id === d.id); if (i >= 0) race.bolts.splice(i, 1); }
    else if (type === 'trap') race.traps.push({ id: d.id, o: d.o, x: d.x, z: d.z, age: 0 });
    else if (type === 'trapGone') { const i = race.traps.findIndex(t => t.id === d.id); if (i >= 0) race.traps.splice(i, 1); }
    else if (type === 'hit') { const k = byId(d.t); if (k && k.owned) hitKart(k, 'bolt'); }
    else if (type === 'storm') applyStorm(d.o, d.d);
    else if (type === 'finish') {
      const k = byId(d.k);
      if (k && !k.owned && !k.finished) { k.finished = true; k.finishTime = d.t / 1000; }
    } else if (type === 'left') {
      const k = byId(from);
      if (k) { k.gone = true; k.x = 1e5; }
    }
  };

  rank();
  return race;
}
