// Input: device tilt (steering wheel style), on-screen touch buttons (from ui.touch) and keyboard.

export function createInput(ui, handlers) {
  const keys = Object.create(null);
  let tiltRaw = 0, tiltNeutral = 0, tiltSmooth = 0, tiltSeen = false, tiltOn = false;
  let keySteer = 0, prevLaunch = false, itemQueued = false;

  function screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    return typeof window.orientation === 'number' ? (window.orientation + 360) % 360 : 0;
  }

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    const a = screenAngle();
    // Landscape: rolling the phone like a steering wheel changes beta. Portrait: gamma.
    let v;
    if (a === 90) v = e.beta;
    else if (a === 270) v = -e.beta;
    else if (a === 180) v = -e.gamma;
    else v = e.gamma;
    tiltRaw = v;
    tiltSeen = true;
  }

  const input = {
    get tiltAvailable() { return tiltSeen; },
    // Must be called from a user gesture (iOS permission prompt).
    async enableTilt() {
      if (tiltOn) return true;
      try {
        const D = window.DeviceOrientationEvent;
        if (!D) return false;
        if (typeof D.requestPermission === 'function') {
          const r = await D.requestPermission();
          if (r !== 'granted') return false;
        }
        window.addEventListener('deviceorientation', onOrient);
        tiltOn = true;
        return true;
      } catch (e) { return false; }
    },
    calibrate() { tiltNeutral = tiltRaw; tiltSmooth = 0; },
    // settings: {control, autoAccel, sensitivity}
    read(settings, dt) {
      const t = ui.touch || {};
      const left = keys.ArrowLeft || keys.KeyA || t.left, right = keys.ArrowRight || keys.KeyD || t.right;
      const target = (right ? 1 : 0) - (left ? 1 : 0);
      keySteer += (target - keySteer) * Math.min(1, dt * (target === 0 ? 12 : 7));
      let steer = keySteer;
      if (settings.control === 'tilt' && tiltSeen) {
        let d = tiltRaw - tiltNeutral;
        if (d > 180) d -= 360; else if (d < -180) d += 360;
        const dead = 2.2, lock = 26 / (settings.sensitivity || 1);
        let v = Math.abs(d) < dead ? 0 : (d - Math.sign(d) * dead) / (lock - dead);
        v = Math.max(-1, Math.min(1, v));
        tiltSmooth += (v - tiltSmooth) * Math.min(1, dt * 14);
        steer = Math.max(-1, Math.min(1, steer + tiltSmooth));
      }
      const keyAccel = !!(keys.ArrowUp || keys.KeyW), brake = !!(keys.ArrowDown || keys.KeyS || t.brake);
      const drift = !!(keys.Space || t.drift);
      const manual = keyAccel || !!t.accel;
      const press = drift || manual;
      const launch = press && !prevLaunch;
      prevLaunch = press;
      const item = itemQueued;
      itemQueued = false;
      return { steer, accel: !brake && (settings.autoAccel || manual), brake, drift, item, launch };
    },
    queueItem() { itemQueued = true; },
  };

  window.addEventListener('keydown', e => {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.repeat) { if (/Arrow|Space/.test(e.code)) e.preventDefault(); return; }
    keys[e.code] = true;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyE') itemQueued = true;
    if (e.code === 'Escape' && handlers.onPause) handlers.onPause();
    if (/Arrow|Space/.test(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  return input;
}
