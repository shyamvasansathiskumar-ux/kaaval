// Kaaval's world: commands fly at a glass gate. Allowed ones pass through; denied ones
// shatter against it. Every decision adds a block to the hash chain on the floor behind.
import { createWorld, THREE, smooth, textTexture } from "./world.js";

const ACC = new THREE.Color("#ec5418");
const INK = new THREE.Color("#15120e");
const OK = new THREE.Color("#1d7a4a");
const FLOOR = -1.6;
const GX = 2.2;        // gate plane x

const CMDS = [
  ["rm -rf tests/ patches/ plan/ ~/", "DENY"], ["npm test", "ALLOW"], ["rmdir /s /q d:\\", "DENY"],
  ["git status", "ALLOW"], ["DROP TABLE companies", "DENY"], ["rm -rf .cache", "ALLOW"],
  ["railway volume delete prod-db", "DENY"], ["pytest -q", "ALLOW"], ["echo x > /etc/passwd", "DENY"],
  ["mv a.md b.md c.md archive", "DENY"], ["find . -name '*.pyc' -delete", "ALLOW"], ["rm -rf $DIR", "ASK"],
];

createWorld(document.getElementById("world"), async ({ scene, camera, mobile }) => {
  await document.fonts?.load("500 40px 'Geist Mono'").catch(() => {});

  /* ---------- the gate ---------- */
  const gate = new THREE.Group();
  const GH = 3.6, GW = 4.6;
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.06, GH, GW), new THREE.MeshPhysicalMaterial({
    color: 0xfff3e8, roughness: 0.08, metalness: 0, transmission: 0.0, transparent: true, opacity: 0.28, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false }));
  glass.position.y = FLOOR + GH / 2;
  const edgeMat = new THREE.MeshStandardMaterial({ color: ACC, roughness: 0.35, emissive: ACC, emissiveIntensity: 0.05 });
  const inkMat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.5 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, GW + 0.14), edgeMat); top.position.y = FLOOR + GH;
  const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, GH, 0.16), inkMat); p1.position.set(0, FLOOR + GH / 2, -GW / 2);
  const p2 = p1.clone(); p2.position.z = GW / 2;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, GW + 0.2), inkMat); base.position.y = FLOOR + 0.03;
  [glass, top, p1, p2, base].forEach((m) => { m.castShadow = m !== glass; m.receiveShadow = true; gate.add(m); });
  // scan line that sweeps the glass
  const scan = new THREE.Mesh(new THREE.PlaneGeometry(GW, 0.05), new THREE.MeshBasicMaterial({ color: ACC, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  scan.rotation.y = Math.PI / 2; scan.position.x = 0.04;
  gate.add(scan);
  gate.position.x = GX;
  scene.add(gate);

  /* ---------- command cards ---------- */
  const cards = CMDS.map(([c, v]) => {
    const deny = v === "DENY", ask = v === "ASK";
    const tex = textTexture(c, { font: "500 40px 'Geist Mono'", color: deny ? "#15120e" : "#f4efe6", bg: deny ? "#ec5418" : ask ? "#8a6a1f" : "#15120e", pad: 30, height: 84, radius: 18 });
    const h = 0.3, w = h * tex.userData.aspect;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.userData = { v, w, live: false };
    m.visible = false;
    scene.add(m);
    return m;
  });

  /* ---------- shards for denied commands ---------- */
  const NSH = 240;
  const shards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.07, 0.012), new THREE.MeshStandardMaterial({ color: ACC, roughness: 0.4 }), NSH);
  shards.castShadow = true;
  scene.add(shards);
  const sh = Array.from({ length: NSH }, () => ({ p: new THREE.Vector3(0, -50, 0), v: new THREE.Vector3(), r: new THREE.Euler(), w: new THREE.Vector3(), life: 0 }));
  let shi = 0;
  function burst(pos, w) {
    for (let k = 0; k < 26; k++) {
      const s = sh[shi++ % NSH];
      s.p.set(pos.x - 0.05, pos.y + (Math.random() - 0.5) * 0.3, pos.z + (Math.random() - 0.5) * w);
      s.v.set(-0.6 - Math.random() * 1.8, 0.8 + Math.random() * 2.2, (Math.random() - 0.5) * 2.4);
      s.w.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      s.life = 3.2;
    }
  }

  /* ---------- the hash chain on the floor behind the gate ---------- */
  const NL = 12;
  const links = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.2, 0.34), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), NL);
  links.castShadow = true; links.receiveShadow = true;
  const bar = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.03, 0.03), new THREE.MeshStandardMaterial({ color: INK, roughness: 0.5 }), NL);
  scene.add(links, bar);
  const chain = [];                 // newest first: {col, born}
  for (let i = 0; i < 10; i++) chain.push({ c: i % 3 ? INK : ACC, born: -10 });
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3(1, 1, 1), e = new THREE.Euler();

  // spawn queue
  let next = 0, spawnT = 0.4, lastEvent = null;
  const lanesZ = [-1.6, -0.6, 0.2, -1.1, 0.6];

  const look = new THREE.Vector3();
  const CAM = [   // [camX, camY, camZ, lookX, lookY, lookZ, sceneShiftX]
    [-1.0, 1.2, 10.2, 0.6, 0.35, -0.5, 1.9],
    [-1.6, 1.6, 10.0, 0.0, 0.25, -0.5, -5.6],
    [-0.5, 2.4, 10.4, 0.0, 0.3, -0.5, 2.4],
    [-1.0, 3.2, 11.0, 0.2, 0.0, -0.5, 6.8],
    [-2.0, 1.6, 10.0, -1.0, 0.3, -0.5, 6.8],
    [-2.0, 1.6, 10.0, -1.0, 0.3, -0.5, 6.8],
    [0.0, 2.2, 12.0, 0.0, 0.4, -0.5, 7.2],
    [0.0, 2.6, 13.0, 0.0, 0.4, -0.5, 2.2],
  ];
  const camAt = (st) => {
    const i = Math.max(0, Math.min(CAM.length - 2, Math.floor(st))), f = smooth(0.15, 0.85, st - i);
    return CAM[i].map((v, j) => v + (CAM[i + 1][j] - v) * f);
  };
  const world = new THREE.Group();   // everything shifts together per stage
  scene.add(world);
  [gate, shards, links, bar, ...cards].forEach((o) => world.add(o));

  return (st) => {
    const t = st.t, dt = st.dt;
    // spawn: follow the page's own verdict stream when it changes, else cycle
    const ev = window.Site?.kaavalEvent;
    spawnT -= dt;
    const spawning = st.stage < 0.8 || st.stage > 6.6;
    if (spawning && ((ev && ev !== lastEvent) || spawnT <= 0)) {
      let card = null;
      if (ev && ev !== lastEvent) { lastEvent = ev; card = cards.find((c, i) => CMDS[i][0] === ev.cmd && !c.userData.live); }
      if (!card) { for (let k = 0; k < cards.length; k++) { const c = cards[(next + k) % cards.length]; if (!c.userData.live) { card = c; next = (next + k + 1) % cards.length; break; } } }
      if (card) {
        card.userData.live = true; card.visible = true; card.userData.hit = false;
        card.position.set(GX - 3.6 - Math.random() * 1.2, FLOOR + 0.35 + Math.random() * 1.3, lanesZ[Math.floor(Math.random() * lanesZ.length)]);
        card.userData.speed = 1.5 + Math.random() * 0.5;
        card.rotation.set(0, 0, 0); card.material.opacity = 0; card.userData.born = t;
      }
      spawnT = 1.15;
    }
    for (const c of cards) {
      if (!c.userData.live) continue;
      const u = c.userData;
      if (!u.hit) {
        c.position.x += u.speed * dt;
        c.rotation.y = Math.sin(t * 1.3 + c.position.z) * 0.12;
        c.material.opacity = Math.min(1, (t - (u.born || 0)) / 0.6);
        const front = c.position.x + Math.cos(c.rotation.y) * u.w * 0.5;
        if (u.v !== "ALLOW" && front >= GX - 0.05) {
          u.hit = true;
          if (u.v === "DENY") { burst(new THREE.Vector3(GX, c.position.y, c.position.z), u.w * 0.6); c.visible = false; u.live = false; }
          else { u.askT = 1.4; }
          chain.unshift({ c: u.v === "DENY" ? ACC : new THREE.Color("#c99a2e"), born: t });
        }
        if (u.v === "ALLOW" && c.position.x - u.w / 2 > GX + 0.1 && !u.logged) { u.logged = true; chain.unshift({ c: OK, born: t }); }
        if (c.position.x - u.w / 2 > GX + 5) { c.visible = false; u.live = false; u.logged = false; }
      } else if (u.v === "ASK") {
        u.askT -= dt;   // waits at the gate for a human, then drifts back
        c.position.x -= 0.25 * dt;
        c.position.y += Math.sin(t * 3) * 0.002;
        if (u.askT <= 0) { c.visible = false; u.live = false; }
      }
    }
    while (chain.length > NL) chain.pop();

    // shards
    for (let i = 0; i < NSH; i++) {
      const s = sh[i];
      if (s.life > 0) {
        s.life -= dt;
        s.v.y -= 6.5 * dt;
        s.p.addScaledVector(s.v, dt);
        if (s.p.y < FLOOR + 0.02) { s.p.y = FLOOR + 0.02; s.v.y *= -0.25; s.v.x *= 0.6; s.v.z *= 0.6; s.w.multiplyScalar(0.6); }
        s.r.x += s.w.x * dt; s.r.y += s.w.y * dt; s.r.z += s.w.z * dt;
      }
      const sc = s.life > 0 ? Math.min(1, s.life / 0.8) : 0.0001;
      q.setFromEuler(s.r); s3.setScalar(sc);
      m4.compose(s.p, q, s3); shards.setMatrixAt(i, m4);
    }
    shards.instanceMatrix.needsUpdate = true;

    // chain: newest block sits by the gate, older ones march away (shown in the hero and the footer only)
    const show = Math.max(1 - smooth(0.5, 0.95, st.stage), smooth(6.6, 7.0, st.stage));
    for (let i = 0; i < NL; i++) {
      const b = chain[i];
      const age = b ? Math.min(1, (t - b.born) / 0.6) : 1;
      const x = GX + 0.9 + i * 0.46 - (1 - age) * 0.46;
      const y = FLOOR + 0.1 + (1 - age) * 0.6;
      v3.set(x, y, -2.6); q.identity(); s3.setScalar(b ? Math.max(0.0001, show) : 0.0001);
      m4.compose(v3, q, s3); links.setMatrixAt(i, m4);
      links.setColorAt(i, b ? b.c : INK);
      v3.set(x + 0.26, FLOOR + 0.1, -2.6); s3.setScalar(b && i < NL - 1 && chain[i + 1] ? Math.max(0.0001, show) : 0.0001);
      m4.compose(v3, q, s3); bar.setMatrixAt(i, m4);
    }
    links.instanceMatrix.needsUpdate = true; links.instanceColor.needsUpdate = true; bar.instanceMatrix.needsUpdate = true;

    scan.position.y = FLOOR + GH / 2 + Math.sin(t * 0.9) * (GH / 2 - 0.1);

    const c = camAt(st.stage);
    world.position.x = st.mobile ? 0.6 : c[6];
    camera.position.set(c[0] + st.px * 0.4, c[1] - st.py * 0.25, c[2] + (st.mobile ? 6 : 0));
    look.set(c[3], c[4] + (st.mobile ? 0.9 : 0), c[5]);
    camera.lookAt(look);
  };
}, { bg: "#e8e1d3", fog: [11, 36] });
