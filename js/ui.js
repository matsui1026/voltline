// VOLTLINE — UI layer (menus, lobby, HUD, touch controls)
// Pure DOM, no dependencies. See createUI() for the public API.

const LS_SETTINGS = 'voltline.settings';
const LS_NAME = 'voltline.name';
const SCREENS = ['title', 'join', 'lobby', 'hud', 'results', 'loading'];
const ITEMS = ['surge', 'bolt', 'trap', 'aegis', 'overdrive', 'storm'];

const C = '#22e6ff';
const M = '#ff2bd6';
const A = '#ffc531';

function svg(cls, body) {
  return '<svg class="' + cls + '" viewBox="0 0 48 48" fill="none" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' + body + '</svg>';
}

// Original item glyphs
const ITEM_SVG =
  // surge: stacked thrust chevrons
  svg('ic-surge',
    '<path d="M9 25 L24 9 L39 25" stroke="' + C + '"/>' +
    '<path d="M9 39 L24 23 L39 39" stroke="' + C + '" opacity=".55"/>' +
    '<path d="M24 23 V41" stroke="#fff" stroke-width="2"/>') +
  // bolt: charged shard
  svg('ic-bolt',
    '<path d="M29 4 L11 27 H22 L18 44 L37 20 H26 Z" fill="' + A + '" stroke="#fff" stroke-width="1.5"/>') +
  // trap: spiked floor mine
  svg('ic-trap',
    '<path d="M24 9 L39 24 L24 39 L9 24 Z" stroke="' + M + '"/>' +
    '<path d="M24 3 V9 M24 39 V45 M3 24 H9 M39 24 H45" stroke="' + M + '"/>' +
    '<rect x="20" y="20" width="8" height="8" fill="#fff" stroke="none" transform="rotate(45 24 24)"/>') +
  // aegis: nested hex barrier
  svg('ic-aegis',
    '<path d="M24 4 L41 14 V34 L24 44 L7 34 V14 Z" stroke="' + C + '"/>' +
    '<path d="M24 14 L32 19 V29 L24 34 L16 29 V19 Z" fill="' + C + '" stroke="none" opacity=".45"/>' +
    '<path d="M24 14 V34" stroke="#fff" stroke-width="2"/>') +
  // overdrive: triple forward rake in a ring segment
  svg('ic-overdrive',
    '<path d="M7 13 L18 24 L7 35" stroke="' + A + '" opacity=".5"/>' +
    '<path d="M18 13 L29 24 L18 35" stroke="' + A + '"/>' +
    '<path d="M29 13 L40 24 L29 35" stroke="' + M + '"/>' +
    '<path d="M6 42 H42" stroke="#fff" stroke-width="2"/>') +
  // storm: core with falling discharge lines
  svg('ic-storm',
    '<path d="M10 16 L16 6 H32 L38 16 Z" stroke="' + M + '"/>' +
    '<path d="M14 22 L18 30 L13 33 L16 43" stroke="' + C + '" stroke-width="3"/>' +
    '<path d="M24 22 L28 30 L23 33 L26 43" stroke="#fff" stroke-width="3"/>' +
    '<path d="M34 22 L38 30 L33 33 L36 43" stroke="' + C + '" stroke-width="3"/>');

const CHEV_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="miter" aria-hidden="true"><path d="M15 4 L7 12 L15 20"/></svg>';
const CHEV_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="miter" aria-hidden="true"><path d="M9 4 L17 12 L9 20"/></svg>';
const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="miter" aria-hidden="true"><path d="M4 7 H14 M18 7 H20 M4 17 H6 M10 17 H20"/><rect x="14" y="4.5" width="4" height="5"/><rect x="6" y="14.5" width="4" height="5"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" fill="#e9f6ff" aria-hidden="true"><path d="M6 3 H10 L9 21 H5 Z"/><path d="M15 3 H19 L18 21 H14 Z"/></svg>';

function detectTouch() {
  try {
    const mq = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
    if (mq('(pointer: coarse)')) return true;
    const fine = mq('(pointer: fine)');
    if ((navigator.maxTouchPoints || 0) > 0 && !fine) return true;
    return ('ontouchstart' in window) && !fine;
  } catch (e) {
    return false;
  }
}

function clampNum(v, def, lo, hi) {
  const n = Number(v);
  if (typeof v === 'boolean' || v === null || v === undefined || !isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

function loadSettings(isTouch) {
  const d = {
    control: isTouch ? 'tilt' : 'touch',
    autoAccel: true,
    sensitivity: 1,
    master: 0.8,
    music: 0.6,
    sfx: 0.8,
    quality: 'high'
  };
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        if (s.control === 'tilt' || s.control === 'touch') d.control = s.control;
        if (typeof s.autoAccel === 'boolean') d.autoAccel = s.autoAccel;
        d.sensitivity = clampNum(s.sensitivity, d.sensitivity, 0.5, 1.5);
        d.master = clampNum(s.master, d.master, 0, 1);
        d.music = clampNum(s.music, d.music, 0, 1);
        d.sfx = clampNum(s.sfx, d.sfx, 0, 1);
        if (s.quality === 'low' || s.quality === 'high') d.quality = s.quality;
      }
    }
  } catch (e) { /* ignore */ }
  return d;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n); }

function formatTime(ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return '-:--.---';
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return m + ':' + pad2(s) + '.' + pad3(t % 1000);
}

function ordinal(n) {
  const h = n % 100;
  if (h >= 11 && h <= 13) return 'th';
  const d = n % 10;
  return d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th';
}

