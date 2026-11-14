// VOLTLINE - P2P networking layer (star topology over PeerJS data channels).
//
// Requires PeerJS 1.5.x loaded as a classic script (global `window.Peer`).
// The host owns the Peer id `voltline-<CODE>`; every client opens two
// DataConnections to it:
//   'ev'  reliable/ordered   - handshake, player list, game events
//   'st'  unreliable         - high-rate state snapshots (falls back to 'ev')
// The host relays whatever a client sends to all other clients.
//
// Wire envelopes (JSON):
//   { k:'i', t, d }      internal (hello / welcome / reject / players / ping) - never reaches onEvent
//   { k:'e', f, t, d }   user event   (f = sender player id, stamped by the host)
//   { k:'s', f, d }      user state   (f = sender player id, stamped by the host)

const ID_PREFIX = 'voltline-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_PLAYERS = 4;
const JOIN_TIMEOUT_MS = 10000;
const HOST_TIMEOUT_MS = 15000;
const HOST_CODE_ATTEMPTS = 10;
const HEARTBEAT_MS = 2000;
const PEER_TIMEOUT_MS = 15000;      // silence after which a remote peer is considered gone
const HANDSHAKE_TIMEOUT_MS = 20000; // host side: connection that never completed hello
const RECONNECT_DELAY_MS = 2000;    // signalling-server reconnect delay
const STATE_BUFFER_LIMIT = 65536;   // skip state packets when a channel is backed up
const ERROR_REPEAT_MS = 10000;

function peerOptions() {
  return {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
        // TURN: STUN alone cannot connect players behind symmetric NATs or
        // strict firewalls (join then ends in a timeout). To support them,
        // add a TURN relay here, e.g.:
        // { urls: 'turn:turn.example.com:3478', username: 'USER', credential: 'PASS' }
      ]
    }
  };
}

function now() {
  return Date.now();
}

function sanitizeName(name) {
  let s = '';
  try {
    s = String(name == null ? '' : name).trim().slice(0, 12).trim();
  } catch (e) {
    s = '';
  }
  return s || 'PILOT';
}

function makeCode() {
  let c = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    c += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return c;
}

function toError(e) {
  if (e instanceof Error) return e;
  let msg = 'Network error.';
  try {
    if (e && e.message) msg = String(e.message);
    else if (e) msg = String(e);
  } catch (x) { /* keep default */ }
  return new Error(msg);
}

function describePeerError(err) {
  const type = err && err.type;
  switch (type) {
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    case 'network': return 'Lost connection to the matchmaking server.';
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return 'Matchmaking server unavailable.';
    case 'ssl-unavailable': return 'Secure connection to the matchmaking server unavailable.';
    case 'unavailable-id': return 'Could not reserve a room code. Try again.';
    case 'peer-unavailable': return 'Room not found.';
    case 'webrtc': return 'WebRTC connection error.';
    case 'disconnected': return 'Disconnected from the matchmaking server.';
    default: break;
  }
  let msg = '';
  try {
    msg = err && err.message ? String(err.message) : '';
  } catch (e) {
    msg = '';
  }
  return msg || 'Network error.';
}

function rejectReasonText(reason) {
  if (reason === 'full') return 'Room is full (max ' + MAX_PLAYERS + ' players).';
  if (reason === 'locked') return 'Race already in progress - room is locked.';
  return 'The host refused the connection.';
}

function sortPlayers(list) {
  list.sort(function (a, b) { return a.slot - b.slot; });
  return list;
}

function copyPlayers(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push({ id: list[i].id, name: list[i].name, slot: list[i].slot });
  }
  return sortPlayers(out);
}

// Validate a player list received over the wire.
function cleanPlayers(raw) {
  const out = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      if (!p || typeof p !== 'object' || typeof p.id !== 'string') continue;
      let slot = Number(p.slot);
      if (!isFinite(slot)) slot = out.length;
      out.push({ id: p.id, name: sanitizeName(p.name), slot: slot });
    }
  }
  return sortPlayers(out);
}

function safeClose(conn) {
  try {
    if (conn) conn.close();
  } catch (e) { /* ignore */ }
}

