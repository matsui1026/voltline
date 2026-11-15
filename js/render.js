// Three.js renderer: neon city, track ribbon, hover craft, effects, chase camera.
import * as THREE from 'three';
import { C } from './sim.js';

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}

function glowTex() {
  return canvasTex(64, 64, (g) => {
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(255,255,255,0.5)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  });
}

export async function createRenderer(canvas, quality) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'high', powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.3, 5000);
  camera.position.set(0, 30, -60);
  let composer = null, bloom = null, useBloom = false;
  const R = { renderer, scene, camera };
  const glow = glowTex();
  let world = null;          // per-track group
  let dyn = null;            // per-race group
  let craft = [];            // [{k, g, body, flame, shield, under}]
  let boxMeshes = [], trapPool = [], boltPool = [];
  let camH = 0, camShake = 0, fov = 70, time = 0;
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();

  // particles
  const PN = 320;
  const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3), pVel = new Float32Array(PN * 3), pLife = new Float32Array(PN);
  let pNext = 0;
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.9, map: glow, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  particles.frustumCulled = false;
  scene.add(particles);
  const tmpC = new THREE.Color();
  function emit(x, y, z, vx, vy, vz, color, life) {
    const i = pNext; pNext = (pNext + 1) % PN;
    pPos[i * 3] = x; pPos[i * 3 + 1] = y; pPos[i * 3 + 2] = z;
    pVel[i * 3] = vx; pVel[i * 3 + 1] = vy; pVel[i * 3 + 2] = vz;
    tmpC.set(color);
    pCol[i * 3] = tmpC.r; pCol[i * 3 + 1] = tmpC.g; pCol[i * 3 + 2] = tmpC.b;
    pLife[i] = life;
  }

  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a0830, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.4, 1, 0.3);
  scene.add(sun);

  R.setQuality = async (q) => {
    quality = q;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === 'high' ? 2 : 1.25));
    useBloom = false;
    if (q === 'high') {
      try {
        if (!composer) {
          const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
            import('three/addons/postprocessing/EffectComposer.js'),
            import('three/addons/postprocessing/RenderPass.js'),
            import('three/addons/postprocessing/UnrealBloomPass.js'),
            import('three/addons/postprocessing/OutputPass.js'),
          ]);
          composer = new EffectComposer(renderer);
          composer.addPass(new RenderPass(scene, camera));
          bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.45, 0.72);
          composer.addPass(bloom);
          composer.addPass(new OutputPass());
        }
        useBloom = true;
      } catch (e) { console.warn('bloom unavailable', e); }
    }
    R.resize();
  };

  R.resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
  };
  window.addEventListener('resize', R.resize);
  window.addEventListener('orientationchange', () => setTimeout(R.resize, 250));

  function ribbon(track, latA, yA, latB, yB, vScale) {
    const n = track.n, pos = new Float32Array((n + 1) * 6), uv = new Float32Array((n + 1) * 4), idx = [];
    for (let j = 0; j <= n; j++) {
      const i = j % n;
      pos.set([track.px[i] + track.nx[i] * latA, yA, track.pz[i] + track.nz[i] * latA,
        track.px[i] + track.nx[i] * latB, yB, track.pz[i] + track.nz[i] * latB], j * 6);
      uv.set([0, j * track.step / vScale, 1, j * track.step / vScale], j * 4);
      if (j < n) idx.push(j * 2, j * 2 + 1, j * 2 + 2, j * 2 + 1, j * 2 + 3, j * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  R.loadTrack = (track) => {
    const def = track.def;
    if (world) { scene.remove(world); world.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    world = new THREE.Group();
    scene.add(world);
    scene.fog = new THREE.Fog(def.fog, 120, 1100);
    renderer.setClearColor(def.fog);
    const A = def.colA, B = def.colB;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();

    // sky dome
    const sky = new THREE.Mesh(new THREE.SphereGeometry(3500, 24, 12), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(def.skyTop) }, hor: { value: new THREE.Color(def.skyHorizon) }, low: { value: new THREE.Color(def.fog) } },
      vertexShader: 'varying vec3 p; void main(){ p=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'varying vec3 p; uniform vec3 top; uniform vec3 hor; uniform vec3 low; void main(){ float h=clamp(p.y,0.0,1.0); vec3 c=mix(hor,top,pow(h,0.45)); c=mix(low,c,smoothstep(0.0,0.08,p.y)); gl_FragColor=vec4(c,1.0); }',
    }));
    world.add(sky);
    R.sky = sky;
    // stars
    const sp = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const a = Math.random() * Math.PI * 2, y = 0.08 + Math.random() * 0.9, r = Math.sqrt(1 - y * y);
      sp.set([Math.cos(a) * r * 3200, y * 3200, Math.sin(a) * r * 3200], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    world.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfe8ff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 })));
    // distant planet
    const planet = new THREE.Mesh(new THREE.CircleGeometry(520, 48), new THREE.MeshBasicMaterial({
      fog: false, transparent: true, depthWrite: false,
      map: canvasTex(256, 256, (g) => {
        const gr = g.createLinearGradient(0, 0, 0, 256);
        gr.addColorStop(0, A); gr.addColorStop(1, B);
        g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
        g.globalCompositeOperation = 'destination-out';
        for (let y = 120; y < 256; y += 18) g.fillRect(0, y, 256, 3 + (y - 120) * 0.06);
      }),
    }));
    planet.position.set(-900, 420, 2900);
    planet.lookAt(0, 200, 0);
    world.add(planet);

    // ground grid
    const gridT = canvasTex(128, 128, (g) => {
      g.fillStyle = '#05060d'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = B; g.globalAlpha = 0.55; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
    }, true);
    gridT.repeat.set(260, 260); gridT.anisotropy = maxAniso;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), new THREE.MeshBasicMaterial({ map: gridT }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.6;
    world.add(ground);

    // road
    const shoulder = (track.wall - track.half) / (2 * track.wall);
    const roadT = canvasTex(512, 256, (g, w, h) => {
      g.fillStyle = '#0a0c16'; g.fillRect(0, 0, w, h);
      const sw = shoulder * w;
      g.fillStyle = '#12091c'; g.fillRect(0, 0, sw, h); g.fillRect(w - sw, 0, sw, h);
      g.strokeStyle = B; g.globalAlpha = 0.35; g.lineWidth = 6;
      for (let y = -64; y < h + 64; y += 32) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(sw, y + 40); g.stroke();
        g.beginPath(); g.moveTo(w, y); g.lineTo(w - sw, y + 40); g.stroke();
      }
      g.globalAlpha = 0.09; g.fillStyle = '#ffffff';
      for (let y = 0; y < h; y += 64) g.fillRect(sw, y, w - 2 * sw, 2);
      g.globalAlpha = 1; g.fillStyle = A;
      g.fillRect(sw - 5, 0, 10, h); g.fillRect(w - sw - 5, 0, 10, h);
      g.fillStyle = '#ffffff'; g.globalAlpha = 0.5;
      g.fillRect(w / 2 - 3, 0, 6, h * 0.45);
      g.globalAlpha = 0.16; g.fillStyle = A;
      g.beginPath(); g.moveTo(w / 2 - 60, 200); g.lineTo(w / 2, 160); g.lineTo(w / 2 + 60, 200); g.lineTo(w / 2 + 60, 215); g.lineTo(w / 2, 175); g.lineTo(w / 2 - 60, 215); g.fill();
    }, true);
    roadT.anisotropy = maxAniso;
    const road = new THREE.Mesh(ribbon(track, -track.wall, 0, track.wall, 0, 24), new THREE.MeshBasicMaterial({ map: roadT, side: THREE.DoubleSide }));
    world.add(road);

    // walls
    const wallT = canvasTex(64, 64, (g) => {
      g.fillStyle = '#080a14'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = A; g.fillRect(0, 0, 64, 8);
      g.fillStyle = B; g.fillRect(0, 40, 26, 6);
    }, true);
    const wm = new THREE.MeshBasicMaterial({ map: wallT, side: THREE.DoubleSide });
    world.add(new THREE.Mesh(ribbon(track, -track.wall, 0, -track.wall - 0.4, 1.6, 12), wm));
    world.add(new THREE.Mesh(ribbon(track, track.wall, 0, track.wall + 0.4, 1.6, 12), wm));

    // arches
    const archG = new THREE.TorusGeometry(track.wall + 1.5, 0.45, 6, 28, Math.PI);
    const mA = new THREE.MeshBasicMaterial({ color: A }), mB = new THREE.MeshBasicMaterial({ color: B });
    const NA = 14;
    for (let a = 0; a < NA; a++) {
      const i = Math.floor((a + 0.5) / NA * track.n);
      const m = new THREE.Mesh(archG, a % 2 ? mA : mB);
      m.position.set(track.px[i], 0, track.pz[i]);
      m.rotation.y = track.heading[i];
      world.add(m);
    }
    // start gate
    const gate = new THREE.Group();
    const gm = new THREE.MeshBasicMaterial({ color: 0x2a3350 });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(track.wall * 2 + 4, 1.2, 1.2), gm);
    beam.position.y = 11; gate.add(beam);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(1.2, 11, 1.2), gm);
      p.position.set(s * (track.wall + 1.4), 5.5, 0); gate.add(p);
    }
    const holo = new THREE.Mesh(new THREE.PlaneGeometry(track.wall * 2, 3.2), new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      map: canvasTex(512, 64, (g) => {
        g.fillStyle = A;
        for (let x = 0; x < 512; x += 32) for (let y = 0; y < 64; y += 16) if (((x / 32) + (y / 16)) % 2 === 0) g.fillRect(x, y, 32, 16);
      }),
    }));
    holo.position.y = 8.6; gate.add(holo);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(track.half * 2, 1.6), new THREE.MeshBasicMaterial({ color: 0x9aa6c8 }));
    line.rotation.x = -Math.PI / 2; line.position.y = 0.03; gate.add(line);
    gate.position.set(track.px[0], 0, track.pz[0]);
    gate.rotation.y = track.heading[0];
    world.add(gate);

    // boost pads
    const padT = canvasTex(128, 128, (g) => {
      g.strokeStyle = '#ffc531'; g.lineWidth = 12; g.lineJoin = 'miter';
      for (let y = 20; y < 128; y += 36) { g.beginPath(); g.moveTo(14, y + 30); g.lineTo(64, y); g.lineTo(114, y + 30); g.stroke(); }
    });
    const padM = new THREE.MeshBasicMaterial({ map: padT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    R.padMat = padM;
    for (const p of track.pads) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 7), padM);
      m.rotation.set(-Math.PI / 2, 0, Math.PI - p.h, 'YXZ');
      m.rotation.set(0, 0, 0);
      m.geometry = m.geometry.clone().rotateX(Math.PI / 2);
      m.rotation.y = p.h;
      m.position.set(p.x, 0.06, p.z);
      world.add(m);
    }

    // city
    const winT = canvasTex(64, 128, (g) => {
      g.fillStyle = '#070912'; g.fillRect(0, 0, 64, 128);
      for (let y = 4; y < 128; y += 8) for (let x = 4; x < 64; x += 8) {
        const r = Math.random();
        if (r < 0.45) { g.fillStyle = r < 0.15 ? '#ffffff' : r < 0.3 ? A : B; g.globalAlpha = 0.25 + Math.random() * 0.6; g.fillRect(x, y, 4, 3); }
      }
    }, true);
    const NB = quality === 'high' ? 260 : 150;
    const bg = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const city = new THREE.InstancedMesh(bg, new THREE.MeshBasicMaterial({ map: winT }), NB);
    const mat = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), po = new THREE.Vector3();
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
      minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
    }
    const clear = (track.wall + 22) ** 2;
    let placed = 0, tries = 0;
    while (placed < NB && tries++ < NB * 30) {
      const x = minX - 320 + Math.random() * (maxX - minX + 640), z = minZ - 320 + Math.random() * (maxZ - minZ + 640);
      const w = 14 + Math.random() * 26, d = 14 + Math.random() * 26;
      let ok = true;
      const lim = clear + (w * w + d * d) / 4 + 2 * Math.sqrt(clear) * Math.hypot(w, d) / 2;
      for (let i = 0; i < track.n; i += 4) {
        const dx = x - track.px[i], dz = z - track.pz[i];
        if (dx * dx + dz * dz < lim) { ok = false; break; }
      }
      if (!ok) continue;
      po.set(x, -0.6, z); sc.set(w, 18 + Math.random() * Math.random() * 190, d);
      mat.compose(po, q, sc);
      city.setMatrixAt(placed, mat);
      city.setColorAt(placed, tmpC.setHSL(0.6 + Math.random() * 0.25, 0.5, 0.45 + Math.random() * 0.4));
      placed++;
    }
    city.count = placed;
    city.instanceMatrix.needsUpdate = true;
    if (city.instanceColor) city.instanceColor.needsUpdate = true;
    world.add(city);
    R.track = track;
  };

  function buildCraft(color) {
    const g = new THREE.Group(), body = new THREE.Group();
    g.add(body);
    const hullG = new THREE.BoxGeometry(1.5, 0.42, 3.4, 1, 1, 2);
    const hp = hullG.attributes.position;
    for (let i = 0; i < hp.count; i++) {
      const z = hp.getZ(i);
      if (z > 1) { hp.setX(i, hp.getX(i) * 0.25); hp.setY(i, hp.getY(i) * 0.4 - 0.08); }
      else if (z < -1) hp.setY(i, hp.getY(i) * 1.25 + 0.05);
    }
    hullG.computeVertexNormals();
    const dark = new THREE.MeshPhongMaterial({ color: 0x232a3f, specular: 0x99bbff, shininess: 80, flatShading: true });
    const col = new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.35, flatShading: true });
    const lit = new THREE.MeshBasicMaterial({ color });
    body.add(new THREE.Mesh(hullG, dark));
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), new THREE.MeshPhongMaterial({ color: 0x0a1020, specular: 0xffffff, shininess: 120 }));
    canopy.scale.set(0.9, 0.55, 1.7); canopy.position.set(0, 0.28, -0.1); body.add(canopy);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 2.9), lit);
    stripe.position.set(0, 0.24, 0.1); stripe.rotation.x = 0.06; body.add(stripe);
    for (const s of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.36, 2.1), col);
      pod.position.set(s * 1.05, -0.05, -0.5); body.add(pod);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.9), col);
      fin.position.set(s * 1.05, 0.35, -1.2); fin.rotation.x = -0.3; body.add(fin);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.6), dark);
      strut.position.set(s * 0.65, -0.02, -0.5); body.add(strut);
      const jet = new THREE.Mesh(new THREE.CircleGeometry(0.2, 10), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      jet.position.set(s * 1.05, -0.05, -1.56); jet.rotation.y = Math.PI; body.add(jet);
    }
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.4, 8).rotateX(-Math.PI / 2).translate(0, 0, -1.2),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    flame.position.set(0, 0, -1.6); body.add(flame);
    const under = new THREE.Mesh(new THREE.PlaneGeometry(5, 6).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glow, color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    under.position.y = -0.5; g.add(under);
    const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(2.3, 1),
      new THREE.MeshBasicMaterial({ color: 0x66f0ff, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    shield.visible = false; g.add(shield);
    return { g, body, flame, shield, under };
  }

  R.setRace = (race) => {
    if (dyn) scene.remove(dyn);
    dyn = new THREE.Group();
    scene.add(dyn);
    craft = race.karts.map(k => {
      const c = buildCraft(k.color);
      c.k = k;
      dyn.add(c.g);
      return c;
    });
    const boxG = new THREE.OctahedronGeometry(1.15);
    const boxW = new THREE.MeshBasicMaterial({ color: 0xffc531, wireframe: true });
    const boxS = new THREE.MeshBasicMaterial({ color: 0xff2bd6, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    boxMeshes = race.boxes.map(b => {
      const m = new THREE.Group();
      m.add(new THREE.Mesh(boxG, boxW));
      const inner = new THREE.Mesh(boxG, boxS); inner.scale.setScalar(0.6); m.add(inner);
      m.position.set(b.x, 1.5, b.z);
      dyn.add(m);
      return m;
    });
    trapPool = []; boltPool = [];
    const trapG = new THREE.IcosahedronGeometry(1.0, 0), trapM = new THREE.MeshBasicMaterial({ color: 0xff3355, wireframe: true });
    const boltG = new THREE.SphereGeometry(0.6, 8, 6), boltM = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < 14; i++) {
      const t = new THREE.Mesh(trapG, trapM); t.visible = false; dyn.add(t); trapPool.push(t);
      const b = new THREE.Mesh(boltG, boltM); b.scale.set(1, 1, 3.5); b.visible = false; dyn.add(b); boltPool.push(b);
    }
    const k = race.local || race.karts[0];
    camH = k.h;
    camPos.set(k.x - Math.sin(k.h) * 22, 12, k.z - Math.cos(k.h) * 22);
    camLook.set(k.x, 1, k.z);
    fov = 70;
  };

  R.shake = (a) => { camShake = Math.max(camShake, a); };

  const TIER_COL = ['#ffffff', '#22e6ff', '#ffc531', '#ff2bd6'];

  // Update scene from race state. focus = craft the camera follows.
  R.update = (race, focus, dt) => {
    time += dt;
    if (R.padMat) R.padMat.opacity = 0.6 + 0.4 * Math.sin(time * 8);
    for (const c of craft) {
      const k = c.k;
      c.g.visible = !k.gone;
      if (k.gone) continue;
      const bob = Math.sin(time * 3 + k.slot) * 0.07;
      c.g.position.set(k.x, 0.75 + bob + k.hop * 0.35, k.z);
      c.g.rotation.y = k.h;
      c.body.rotation.set(0, k.yawVis + k.spin, k.lean, 'YXZ');
      const boosting = k.boostT > 0, sp01 = Math.max(0, k.speed) / C.MAX;
      const fl = (boosting ? 1.5 : 0.25 + sp01 * 0.6) * (0.85 + Math.random() * 0.3);
      c.flame.scale.set(boosting ? 1.5 : 1, boosting ? 1.5 : 1, fl);
      c.flame.material.color.set(boosting ? '#ffffff' : k.color);
      c.shield.visible = k.shield > 0;
      if (c.shield.visible) c.shield.rotation.y = time * 2;
      c.g.visible = !(k.inv > 0 && k.spinT <= 0 && Math.floor(time * 14) % 2 === 0);
      const sh = Math.sin(k.h), ch = Math.cos(k.h);
      if (k.drifting && Math.random() < 0.7) {
        const side = -k.driftDir;   // sparks from the outside rear pod
        emit(k.x - sh * 1.4 + ch * side * 1.1, 0.25, k.z - ch * 1.4 - sh * side * 1.1,
          -sh * k.speed * 0.3 + (Math.random() - 0.5) * 6, 2 + Math.random() * 4, -ch * k.speed * 0.3 + (Math.random() - 0.5) * 6,
          TIER_COL[k.tier], 0.35);
      }
      if (boosting && Math.random() < 0.8) {
        emit(k.x - sh * 2.4 + (Math.random() - 0.5), 0.8, k.z - ch * 2.4 + (Math.random() - 0.5),
          -sh * 12, Math.random() * 2, -ch * 12, k.color, 0.45);
      }
      if (k.stormT > 0 && Math.random() < 0.5) emit(k.x + (Math.random() - 0.5) * 3, 1 + Math.random() * 2, k.z + (Math.random() - 0.5) * 3, 0, 3, 0, '#ffff66', 0.3);
    }
    for (let i = 0; i < PN; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      if (pLife[i] <= 0) { pPos[i * 3 + 1] = -999; continue; }
      pPos[i * 3] += pVel[i * 3] * dt; pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt; pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      pVel[i * 3 + 1] -= 9 * dt;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;

    for (let i = 0; i < boxMeshes.length; i++) {
      const m = boxMeshes[i], b = race.boxes[i];
      m.visible = b.t <= 0;
      m.rotation.y = time * 1.6 + i; m.rotation.x = time * 0.9;
      m.position.y = 1.5 + Math.sin(time * 2 + i) * 0.2;
    }
    for (let i = 0; i < trapPool.length; i++) {
      const m = trapPool[i], t = race.traps[i];
      m.visible = !!t;
      if (t) { m.position.set(t.x, 0.9, t.z); m.rotation.y = time * 3; m.scale.setScalar(1 + 0.2 * Math.sin(time * 10)); }
    }
    for (let i = 0; i < boltPool.length; i++) {
      const m = boltPool[i], b = race.bolts[i];
      m.visible = !!b;
      if (b) {
        m.position.set(b.x, 0.9, b.z); m.rotation.y = b.h;
        emit(b.x, 0.9, b.z, (Math.random() - 0.5) * 4, 1, (Math.random() - 0.5) * 4, '#22e6ff', 0.3);
      }
    }

    // chase camera
    const k = focus;
    if (!k) return;
    const boosting = k.boostT > 0, sp01 = Math.max(0, k.speed) / C.MAX;
    camH += Math.atan2(Math.sin(k.h - camH), Math.cos(k.h - camH)) * Math.min(1, dt * (k.spinT > 0 ? 2 : 5.5));
    const back = 8.2 + sp01 * 1.6 + (boosting ? 2.2 : 0), up = 3.5;
    const tx = k.x - Math.sin(camH) * back, tz = k.z - Math.cos(camH) * back;
    const a = Math.min(1, dt * 9);
    camPos.x += (tx - camPos.x) * a; camPos.z += (tz - camPos.z) * a; camPos.y += (up - camPos.y) * Math.min(1, dt * 4);
    camLook.x += (k.x + Math.sin(k.h) * 7 - camLook.x) * Math.min(1, dt * 12);
    camLook.z += (k.z + Math.cos(k.h) * 7 - camLook.z) * Math.min(1, dt * 12);
    camLook.y = 1.4;
    camShake = Math.max(0, camShake - dt * 2.5);
    const sx = (Math.random() - 0.5) * camShake, sy = (Math.random() - 0.5) * camShake;
    camera.position.set(camPos.x + sx, camPos.y + sy + (boosting ? Math.random() * 0.05 : 0), camPos.z);
    camera.lookAt(camLook);
    camera.rotateZ(-k.steer * 0.045 * sp01 - (k.driftAmt || 0) * k.driftDir * 0.05);
    const fovT = 68 + sp01 * 10 + (boosting ? 16 : 0);
    fov += (fovT - fov) * Math.min(1, dt * (fovT > fov ? 6 : 2));
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (R.sky) R.sky.position.copy(camera.position);
  };

  // Slow orbit for menus.
  R.orbit = (dt) => {
    time += dt;
    const t = R.track;
    if (!t) return;
    const i = Math.floor((time * 9) % t.n), j = (i + 30) % t.n;
    camera.position.set(t.px[i] + t.nx[i] * 4, 9 + Math.sin(time * 0.3) * 3, t.pz[i] + t.nz[i] * 4);
    camera.lookAt(t.px[j], 2, t.pz[j]);
    if (camera.fov !== 75) { camera.fov = 75; camera.updateProjectionMatrix(); }
    if (R.sky) R.sky.position.copy(camera.position);
    if (dyn) { scene.remove(dyn); dyn = null; craft = []; }
  };

  R.render = () => { if (useBloom && composer) composer.render(); else renderer.render(scene, camera); };

  await R.setQuality(quality);
  return R;
}