export function createUI(root, handlers) {
  handlers = handlers || {};
  const isTouch = detectTouch();
  root.classList.add(isTouch ? 'is-touch' : 'is-desktop');

  const settings = loadSettings(isTouch);
  const touch = { left: false, right: false, accel: false, brake: false, drift: false };

  function call(name) {
    const f = handlers[name];
    if (typeof f !== 'function') return undefined;
    const args = Array.prototype.slice.call(arguments, 1);
    try {
      return f.apply(handlers, args);
    } catch (e) {
      console.error('[ui] handler ' + name + ' failed', e);
      return undefined;
    }
  }
  function snd(name) { call('onUiSound', name); }

  function mk(cls, html) {
    const d = document.createElement('div');
    d.className = cls;
    if (html) d.innerHTML = html;
    root.appendChild(d);
    return d;
  }
  function textNode(el, init) {
    const t = document.createTextNode(init);
    el.textContent = '';
    el.appendChild(t);
    return t;
  }
  function press(el, fn, sound) {
    el.addEventListener('click', function (e) {
      if (el.disabled) return;
      if (sound !== null) snd(sound || 'ui_select');
      fn(e);
    });
  }

  // =====================================================================
  // DOM
  // =====================================================================
  const scr = {};

  scr.title = mk('screen menu s-title',
    '<div class="t-left">' +
      '<div class="logo"><span class="lg-a">VOLT</span><span class="lg-b">LINE</span></div>' +
      '<svg class="logo-line" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true"><path d="M0 14 H150 L165 4 L185 20 L200 8 L212 14 H400"/></svg>' +
      '<div class="tagline">NEON HOVER CIRCUIT <span class="jp">ネオン・ホバーレース</span></div>' +
      '<ul class="howto">' +
        '<li><b>STEER</b><span>Tilt the phone or use the pads / 本体を傾ける・パッドで操舵</span></li>' +
        '<li><b>DRIFT</b><span>Hold in corners to charge, release to boost / 溜めて離すと加速</span></li>' +
        '<li><b>ITEM</b><span>Fly through pods, then tap ITEM / ポッドで入手して使う</span></li>' +
        '<li><b>SLIPSTREAM</b><span>Tail a rival to gain speed / 後ろに付くと速くなる</span></li>' +
      '</ul>' +
    '</div>' +
    '<div class="t-right cut">' +
      '<div class="row">' +
        '<label class="field"><span class="f-lab">PILOT <span class="jp">名前</span></span>' +
          '<input class="in-name" type="text" maxlength="12" placeholder="PILOT" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done"></label>' +
        '<button type="button" class="btn cut sq k-d b-set" aria-label="Settings" title="SETTINGS / 設定">' + GEAR + '<small>SET</small></button>' +
      '</div>' +
      '<div class="row">' +
        '<button type="button" class="btn cut sq k-a b-prev" aria-label="Previous track">' + CHEV_L + '</button>' +
        '<div class="trk"><span class="f-lab">TRACK <span class="jp">コース</span> <span class="trk-n"></span></span><span class="trk-name">-</span></div>' +
        '<button type="button" class="btn cut sq k-a b-next" aria-label="Next track">' + CHEV_R + '</button>' +
      '</div>' +
      '<button type="button" class="btn cut big b-solo" data-autofocus><b>SOLO RACE</b><small>ひとりで走る (vs AI)</small></button>' +
      '<div class="row">' +
        '<button type="button" class="btn cut k-m b-host"><b>HOST ROOM</b><small>部屋を作る</small></button>' +
        '<button type="button" class="btn cut k-a b-join"><b>JOIN ROOM</b><small>コードで参加</small></button>' +
      '</div>' +
    '</div>');

  scr.join = mk('screen menu s-join',
    '<div class="box cut">' +
      '<h2 class="box-h">JOIN ROOM <span class="jp">ルームに参加</span></h2>' +
      '<input class="in-code" type="text" maxlength="4" placeholder="----" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" aria-label="Room code">' +
      '<div class="note">Enter the 4-character room code / 4文字のルームコードを入力</div>' +
      '<div class="row">' +
        '<button type="button" class="btn cut k-d b-back"><b>BACK</b><small>戻る</small></button>' +
        '<button type="button" class="btn cut b-connect" disabled><b>CONNECT</b><small>接続</small></button>' +
      '</div>' +
    '</div>');

  scr.lobby = mk('screen menu s-lobby',
    '<div class="lobby cut">' +
      '<div class="lb-code">' +
        '<span class="f-lab">ROOM CODE <span class="jp">ルームコード</span></span>' +
        '<div class="code-big">----</div>' +
        '<button type="button" class="btn cut k-a b-share"><b>COPY / SHARE</b><small>コードを共有</small></button>' +
        '<div class="lb-track">TRACK <b class="lb-trk">-</b></div>' +
      '</div>' +
      '<div class="slots"></div>' +
      '<div class="lb-foot">' +
        '<div class="note lb-note"></div>' +
        '<button type="button" class="btn cut k-d b-leave"><b>LEAVE</b><small>退出</small></button>' +
        '<button type="button" class="btn cut b-start" data-autofocus><b>START</b><small>レース開始</small></button>' +
      '</div>' +
    '</div>');

  scr.hud = mk('screen s-hud',
    '<div class="hud-pos cut"><span class="p-num">1</span><span class="p-ord">st</span><span class="p-tot">/1</span>' +
      '<span class="f-lab">POSITION <span class="jp">順位</span></span></div>' +
    '<div class="hud-lap cut"><div class="l-lap">LAP<b class="l-val">1/3</b></div><div class="l-time">0:00.000</div></div>' +
    '<div class="hud-tr">' +
      '<div class="pause-btn cut" role="button" aria-label="Pause">' + PAUSE + '</div>' +
      '<div class="mm-wrap cut"><canvas class="mm" width="128" height="128"></canvas></div>' +
    '</div>' +
    '<div class="wrongway">WRONG WAY<small>逆走しています</small></div>' +
    '<div class="gauge" data-tier="0">' +
      '<div class="chips"><span class="chip slip">SLIPSTREAM</span><span class="chip aegis">AEGIS</span></div>' +
      '<svg class="g-svg" viewBox="0 0 220 96" aria-hidden="true">' +
        '<path class="g-plate" d="M6 92 L40 8 L180 8 L214 92 Z"/>' +
        '<path class="g-bg" d="M6 92 L40 8 L180 8 L214 92" pathLength="100"/>' +
        '<path class="g-fill" d="M6 92 L40 8 L180 8 L214 92" pathLength="100"/>' +
      '</svg>' +
      '<div class="g-tier">DRIFT CHARGE</div>' +
      '<div class="g-read"><span class="g-num">0</span><span class="g-unit">km/h</span></div>' +
    '</div>' +
    '<div class="item-slot cut" role="button" aria-label="Use item" data-item="">' + ITEM_SVG +
      '<span class="i-hint">ITEM<small>アイテム</small></span><span class="i-name"></span></div>' +
    '<div class="tc steer"><div class="pad pad-l cut">' + CHEV_L + '</div><div class="pad pad-r cut">' + CHEV_R + '</div></div>' +
    '<div class="tc cut b-drift"><b>DRIFT</b><small>ドリフト</small></div>' +
    '<div class="tc cut b-brake"><b>BRAKE</b><small>ブレーキ</small></div>' +
    '<div class="tc cut b-accel"><b>ACCEL</b><small>アクセル</small></div>' +
    '<div class="keyhint">' +
      '<div><kbd>&larr; &rarr;</kbd><kbd>A D</kbd> steer <span class="jp">操舵</span></div>' +
      '<div><kbd>SPACE</kbd> drift <span class="jp">ドリフト</span></div>' +
      '<div><kbd>SHIFT</kbd><kbd>E</kbd> item <span class="jp">アイテム</span></div>' +
      '<div><kbd>ESC</kbd> pause <span class="jp">ポーズ</span></div>' +
    '</div>');

  scr.results = mk('screen menu s-results',
    '<div class="results cut">' +
      '<h2 class="box-h">RESULTS <span class="jp">リザルト</span></h2>' +
      '<ol class="r-list"></ol>' +
      '<div class="note r-note"></div>' +
      '<div class="row">' +
        '<button type="button" class="btn cut k-d b-menu"><b>MENU</b><small>メニューへ</small></button>' +
        '<button type="button" class="btn cut b-rematch" data-autofocus><b>REMATCH</b><small>もう一度</small></button>' +
      '</div>' +
    '</div>');

  scr.loading = mk('screen menu s-loading',
    '<div class="spin"></div><div class="load-t">LINKING</div><div class="jp">接続中…</div>');

  const fx = mk('fx',
    '<div class="flash"></div><div class="banner"></div><div class="count"></div><div class="toast"></div>');

  const pauseEl = mk('overlay o-pause',
    '<div class="box cut pause-box">' +
      '<h2 class="box-h">PAUSED <span class="jp">一時停止</span></h2>' +
      '<button type="button" class="btn cut b-resume" data-autofocus><b>RESUME</b><small>再開</small></button>' +
      '<button type="button" class="btn cut k-a b-recal"><b>RECALIBRATE TILT</b><small>傾きの基準をリセット</small></button>' +
      '<button type="button" class="btn cut k-m b-quit"><b>QUIT</b><small>レースをやめる</small></button>' +
    '</div>');

  const setEl = mk('overlay o-settings',
    '<div class="box cut set-box">' +
      '<h2 class="box-h">SETTINGS <span class="jp">設定</span></h2>' +
      '<div class="set-grid">' +
        '<div class="set-row"><span class="f-lab">CONTROL <span class="jp">操作方法</span></span>' +
          '<div class="seg" data-key="control">' +
            '<button type="button" class="btn cut" data-val="tilt"><b>TILT</b><small>傾けて操舵</small></button>' +
            '<button type="button" class="btn cut" data-val="touch"><b>TOUCH</b><small>パッドで操舵</small></button>' +
          '</div></div>' +
        '<div class="set-row"><span class="f-lab">AUTO ACCEL <span class="jp">自動アクセル</span></span>' +
          '<div class="seg" data-key="autoAccel">' +
            '<button type="button" class="btn cut" data-val="on"><b>ON</b></button>' +
            '<button type="button" class="btn cut" data-val="off"><b>OFF</b></button>' +
          '</div></div>' +
        '<div class="set-row"><span class="f-lab"><span>SENSITIVITY <span class="jp">感度</span></span><span class="val" data-for="sensitivity"></span></span>' +
          '<input type="range" data-key="sensitivity" min="0.5" max="1.5" step="0.05" aria-label="Sensitivity"></div>' +
        '<div class="set-row"><span class="f-lab">QUALITY <span class="jp">画質</span></span>' +
          '<div class="seg" data-key="quality">' +
            '<button type="button" class="btn cut" data-val="low"><b>LOW</b><small>軽い</small></button>' +
            '<button type="button" class="btn cut" data-val="high"><b>HIGH</b><small>きれい</small></button>' +
          '</div></div>' +
        '<div class="set-row"><span class="f-lab"><span>MASTER <span class="jp">全体音量</span></span><span class="val" data-for="master"></span></span>' +
          '<input type="range" data-key="master" min="0" max="1" step="0.05" aria-label="Master volume"></div>' +
        '<div class="set-row"><span class="f-lab"><span>MUSIC <span class="jp">音楽</span></span><span class="val" data-for="music"></span></span>' +
          '<input type="range" data-key="music" min="0" max="1" step="0.05" aria-label="Music volume"></div>' +
        '<div class="set-row"><span class="f-lab"><span>SFX <span class="jp">効果音</span></span><span class="val" data-for="sfx"></span></span>' +
          '<input type="range" data-key="sfx" min="0" max="1" step="0.05" aria-label="SFX volume"></div>' +
        '<div class="set-row"><span class="f-lab">&nbsp;</span>' +
          '<button type="button" class="btn cut b-close" data-autofocus><b>CLOSE</b><small>閉じる</small></button></div>' +
      '</div>' +
    '</div>');

  function $(scope, sel) { return scope.querySelector(sel); }

  // =====================================================================
  // State
  // =====================================================================
  let current = '';
  let paused = false;
  let settingsOpen = false;
  let trackNames = [];
  let trackIndex = 0;
  let lobbyCode = '';
  let controlMode = '';
  let controlAuto = null;

  // =====================================================================
  // Screen switching
  // =====================================================================
  function focusDefault(scope) {
    if (isTouch) return;
    const t = scope.querySelector('[data-autofocus]:not([disabled])');
    if (t && t.offsetParent !== null) {
      try { t.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  function blurActive() {
    const a = document.activeElement;
    if (a && a !== document.body && root.contains(a)) {
      try { a.blur(); } catch (e) { /* ignore */ }
    }
  }

  function show(screen) {
    if (SCREENS.indexOf(screen) < 0) return;
    if (screen === current) return;
    blurActive();
    for (let i = 0; i < SCREENS.length; i++) {
      const n = SCREENS[i];
      scr[n].classList.toggle('active', n === screen);
    }
    if (current === 'hud' || screen === 'hud') resetTouch();
    if (screen !== 'hud' && paused) setPaused(false);
    current = screen;
    if (screen === 'join') {
      if (!isTouch) { try { codeIn.focus(); } catch (e) { /* ignore */ } }
    } else if (screen !== 'hud') {
      focusDefault(scr[screen]);
    }
  }

  // =====================================================================
  // Title
  // =====================================================================
  const nameIn = $(scr.title, '.in-name');
  const trkName = $(scr.title, '.trk-name');
  const trkNum = $(scr.title, '.trk-n');
  const btnPrev = $(scr.title, '.b-prev');
  const btnNext = $(scr.title, '.b-next');

  try {
    const saved = localStorage.getItem(LS_NAME);
    if (saved) nameIn.value = String(saved).slice(0, 12);
  } catch (e) { /* ignore */ }

  function saveName() {
    try { localStorage.setItem(LS_NAME, nameIn.value.trim().slice(0, 12)); } catch (e) { /* ignore */ }
  }
  nameIn.addEventListener('input', saveName);
  nameIn.addEventListener('change', saveName);

  function guardKeys(input, onEnter) {
    // keep typing from leaking into game key handlers
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        onEnter();
      }
    });
    input.addEventListener('keyup', function (e) { e.stopPropagation(); });
    input.addEventListener('keypress', function (e) { e.stopPropagation(); });
  }
  guardKeys(nameIn, function () { nameIn.blur(); });

  function getName() {
    const v = nameIn.value.replace(/\s+/g, ' ').trim().slice(0, 12);
    return v || 'PILOT';
  }

  function renderTrack() {
    const n = trackNames.length;
    trkName.textContent = n ? String(trackNames[trackIndex]) : '-';
    trkNum.textContent = n ? (trackIndex + 1) + '/' + n : '';
    btnPrev.disabled = n < 2;
    btnNext.disabled = n < 2;
  }
  function setTracks(names, index) {
    trackNames = Array.isArray(names) ? names.slice() : [];
    const n = trackNames.length;
    let i = Math.floor(Number(index) || 0);
    if (n) i = ((i % n) + n) % n; else i = 0;
    trackIndex = i;
    renderTrack();
  }
  function stepTrack(d) {
    const n = trackNames.length;
    if (n < 2) return;
    trackIndex = (trackIndex + d + n) % n;
    renderTrack();
    call('onTrack', trackIndex);
  }
  press(btnPrev, function () { stepTrack(-1); }, 'ui_move');
  press(btnNext, function () { stepTrack(1); }, 'ui_move');
  renderTrack();

  press($(scr.title, '.b-solo'), function () { saveName(); call('onSolo'); });
  press($(scr.title, '.b-host'), function () { saveName(); call('onHost'); });
  press($(scr.title, '.b-join'), function () { saveName(); show('join'); });
  press($(scr.title, '.b-set'), function () { openSettings(true); });

  // =====================================================================
  // Join
  // =====================================================================
  const codeIn = $(scr.join, '.in-code');
  const btnConnect = $(scr.join, '.b-connect');

  function cleanCode() {
    const v = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (v !== codeIn.value) codeIn.value = v;
    btnConnect.disabled = v.length !== 4;
    return v;
  }
  function doConnect() {
    const v = cleanCode();
    if (v.length !== 4) return;
    codeIn.blur();
    snd('ui_select');
    call('onJoin', v);
  }
  codeIn.addEventListener('input', cleanCode);
  guardKeys(codeIn, doConnect);
  press(btnConnect, doConnect, null);
  press($(scr.join, '.b-back'), function () { show('title'); }, 'ui_back');

  // =====================================================================
  // Lobby
  // =====================================================================
  const codeBig = $(scr.lobby, '.code-big');
  const slotsEl = $(scr.lobby, '.slots');
  const lbTrack = $(scr.lobby, '.lb-trk');
  const lbNote = $(scr.lobby, '.lb-note');
  const btnStart = $(scr.lobby, '.b-start');

  function setLobby(data) {
    data = data || {};
    const players = Array.isArray(data.players) ? data.players : [];
    lobbyCode = data.code ? String(data.code) : '';
    codeBig.textContent = lobbyCode || '----';
    lbTrack.textContent = data.trackName ? String(data.trackName) : '-';

    const bySlot = [null, null, null, null];
    const spare = [];
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p) continue;
      const s = p.slot;
      if (typeof s === 'number' && s >= 0 && s < 4 && s === Math.floor(s) && !bySlot[s]) bySlot[s] = p;
      else spare.push(p);
    }
    for (let i = 0; i < 4 && spare.length; i++) {
      if (!bySlot[i]) bySlot[i] = spare.shift();
    }

    slotsEl.textContent = '';
    for (let i = 0; i < 4; i++) {
      const p = bySlot[i];
      const row = document.createElement('div');
      row.className = 'slot' + (p ? (p.isYou ? ' you' : '') : ' empty');
      const no = document.createElement('span');
      no.className = 's-no';
      no.textContent = 'P' + (i + 1);
      const nm = document.createElement('span');
      nm.className = 's-name';
      nm.textContent = p ? String(p.name || 'PILOT') : 'OPEN / AI 空き';
      row.appendChild(no);
      row.appendChild(nm);
      if (p && p.isHost) {
        const t = document.createElement('span');
        t.className = 'tag host';
        t.textContent = 'HOST';
        row.appendChild(t);
      }
      if (p && p.isYou) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = 'YOU';
        row.appendChild(t);
      }
      slotsEl.appendChild(row);
    }

    const isHost = !!data.isHost;
    btnStart.style.display = isHost ? '' : 'none';
    btnStart.disabled = players.length < 1;

    lbNote.textContent = '';
    if (data.status) {
      const st = document.createElement('span');
      st.className = 'lb-status';
      st.textContent = String(data.status);
      lbNote.appendChild(st);
    }
    const info = document.createElement('span');
    if (isHost) {
      info.textContent = 'AI fills empty slots / 空き枠はAIが参加します';
    } else {
      info.className = 'lb-wait';
      info.textContent = 'WAITING FOR HOST… ホストの開始を待っています';
    }
    lbNote.appendChild(info);
  }

  function legacyCopy(code) {
    try {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? 'CODE COPIED' : 'CODE ' + code, ok ? 'good' : 'info');
    } catch (e) {
      toast('CODE ' + code, 'info');
    }
  }
  function copyCode(code) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(
          function () { toast('CODE COPIED', 'good'); },
          function () { legacyCopy(code); }
        );
        return;
      }
    } catch (e) { /* fall through */ }
    legacyCopy(code);
  }
  function shareCode() {
    const code = lobbyCode;
    if (!code) return;
    try {
      if (isTouch && typeof navigator.share === 'function') {
        const p = navigator.share({ title: 'VOLTLINE', text: 'VOLTLINE room code: ' + code });
        if (p && typeof p.then === 'function') {
          p.then(function () { /* shared */ }, function (err) {
            if (!err || err.name !== 'AbortError') copyCode(code);
          });
        }
        return;
      }
    } catch (e) { /* fall through */ }
    copyCode(code);
  }

  press($(scr.lobby, '.b-share'), shareCode);
  press(btnStart, function () { call('onStart'); });
  press($(scr.lobby, '.b-leave'), function () { call('onLeave'); }, 'ui_back');

  // =====================================================================
  // Results
  // =====================================================================
  const rList = $(scr.results, '.r-list');
  const rNote = $(scr.results, '.r-note');
  const btnRematch = $(scr.results, '.b-rematch');
  const btnMenu = $(scr.results, '.b-menu');

  function showResults(data) {
    data = data || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    rList.textContent = '';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const li = document.createElement('li');
      li.className = 'r-row' + (r.isYou ? ' you' : '');
      li.style.animationDelay = (i * 0.06) + 's';
      const pos = document.createElement('span');
      pos.className = 'r-pos';
      pos.textContent = String(r.pos !== undefined && r.pos !== null ? r.pos : i + 1);
      const col = document.createElement('i');
      col.className = 'r-col';
      if (r.color) col.style.background = String(r.color);
      const nm = document.createElement('span');
      nm.className = 'r-name';
      nm.textContent = String(r.name || 'PILOT') + (r.isYou ? '  ◀ YOU' : '');
      const tm = document.createElement('span');
      const has = r.timeMs !== null && r.timeMs !== undefined && isFinite(r.timeMs);
      tm.className = 'r-time' + (has ? '' : ' dnf');
      tm.textContent = has ? formatTime(r.timeMs) : '-:--.---';
      li.appendChild(pos);
      li.appendChild(col);
      li.appendChild(nm);
      li.appendChild(tm);
      rList.appendChild(li);
    }
    btnRematch.style.display = data.canRematch ? '' : 'none';
    if (data.waiting) {
      rNote.innerHTML = '<span class="lb-wait">WAITING FOR HOST… ホストを待っています</span>';
    } else {
      rNote.textContent = '';
    }
    if (current === 'results') focusDefault(scr.results);
    else show('results');
    if (!isTouch && !data.canRematch) {
      try { btnMenu.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }
  press(btnRematch, function () { call('onRematch'); });
  press(btnMenu, function () { call('onMenu'); }, 'ui_back');

  // =====================================================================
  // Settings
  // =====================================================================
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  function getSettings() {
    return {
      control: settings.control,
      autoAccel: settings.autoAccel,
      sensitivity: settings.sensitivity,
      master: settings.master,
      music: settings.music,
      sfx: settings.sfx,
      quality: settings.quality
    };
  }
  function renderSettings() {
    const segs = setEl.querySelectorAll('.seg');
    for (let i = 0; i < segs.length; i++) {
      const key = segs[i].getAttribute('data-key');
      let v = settings[key];
      if (key === 'autoAccel') v = v ? 'on' : 'off';
      const bs = segs[i].querySelectorAll('.btn');
      for (let j = 0; j < bs.length; j++) {
        const on = bs[j].getAttribute('data-val') === v;
        bs[j].classList.toggle('sel', on);
        bs[j].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    const rs = setEl.querySelectorAll('input[type="range"]');
    for (let i = 0; i < rs.length; i++) {
      const key = rs[i].getAttribute('data-key');
      rs[i].value = String(settings[key]);
      renderVal(key);
    }
  }
  function renderVal(key) {
    const out = setEl.querySelector('.val[data-for="' + key + '"]');
    if (!out) return;
    out.textContent = key === 'sensitivity'
      ? 'x' + settings[key].toFixed(2)
      : Math.round(settings[key] * 100) + '%';
  }
  function commitSettings() {
    saveSettings();
    setControlMode(settings.control, settings.autoAccel);
    call('onSettings', getSettings());
  }
  (function wireSettings() {
    const segBtns = setEl.querySelectorAll('.seg .btn');
    for (let i = 0; i < segBtns.length; i++) {
      const b = segBtns[i];
      press(b, function () {
        const key = b.parentNode.getAttribute('data-key');
        const val = b.getAttribute('data-val');
        settings[key] = key === 'autoAccel' ? val === 'on' : val;
        renderSettings();
        commitSettings();
      }, 'ui_move');
    }
    const rs = setEl.querySelectorAll('input[type="range"]');
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const key = r.getAttribute('data-key');
      const lo = Number(r.min);
      const hi = Number(r.max);
      r.addEventListener('input', function () {
        settings[key] = clampNum(r.value, settings[key], lo, hi);
        renderVal(key);
        commitSettings();
      });
      r.addEventListener('change', function () { snd('ui_move'); });
      r.addEventListener('keydown', function (e) { e.stopPropagation(); });
      r.addEventListener('keyup', function (e) { e.stopPropagation(); });
    }
    press($(setEl, '.b-close'), function () { openSettings(false); }, 'ui_back');
    setEl.addEventListener('click', function (e) {
      if (e.target === setEl) { snd('ui_back'); openSettings(false); }
    });
  })();

  function openSettings(on) {
    settingsOpen = !!on;
    setEl.classList.toggle('on', settingsOpen);
    if (settingsOpen) {
      renderSettings();
      setEl.scrollTop = 0;
      focusDefault(setEl);
    } else {
      blurActive();
      if (current && current !== 'hud') focusDefault(scr[current]);
    }
  }

  // =====================================================================
  // Pause
  // =====================================================================
  function setPaused(on) {
    on = !!on;
    if (on === paused) return;
    paused = on;
    pauseEl.classList.toggle('on', on);
    resetTouch();
    if (on) focusDefault(pauseEl);
    else blurActive();
  }
  press($(pauseEl, '.b-resume'), function () { setPaused(false); call('onResume'); });
  press($(pauseEl, '.b-recal'), function () { call('onRecalibrate'); toast('TILT CENTERED / 傾きをリセット', 'good'); });
  press($(pauseEl, '.b-quit'), function () { setPaused(false); call('onQuit'); }, 'ui_back');

  // =====================================================================
  // HUD
  // =====================================================================
  const hud = scr.hud;
  const posEl = $(hud, '.hud-pos');
  const lapEl = $(hud, '.hud-lap');
  const gaugeEl = $(hud, '.gauge');
  const gFill = $(hud, '.g-fill');
  const slotEl = $(hud, '.item-slot');
  const wrongEl = $(hud, '.wrongway');
  const slipEl = $(hud, '.chip.slip');
  const aegisEl = $(hud, '.chip.aegis');
  const tPos = textNode($(hud, '.p-num'), '1');
  const tOrd = textNode($(hud, '.p-ord'), 'st');
  const tTot = textNode($(hud, '.p-tot'), '/1');
  const tLap = textNode($(hud, '.l-val'), '1/3');
  const tTime = textNode($(hud, '.l-time'), '0:00.000');
  const tSpeed = textNode($(hud, '.g-num'), '0');
  const tItem = textNode($(hud, '.i-name'), '');

  // last written values
  const hc = {
    speed: 0, lap: -1, laps: -1, pos: -1, total: -1, time: -1,
    item: '', rolling: false, ready: false, charge: 0, tier: 0,
    boosting: false, wrongWay: false, slip: false, shield: false
  };

  function setHud(h) {
    if (!h) return;
    let v;

    v = h.speed | 0;
    if (v !== hc.speed) { hc.speed = v; tSpeed.nodeValue = '' + v; }

    v = h.pos | 0;
    if (v !== hc.pos) { hc.pos = v; tPos.nodeValue = '' + v; tOrd.nodeValue = ordinal(v); }
    v = h.total | 0;
    if (v !== hc.total) { hc.total = v; tTot.nodeValue = '/' + v; }

    const laps = h.laps | 0;
    let lap = h.lap | 0;
    if (lap < 1) lap = 1;
    if (laps > 0 && lap > laps) lap = laps;
    if (lap !== hc.lap || laps !== hc.laps) {
      hc.lap = lap;
      hc.laps = laps;
      tLap.nodeValue = lap + '/' + laps;
      lapEl.classList.toggle('final', laps > 1 && lap === laps);
    }

    v = h.timeMs > 0 ? Math.floor(h.timeMs) : 0;
    if (v !== hc.time) { hc.time = v; tTime.nodeValue = formatTime(v); }

    const rolling = !!h.rolling;
    let item = h.item || '';
    if (rolling) item = ITEMS[Math.floor(performance.now() / 90) % ITEMS.length];
    if (item !== hc.item) {
      hc.item = item;
      slotEl.setAttribute('data-item', item);
    }
    if (rolling !== hc.rolling) {
      hc.rolling = rolling;
      slotEl.classList.toggle('rolling', rolling);
    }
    const ready = !rolling && item !== '';
    if (ready !== hc.ready) {
      hc.ready = ready;
      slotEl.classList.toggle('ready', ready);
    }
    const label = rolling ? '' : item;
    if (label !== tItem.nodeValue) tItem.nodeValue = label;

    let ch = h.charge > 0 ? (h.charge < 1 ? h.charge : 1) : 0;
    ch = Math.round(ch * 100);
    if (ch !== hc.charge) { hc.charge = ch; gFill.style.strokeDashoffset = '' + (100 - ch); }
    v = h.tier | 0;
    if (v !== hc.tier) { hc.tier = v; gaugeEl.setAttribute('data-tier', '' + v); }

    v = !!h.boosting;
    if (v !== hc.boosting) {
      hc.boosting = v;
      gaugeEl.classList.toggle('boost', v);
      hud.classList.toggle('boost', v);
    }
    v = !!h.wrongWay;
    if (v !== hc.wrongWay) { hc.wrongWay = v; wrongEl.classList.toggle('on', v); }
    v = !!h.slip;
    if (v !== hc.slip) { hc.slip = v; slipEl.classList.toggle('on', v); }
    v = !!h.shield;
    if (v !== hc.shield) { hc.shield = v; aegisEl.classList.toggle('on', v); }
  }

  // ---------------------------------------------------------------------
  // Minimap
  // ---------------------------------------------------------------------
  const mmCanvas = $(hud, '.mm');
  const mmCtx = mmCanvas.getContext('2d');
  const MM_SIZE = 128;
  let mm = null;

  function setMinimap(points) {
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const px = Math.round(MM_SIZE * dpr);
    mmCanvas.width = px;
    mmCanvas.height = px;
    mm = null;
    if (!mmCtx) return;
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.clearRect(0, 0, px, px);
    if (!Array.isArray(points) || points.length < 2) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const w = Math.max(maxX - minX, 1e-6);
    const d = Math.max(maxZ - minZ, 1e-6);
    const padPx = 13;
    const k = (MM_SIZE - padPx * 2) / Math.max(w, d);
    const ox = (MM_SIZE - w * k) / 2 - minX * k;
    const oz = (MM_SIZE - d * k) / 2 - minZ * k;

    const off = document.createElement('canvas');
    off.width = px;
    off.height = px;
    const g = off.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = points[i].x * k + ox;
      const y = points[i].z * k + oz;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.strokeStyle = 'rgba(3, 8, 18, 0.85)';
    g.lineWidth = 8;
    g.stroke();
    g.strokeStyle = 'rgba(34, 230, 255, 0.35)';
    g.lineWidth = 5;
    g.stroke();
    g.strokeStyle = '#bff6ff';
    g.lineWidth = 1.6;
    g.stroke();
    // start / finish tick
    const sx = points[0].x * k + ox;
    const sy = points[0].z * k + oz;
    g.fillStyle = A;
    g.fillRect(sx - 3, sy - 3, 6, 6);

    mm = { off: off, k: k, ox: ox, oz: oz, dpr: dpr, px: px };
    mmCtx.drawImage(off, 0, 0);
  }

  function updateMinimap(dots) {
    if (!mm || !mmCtx) return;
    const g = mmCtx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, mm.px, mm.px);
    g.drawImage(mm.off, 0, 0);
    if (!dots) return;
    g.setTransform(mm.dpr, 0, 0, mm.dpr, 0, 0);
    const n = dots.length;
    let you = null;
    for (let i = 0; i < n; i++) {
      const d = dots[i];
      if (!d) continue;
      if (d.you) { you = d; continue; }
      g.fillStyle = d.color || '#ffffff';
      g.beginPath();
      g.arc(d.x * mm.k + mm.ox, d.z * mm.k + mm.oz, 3.2, 0, 6.2832);
      g.fill();
    }
    if (you) {
      const x = you.x * mm.k + mm.ox;
      const y = you.z * mm.k + mm.oz;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x, y, 5.6, 0, 6.2832);
      g.fill();
      g.fillStyle = you.color || C;
      g.beginPath();
      g.arc(x, y, 3.8, 0, 6.2832);
      g.fill();
    }
  }

  // ---------------------------------------------------------------------
  // Touch controls
  // ---------------------------------------------------------------------
  const resetters = [];

  function bindHold(el, flag, onDown) {
    const ids = new Set();
    function sync() {
      const on = ids.size > 0;
      if (flag) touch[flag] = on;
      el.classList.toggle('held', on);
    }
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      ids.add(e.pointerId);
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      sync();
      if (onDown) onDown(e);
    });
    function up(e) {
      if (!ids.has(e.pointerId)) return;
      ids.delete(e.pointerId);
      try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      sync();
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('lostpointercapture', up);
    resetters.push(function () { ids.clear(); sync(); });
  }

  bindHold($(hud, '.b-drift'), 'drift');
  bindHold($(hud, '.b-brake'), 'brake');
  bindHold($(hud, '.b-accel'), 'accel');
  bindHold(slotEl, '', function () { call('onItem'); });

  // steer zone: one element, side decided by pointer position so a thumb can slide across
  const steerEl = $(hud, '.steer');
  const padL = $(hud, '.pad-l');
  const padR = $(hud, '.pad-r');
  const steerPts = new Map();
  let steerMid = 0;

  function steerSync() {
    let l = false, r = false;
    steerPts.forEach(function (side) {
      if (side < 0) l = true; else r = true;
    });
    if (l !== touch.left) { touch.left = l; padL.classList.toggle('held', l); }
    if (r !== touch.right) { touch.right = r; padR.classList.toggle('held', r); }
  }
  steerEl.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    const rc = steerEl.getBoundingClientRect();
    steerMid = rc.left + rc.width / 2;
    try { steerEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    steerPts.set(e.pointerId, e.clientX < steerMid ? -1 : 1);
    steerSync();
  });
  steerEl.addEventListener('pointermove', function (e) {
    if (!steerPts.has(e.pointerId)) return;
    const side = e.clientX < steerMid ? -1 : 1;
    if (steerPts.get(e.pointerId) !== side) {
      steerPts.set(e.pointerId, side);
      steerSync();
    }
  });
  function steerUp(e) {
    if (!steerPts.has(e.pointerId)) return;
    steerPts.delete(e.pointerId);
    try { if (steerEl.hasPointerCapture(e.pointerId)) steerEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    steerSync();
  }
  steerEl.addEventListener('pointerup', steerUp);
  steerEl.addEventListener('pointercancel', steerUp);
  steerEl.addEventListener('pointerleave', steerUp);
  steerEl.addEventListener('lostpointercapture', steerUp);
  resetters.push(function () { steerPts.clear(); steerSync(); });

  function resetTouch() {
    for (let i = 0; i < resetters.length; i++) resetters[i]();
    touch.left = false;
    touch.right = false;
    touch.accel = false;
    touch.brake = false;
    touch.drift = false;
    padL.classList.remove('held');
    padR.classList.remove('held');
  }

  $(hud, '.pause-btn').addEventListener('pointerdown', function (e) {
    e.preventDefault();
    if (paused) return;
    snd('ui_select');
    setPaused(true);
    call('onPause');
  });

  function setControlMode(mode, autoAccel) {
    mode = mode === 'tilt' ? 'tilt' : 'touch';
    autoAccel = !!autoAccel;
    if (mode === controlMode && autoAccel === controlAuto) return;
    controlMode = mode;
    controlAuto = autoAccel;
    hud.classList.toggle('ctl-tilt', mode === 'tilt');
    hud.classList.toggle('ctl-touch', mode === 'touch');
    hud.classList.toggle('no-auto', !autoAccel);
    pauseEl.classList.toggle('no-tilt', mode !== 'tilt');
    resetTouch();
  }

  // swallow browser gestures over the HUD (scroll, zoom, long-press, double-tap)
  function stop(e) { if (e.cancelable) e.preventDefault(); }
  const np = { passive: false };
  hud.addEventListener('touchstart', stop, np);
  hud.addEventListener('touchmove', stop, np);
  hud.addEventListener('touchend', stop, np);
  hud.addEventListener('dblclick', stop);
  root.addEventListener('contextmenu', stop);
  document.addEventListener('gesturestart', stop, np);
  document.addEventListener('gesturechange', stop, np);
  window.addEventListener('blur', resetTouch);
  document.addEventListener('visibilitychange', function () { if (document.hidden) resetTouch(); });

  // =====================================================================
  // FX: countdown / toast / banner / flash
  // =====================================================================
  const countEl = $(fx, '.count');
  const toastEl = $(fx, '.toast');
  const bannerEl = $(fx, '.banner');
  const flashEl = $(fx, '.flash');
  let countVal = null;
  let toastTimer = 0;
  let bannerTimer = 0;
  let flashTimer = 0;

  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow so the animation replays
    el.classList.add(cls);
  }

  function countdown(v) {
    if (v === undefined) v = null;
    if (v === countVal) return;
    countVal = v;
    if (v === null) {
      countEl.classList.remove('show');
      countEl.classList.remove('go');
      countEl.textContent = '';
      return;
    }
    const s = String(v);
    countEl.textContent = s;
    countEl.classList.toggle('go', s.toUpperCase() === 'GO');
    restart(countEl, 'show');
  }

  function toast(text, kind) {
    clearTimeout(toastTimer);
    toastEl.textContent = text === null || text === undefined ? '' : String(text);
    toastEl.className = 'toast on' + (kind === 'good' ? ' good' : kind === 'bad' ? ' bad' : '');
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1600);
  }

  function banner(text) {
    clearTimeout(bannerTimer);
    bannerEl.textContent = text === null || text === undefined ? '' : String(text);
    restart(bannerEl, 'show');
    bannerTimer = setTimeout(function () { bannerEl.classList.remove('show'); }, 2050);
  }

  function flash(color) {
    clearTimeout(flashTimer);
    flashEl.style.background = color || '#ffffff';
    restart(flashEl, 'show');
    flashTimer = setTimeout(function () { flashEl.classList.remove('show'); }, 420);
  }

  // =====================================================================
  // Keyboard navigation for menus
  // =====================================================================
  function menuScope() {
    if (settingsOpen) return setEl;
    if (paused) return pauseEl;
    if (current && current !== 'hud') return scr[current];
    return null;
  }
  window.addEventListener('keydown', function (e) {
    const scope = menuScope();
    if (!scope) return;
    const key = e.key;
    if (key === 'Escape' && settingsOpen) {
      e.preventDefault();
      e.stopPropagation();
      snd('ui_back');
      openSettings(false);
      return;
    }
    const tgt = e.target;
    const tag = tgt && tgt.tagName ? tgt.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      const all = scope.querySelectorAll('button:not([disabled]), input');
      const list = [];
      for (let i = 0; i < all.length; i++) {
        if (all[i].offsetParent !== null) list.push(all[i]);
      }
      if (!list.length) return;
      let idx = list.indexOf(document.activeElement);
      if (idx < 0) idx = key === 'ArrowDown' ? 0 : list.length - 1;
      else idx = (idx + (key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      e.preventDefault();
      try { list[idx].focus(); } catch (err) { /* ignore */ }
      snd('ui_move');
    } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && current === 'title' && !settingsOpen) {
      if (trackNames.length > 1) {
        e.preventDefault();
        snd('ui_move');
        stepTrack(key === 'ArrowLeft' ? -1 : 1);
      }
    }
  });

  // =====================================================================
  // Init
  // =====================================================================
  setControlMode(settings.control, settings.autoAccel);
  show('title');

  return {
    show: show,
    setTracks: setTracks,
    getName: getName,
    getSettings: getSettings,
    setLobby: setLobby,
    setHud: setHud,
    setMinimap: setMinimap,
    updateMinimap: updateMinimap,
    countdown: countdown,
    toast: toast,
    banner: banner,
    flash: flash,
    showResults: showResults,
    setPaused: setPaused,
    touch: touch,
    setControlMode: setControlMode,
    isTouch: isTouch
  };
}