function safeDestroy(peer) {
  try {
    if (peer && !peer.destroyed) peer.destroy();
  } catch (e) { /* ignore */ }
}

function sendTo(conn, msg) {
  try {
    if (conn && conn.open) {
      conn.send(msg);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

function isBackedUp(conn) {
  try {
    const dc = conn.dataChannel;
    return !!(dc && dc.bufferedAmount > STATE_BUFFER_LIMIT);
  } catch (e) {
    return false;
  }
}

// Send a state packet on 'st' when open, otherwise on 'ev'. Drops the packet
// if the chosen channel is congested (state is disposable by design).
function sendStateVia(st, ev, msg) {
  const conn = (st && st.open) ? st : ev;
  if (!conn || !conn.open) return false;
  if (isBackedUp(conn)) return false;
  return sendTo(conn, msg);
}

// Wrap a callback so that nothing it throws escapes into PeerJS / timers.
function guard(fn) {
  return function () {
    try {
      return fn.apply(null, arguments);
    } catch (e) {
      try {
        if (typeof console !== 'undefined' && console.warn) console.warn('[net]', e);
      } catch (x) { /* ignore */ }
      return undefined;
    }
  };
}

export function createNet(handlers) {
  const h = (handlers && typeof handlers === 'object') ? handlers : {};

  // The current session (one host() or join() call). Every async callback
  // captures its own session object and bails out if it has been torn down.
  let session = null;

  function emit(name, a, b, c) {
    try {
      const fn = h[name];
      if (typeof fn === 'function') fn(a, b, c);
    } catch (e) {
      try {
        if (typeof console !== 'undefined' && console.error) console.error('[net] handler ' + name + ' threw', e);
      } catch (x) { /* ignore */ }
    }
  }

  function emitError(s, message) {
    const t = now();
    if (s && s.lastErr === message && t - s.lastErrAt < ERROR_REPEAT_MS) return;
    if (s) {
      s.lastErr = message;
      s.lastErrAt = t;
    }
    emit('onError', message);
  }

  function newSession(role, name) {
    return {
      role: role,              // 'host' | 'client'
      name: sanitizeName(name),
      peer: null,
      code: '',
      myId: '',
      players: [],
      active: false,
      locked: false,
      dead: false,
      pending: null,           // { resolve, reject } of the host()/join() promise
      timer: null,             // host/join timeout
      hb: null,                // heartbeat interval
      reconnectTimer: null,
      lastTick: 0,
      last: 0,                 // client: last time anything arrived from the host
      lastErr: '',
      lastErrAt: 0,
      clients: new Map(),      // host: peerId -> client record
      ev: null,                // client: reliable connection to host
      st: null                 // client: unreliable connection to host
    };
  }

  // Close everything belonging to session `s`. Rejects a still-pending
  // host()/join() promise with `err`. Never calls handlers.
  function teardown(s, err) {
    if (!s || s.dead) return;
    s.dead = true;
    s.active = false;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (s.hb) { clearInterval(s.hb); s.hb = null; }
    if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
    const pending = s.pending;
    s.pending = null;
    if (session === s) session = null;
    try {
      s.clients.forEach(function (rec) {
        rec.gone = true;
        safeClose(rec.ev);
        safeClose(rec.st);
      });
      s.clients.clear();
    } catch (e) { /* ignore */ }
    safeClose(s.ev);
    safeClose(s.st);
    s.ev = null;
    s.st = null;
    safeDestroy(s.peer);
    s.peer = null;
    if (pending) {
      try {
        pending.reject(err ? toError(err) : new Error('Cancelled.'));
      } catch (e) { /* ignore */ }
    }
  }

  function fail(s, err) {
    teardown(s, err);
  }

  // Tear down an established session and tell the app about it.
  function closeSession(s, reason) {
    if (!s || s.dead) return;
    const wasActive = s.active;
    teardown(s, new Error('Connection closed.'));
    if (wasActive) emit('onClosed', reason);
  }

  function settle(s, value) {
    const pending = s.pending;
    s.pending = null;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (pending) {
      try {
        pending.resolve(value);
      } catch (e) { /* ignore */ }
    }
  }

  // Signalling-server reconnect. Existing data channels survive a signalling
  // drop, but the host needs the server to accept new joiners.
  function scheduleReconnect(s) {
    if (s.dead || s.reconnectTimer) return;
    s.reconnectTimer = setTimeout(guard(function () {
      s.reconnectTimer = null;
      if (s.dead) return;
      const p = s.peer;
      if (p && !p.destroyed && p.disconnected) p.reconnect();
    }), RECONNECT_DELAY_MS);
  }

  function startHeartbeat(s) {
    s.lastTick = now();
    s.last = s.lastTick;
    if (s.hb) clearInterval(s.hb);
    s.hb = setInterval(guard(function () {
      if (s.dead) return;
      const t = now();
      // If our own timer was frozen (background tab / suspended page), do not
      // blame the other side for the silence: restart the clocks.
      const stalled = (t - s.lastTick) > HEARTBEAT_MS * 2.5;
      s.lastTick = t;
      if (s.role === 'host') {
        const recs = Array.from(s.clients.values());
        for (let i = 0; i < recs.length; i++) {
          const rec = recs[i];
          if (rec.gone) continue;
          if (stalled) { rec.last = t; rec.created = t; }
          if (rec.id) {
            sendTo(rec.ev, { k: 'i', t: 'ping' });
            if (t - rec.last > PEER_TIMEOUT_MS) dropClient(s, rec);
          } else if (t - rec.created > HANDSHAKE_TIMEOUT_MS) {
            dropClient(s, rec);
          }
        }
      } else {
        if (stalled) s.last = t;
        sendTo(s.ev, { k: 'i', t: 'ping' });
        if (t - s.last > PEER_TIMEOUT_MS) closeSession(s, 'host-left');
      }
    }), HEARTBEAT_MS);
  }

  // ------------------------------------------------------------------ host

  function freeSlot(s) {
    for (let slot = 1; slot < MAX_PLAYERS; slot++) {
      let used = false;
      for (let i = 0; i < s.players.length; i++) {
        if (s.players[i].slot === slot) { used = true; break; }
      }
      if (!used) return slot;
    }
    return -1;
  }

  // Send on the reliable channel to every joined client except `exceptRec`.
  function hostBroadcast(s, msg, exceptRec) {
    s.clients.forEach(function (rec) {
      if (rec === exceptRec || !rec.id || rec.gone) return;
      sendTo(rec.ev, msg);
    });
  }

  function hostBroadcastState(s, msg, exceptRec) {
    s.clients.forEach(function (rec) {
      if (rec === exceptRec || !rec.id || rec.gone) return;
      sendStateVia(rec.st, rec.ev, msg);
    });
  }

  function dropClient(s, rec) {
    if (rec.gone) return;
    rec.gone = true;
    if (s.clients.get(rec.peerId) === rec) s.clients.delete(rec.peerId);
    safeClose(rec.ev);
    safeClose(rec.st);
    if (!rec.id || s.dead) return;
    const id = rec.id;
    s.players = s.players.filter(function (p) { return p.id !== id; });
    hostBroadcast(s, { k: 'i', t: 'players', d: copyPlayers(s.players) }, null);
    hostBroadcast(s, { k: 'e', f: id, t: 'left', d: {} }, null);
    emit('onPlayers', copyPlayers(s.players));
    emit('onEvent', id, 'left', {});
  }

  function hostOnHello(s, rec, d) {
    if (rec.id || rec.rejected) return;
    let reason = null;
    let slot = -1;
    if (s.locked) {
      reason = 'locked';
    } else {
      slot = freeSlot(s);
      if (slot < 0 || s.players.length >= MAX_PLAYERS) reason = 'full';
    }
    if (reason) {
      rec.rejected = true;
      sendTo(rec.ev, { k: 'i', t: 'reject', d: { reason: reason } });
      // Give the reject message a moment to flush before closing.
      setTimeout(guard(function () { dropClient(s, rec); }), 500);
      return;
    }
    rec.id = 'p' + slot;
    rec.name = sanitizeName(d && typeof d === 'object' ? d.name : '');
    rec.last = now();
    s.players.push({ id: rec.id, name: rec.name, slot: slot });
    sortPlayers(s.players);
    const list = copyPlayers(s.players);
    sendTo(rec.ev, { k: 'i', t: 'welcome', d: { id: rec.id, players: list } });
    hostBroadcast(s, { k: 'i', t: 'players', d: list }, rec);
    emit('onPlayers', copyPlayers(s.players));
  }

  function hostOnData(s, rec, label, msg) {
    if (s.dead || rec.gone || !msg || typeof msg !== 'object') return;
    rec.last = now();
    if (msg.k === 'i') {
      if (label === 'ev' && msg.t === 'hello') hostOnHello(s, rec, msg.d);
      return; // ping and anything unknown: activity only
    }
    if (!rec.id) return; // not through the handshake yet
    if (msg.k === 's') {
      hostBroadcastState(s, { k: 's', f: rec.id, d: msg.d }, rec);
      emit('onState', rec.id, msg.d);
    } else if (msg.k === 'e' && typeof msg.t === 'string') {
      hostBroadcast(s, { k: 'e', f: rec.id, t: msg.t, d: msg.d }, rec);
      emit('onEvent', rec.id, msg.t, msg.d);
    }
  }

  function hostOnConnection(s, conn) {
    if (!conn) return;
    if (s.dead || !s.active) { safeClose(conn); return; }
    const label = conn.label;
    const peerId = conn.peer;
    if ((label !== 'ev' && label !== 'st') || typeof peerId !== 'string') {
      safeClose(conn);
      return;
    }
    let rec = s.clients.get(peerId);
    if (!rec) {
      rec = {
        peerId: peerId, id: null, name: '', ev: null, st: null,
        last: now(), created: now(), rejected: false, gone: false
      };
      s.clients.set(peerId, rec);
    }
    const old = rec[label];
    rec[label] = conn;
    if (old && old !== conn) safeClose(old);

    conn.on('data', guard(function (msg) { hostOnData(s, rec, label, msg); }));
    conn.on('close', guard(function () {
      if (rec[label] !== conn) return; // replaced by a newer connection
      if (label === 'ev') {
        dropClient(s, rec);
      } else {
        rec.st = null;
        if (!rec.ev && !rec.id) dropClient(s, rec);
      }
    }));
    conn.on('error', guard(function () { /* close / heartbeat handle the fallout */ }));
  }

  function openHostPeer(s, attempt) {
    const code = makeCode();
    let peer;
    try {
      peer = new window.Peer(ID_PREFIX + code, peerOptions());
    } catch (e) {
      fail(s, toError(e));
      return;
    }
    s.peer = peer;
    s.code = code;

    peer.on('open', guard(function () {
      if (s.dead || s.peer !== peer) return;
      if (!s.pending) return; // re-open after a signalling reconnect
      s.myId = 'p0';
      s.players = [{ id: 'p0', name: s.name, slot: 0 }];
      s.active = true;
      startHeartbeat(s);
      settle(s, code);
      emit('onPlayers', copyPlayers(s.players));
    }));

    peer.on('connection', guard(function (conn) {
      if (s.peer !== peer) { safeClose(conn); return; }
      hostOnConnection(s, conn);
    }));

    peer.on('error', guard(function (err) {
      if (s.dead || s.peer !== peer) return;
      const type = err && err.type;
      if (s.pending) {
        if (type === 'unavailable-id' && attempt + 1 < HOST_CODE_ATTEMPTS) {
          s.peer = null;
          safeDestroy(peer);
          if (!s.dead) openHostPeer(s, attempt + 1);
          return;
        }
        fail(s, new Error(describePeerError(err)));
        return;
      }
      emitError(s, describePeerError(err));
      scheduleReconnect(s);
    }));

    peer.on('disconnected', guard(function () {
      if (s.dead || s.peer !== peer || s.pending) return;
      scheduleReconnect(s);
    }));

    peer.on('close', guard(function () {
      if (s.dead || s.peer !== peer) return;
      if (s.pending) fail(s, new Error('Connection to the matchmaking server closed.'));
      else closeSession(s, 'connection-lost');
    }));
  }

  function host(name) {
    return new Promise(function (resolve, reject) {
      try {
        teardown(session, new Error('Cancelled.'));
        if (typeof window === 'undefined' || typeof window.Peer !== 'function') {
          reject(new Error('Networking library (PeerJS) failed to load.'));
          return;
        }
        const s = newSession('host', name);
        session = s;
        s.pending = { resolve: resolve, reject: reject };
        s.timer = setTimeout(guard(function () {
          fail(s, new Error('Timed out contacting the matchmaking server.'));
        }), HOST_TIMEOUT_MS);
        openHostPeer(s, 0);
      } catch (e) {
        const s2 = session;
        if (s2 && s2.pending && s2.pending.reject === reject) teardown(s2, toError(e));
        else reject(toError(e));
      }
    });
  }

  // ---------------------------------------------------------------- client

  function clientOnData(s, msg) {
    if (s.dead || !msg || typeof msg !== 'object') return;
    s.last = now();
    if (msg.k === 'i') {
      const d = (msg.d && typeof msg.d === 'object') ? msg.d : {};
      if (msg.t === 'welcome') {
        if (!s.pending) return;
        if (typeof d.id !== 'string' || !d.id) {
          fail(s, new Error('Bad response from the host.'));
          return;
        }
        s.myId = d.id;
        s.players = cleanPlayers(d.players);
        s.active = true;
        startHeartbeat(s);
        settle(s, undefined);
        emit('onPlayers', copyPlayers(s.players));
      } else if (msg.t === 'reject') {
        if (s.pending) fail(s, new Error(rejectReasonText(d.reason)));
      } else if (msg.t === 'players') {
        if (!s.active) return;
        s.players = cleanPlayers(msg.d);
        emit('onPlayers', copyPlayers(s.players));
      }
      return; // ping and anything unknown: activity only
    }
    if (!s.active) return;
    if (msg.k === 's') {
      if (typeof msg.f === 'string') emit('onState', msg.f, msg.d);
    } else if (msg.k === 'e') {
      if (typeof msg.f === 'string' && typeof msg.t === 'string') emit('onEvent', msg.f, msg.t, msg.d);
    }
  }

  function clientConnect(s) {
    const peer = s.peer;
    const hostId = ID_PREFIX + s.code;
    const ev = peer.connect(hostId, { label: 'ev', reliable: true, serialization: 'json' });
    if (!ev) {
      fail(s, new Error('Could not open a connection to room ' + s.code + '.'));
      return;
    }
    s.ev = ev;
    ev.on('open', guard(function () {
      if (s.dead || s.ev !== ev) return;
      sendTo(ev, { k: 'i', t: 'hello', d: { name: s.name } });
    }));
    ev.on('data', guard(function (msg) { clientOnData(s, msg); }));
    ev.on('close', guard(function () {
      if (s.dead || s.ev !== ev) return;
      if (s.pending) fail(s, new Error('Connection to room ' + s.code + ' was closed.'));
      else closeSession(s, 'host-left');
    }));
    ev.on('error', guard(function (err) {
      if (s.dead || s.pending) return; // join timeout / peer error covers the pending case
      emitError(s, describePeerError(err));
    }));

    let st = null;
    try {
      st = peer.connect(hostId, { label: 'st', reliable: false, serialization: 'json' });
    } catch (e) {
      st = null;
    }
    s.st = st || null;
    if (st) {
      st.on('data', guard(function (msg) { clientOnData(s, msg); }));
      st.on('close', guard(function () { if (s.st === st) s.st = null; }));
      st.on('error', guard(function () { /* state falls back to 'ev' */ }));
    }
  }

  function join(code, name) {
    return new Promise(function (resolve, reject) {
      try {
        teardown(session, new Error('Cancelled.'));
        let c = '';
        try {
          c = String(code == null ? '' : code).trim().toUpperCase();
        } catch (e) {
          c = '';
        }
        if (!/^[A-Z0-9]{4}$/.test(c)) {
          reject(new Error('Enter a ' + CODE_LENGTH + '-character room code.'));
          return;
        }
        if (typeof window === 'undefined' || typeof window.Peer !== 'function') {
          reject(new Error('Networking library (PeerJS) failed to load.'));
          return;
        }
        const s = newSession('client', name);
        s.code = c;
        session = s;
        s.pending = { resolve: resolve, reject: reject };
        s.timer = setTimeout(guard(function () {
          fail(s, new Error('Timed out connecting to room ' + c + '. Check the code and your network.'));
        }), JOIN_TIMEOUT_MS);

        const peer = new window.Peer(peerOptions()); // random id assigned by the PeerServer
        s.peer = peer;

        peer.on('open', guard(function () {
          if (s.dead || s.peer !== peer) return;
          if (s.ev) return; // re-open after a signalling reconnect
          clientConnect(s);
        }));

        peer.on('error', guard(function (err) {
          if (s.dead || s.peer !== peer) return;
          const type = err && err.type;
          if (s.pending) {
            fail(s, new Error(type === 'peer-unavailable'
              ? 'Room ' + c + ' not found.'
              : describePeerError(err)));
            return;
          }
          if (type === 'peer-unavailable') return;
          emitError(s, describePeerError(err));
          scheduleReconnect(s);
        }));

        peer.on('disconnected', guard(function () {
          if (s.dead || s.peer !== peer || s.pending) return;
          scheduleReconnect(s);
        }));

        peer.on('close', guard(function () {
          if (s.dead || s.peer !== peer) return;
          if (s.pending) fail(s, new Error('Connection to the matchmaking server closed.'));
          else closeSession(s, 'connection-lost');
        }));
      } catch (e) {
        const s2 = session;
        if (s2 && s2.pending && s2.pending.reject === reject) teardown(s2, toError(e));
        else reject(toError(e));
      }
    });
  }

  // ---------------------------------------------------------------- common

  function leave() {
    try {
      teardown(session, new Error('Cancelled.'));
    } catch (e) { /* ignore */ }
    session = null;
  }

  function setLocked(flag) {
    const s = session;
    if (s && !s.dead && s.role === 'host') s.locked = !!flag;
  }

  function sendState(obj) {
    try {
      const s = session;
      if (!s || s.dead || !s.active) return;
      if (s.role === 'host') {
        hostBroadcastState(s, { k: 's', f: s.myId, d: obj }, null);
      } else {
        sendStateVia(s.st, s.ev, { k: 's', d: obj });
      }
    } catch (e) { /* never throw to callers */ }
  }

  function sendEvent(type, data) {
    try {
      const s = session;
      if (!s || s.dead || !s.active) return;
      const t = String(type);
      if (s.role === 'host') {
        hostBroadcast(s, { k: 'e', f: s.myId, t: t, d: data }, null);
      } else {
        sendTo(s.ev, { k: 'e', t: t, d: data });
      }
    } catch (e) { /* never throw to callers */ }
  }

  // Free the room code / tell the others immediately when the page goes away.
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', guard(function (e) {
        const s = session;
        if (!s) return;
        if (e && e.persisted) {
          // The page may come back from the back/forward cache with a dead
          // session: let the app know so its UI is consistent when restored.
          const wasActive = s.active;
          teardown(s, new Error('Page was closed.'));
          if (wasActive) emit('onClosed', 'page-hidden');
        } else {
          teardown(s, new Error('Page was closed.'));
        }
      }));
    }
  } catch (e) { /* ignore */ }

  return {
    host: host,
    join: join,
    leave: leave,
    setLocked: setLocked,
    sendState: sendState,
    sendEvent: sendEvent,
    get active() { return !!(session && session.active && !session.dead); },
    get isHost() { return !!(session && session.active && !session.dead && session.role === 'host'); },
    get myId() { return (session && session.active) ? session.myId : ''; },
    get players() { return (session && session.active) ? copyPlayers(session.players) : []; },
    get code() { return (session && session.active) ? session.code : ''; }
  };
}
