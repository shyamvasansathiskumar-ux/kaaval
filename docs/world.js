// Shared Three.js world: a sunlit sand-coloured studio the page scrolls through.
// Each site passes a `build(ctx)` that adds its own objects and returns an `update(state)` function.
import * as THREE from "three";
import { RoomEnvironment } from "./RoomEnvironment.js";

export { THREE };

export function damp(a, b, lambda, dt) { return THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt)); }
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const ease = (t) => 1 - Math.pow(1 - clamp01(t), 3);

// A 2D canvas texture with crisp text, for numerals, commands and labels in the scene.
export function textTexture(text, { font = "500 64px 'Geist Mono'", color = "#15120e", bg = null, pad = 24, height = null, radius = 0 } = {}) {
  const c = document.createElement("canvas"), g = c.getContext("2d");
  g.font = font;
  const m = g.measureText(text);
  const h = height || Math.ceil(parseInt(font.match(/(\d+)px/)[1], 10) * 1.5);
  c.width = Math.ceil(m.width + pad * 2); c.height = h;
  if (bg) { g.fillStyle = bg; if (radius) { g.beginPath(); g.roundRect(0, 0, c.width, c.height, radius); g.fill(); } else g.fillRect(0, 0, c.width, c.height); }
  g.font = font; g.fillStyle = color; g.textBaseline = "middle"; g.fillText(text, pad, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  t.userData.aspect = c.width / c.height;
  return t;
}

export async function createWorld(canvas, build, { bg = "#e8e1d3", fog = [9, 46], exposure = 1.0 } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch (e) {
    canvas.style.display = "none"; window.Site?.worldReady?.(); return null;
  }
  const dprCap = innerWidth < 800 ? 1.5 : 1.75;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, dprCap));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const bgc = new THREE.Color(bg);
  scene.background = bgc;
  scene.fog = new THREE.Fog(bgc, fog[0], fog[1]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.1, 120);

  // Light: a low warm sun for long soft shadows, a sky fill, and a ground that catches them.
  const hemi = new THREE.HemisphereLight(0xfff7ea, 0xcdbf9f, 1.15);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-7, 11, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -14; sun.shadow.camera.right = 14; sun.shadow.camera.top = 14; sun.shadow.camera.bottom = -14;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 40;
  sun.shadow.radius = 7; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), new THREE.MeshStandardMaterial({ color: bgc, roughness: 1, metalness: 0 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1.6; floor.receiveShadow = true;
  scene.add(floor);

  const ctx = { THREE, scene, camera, renderer, sun, hemi, floor, reduce, mobile: innerWidth < 800, logo: null };
  const update = await build(ctx);
  ctx.logo = scene.userData.logo || undefined;   // a scene names the group(s) that stand for the project

  // ---- loader view: while the page loads, the camera holds a close-up of the scene's logo (one
  // group or a list of groups), centred and small, with only the logo, the floor and the lights on
  // layer 1. At 100% the camera pulls back out of it to the scene's own camera ("opening").
  const fog0 = [scene.fog.near, scene.fog.far];
  const OPEN_MS = 1700;
  const DIR = new THREE.Vector3(0.5, 0.3, 1).normalize();
  const rig = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const box = new THREE.Box3(), sph = new THREE.Sphere(), aim = new THREE.PerspectiveCamera();
  let logos = null, kept = [];
  function setLogos() {
    const l = Array.isArray(ctx.logo) ? ctx.logo : ctx.logo ? [ctx.logo] : [];
    logos = l.filter((o) => o && o.isObject3D);
    if (!logos.length) return false;
    logos.forEach((g) => g.traverse((o) => o.layers.enable(1)));
    floor.layers.enable(1);
    scene.traverse((o) => { if (o.isLight) o.layers.enable(1); });
    return true;
  }
  function measure() {
    box.makeEmpty();
    logos.forEach((g) => box.expandByObject(g));
    if (box.isEmpty()) return null;
    box.getBoundingSphere(sph);
    return sph.radius > 0 && isFinite(sph.radius) ? sph : null;
  }
  function loaderView(S) {
    const phase = S.loadPhase;
    if (!phase || phase === "done" || ctx.logo === null) { if (logos) camera.layers.enableAll(); return 0; }
    if (!logos && !setLogos()) { ctx.logo = null; return 0; }
    const k = phase === "opening" ? ease(Math.min(1, (performance.now() - (S.openAt || 0)) / OPEN_MS)) : 0;
    if (k >= 1) { S.loadPhase = "done"; scene.fog.near = fog0[0]; scene.fog.far = fog0[1]; camera.layers.enableAll(); return 0; }
    const s0 = measure();
    if (!s0) { ctx.logo = null; camera.layers.enableAll(); return 0; }
    const R = s0.radius;
    // the model grows into place as loading runs (ease-out-back) and turns slowly
    const p = phase === "opening" ? 1 : Math.min(1, S.loadProgress || 0);
    const grow = Math.max(0.001, 0.35 + 0.65 * (1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2)));
    const spin = (1 - k) * (performance.now() / 1000) * 0.6;
    kept = logos.map((g) => [g.scale.clone(), g.rotation.y]);
    logos.forEach((g) => { g.scale.multiplyScalar(grow); g.rotation.y += spin; });
    const c = (measure() || s0).center.clone();
    const m = Math.min(1, camera.aspect);   // the model fills about a third of the short side
    const d = R / (0.16 * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * m);
    aim.position.copy(c).addScaledVector(DIR, d); aim.lookAt(c);
    rig.p.copy(camera.position); rig.q.copy(camera.quaternion);
    camera.position.lerpVectors(aim.position, rig.p, k);
    camera.quaternion.slerpQuaternions(aim.quaternion, rig.q, k);
    scene.fog.near = THREE.MathUtils.lerp(Math.max(0.1, d - R * 1.2), fog0[0], k * k);
    scene.fog.far = THREE.MathUtils.lerp(d + R * 2.5, fog0[1], k);
    if (phase === "loading") camera.layers.set(1); else camera.layers.enableAll();
    return 1;
  }
  function restore() { logos.forEach((g, i) => { g.scale.copy(kept[i][0]); g.rotation.y = kept[i][1]; }); }

  const state = { t: 0, dt: 0, stage: 0, progress: 0, px: 0, py: 0, w: innerWidth, h: innerHeight, mobile: innerWidth < 800 };
  function resize() {
    const w = innerWidth, h = innerHeight;
    state.w = w; state.h = h; state.mobile = w < 800; ctx.mobile = state.mobile;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();
  let rT; addEventListener("resize", () => { clearTimeout(rT); rT = setTimeout(resize, 80); });

  let lastT = performance.now();
  const clock = { getDelta() { const n = performance.now(), d = (n - lastT) / 1000; lastT = n; return d; } };
  let running = true, first = true;
  document.addEventListener("visibilitychange", () => { running = !document.hidden; if (running) { clock.getDelta(); loop(); } });
  function loop() {
    if (!running) return;
    const dt = Math.min(0.05, clock.getDelta());
    state.dt = reduce ? 0 : dt; state.t += state.dt;
    const S = window.Site || {};
    state.stage = damp(state.stage, S.stage || 0, 4.5, dt || 0.016);
    state.progress = damp(state.progress, S.progress || 0, 4.5, dt || 0.016);
    state.px = damp(state.px, (S.pointer?.x || 0), 3, dt || 0.016);
    state.py = damp(state.py, (S.pointer?.y || 0), 3, dt || 0.016);
    update(state);
    const held = loaderView(S);
    renderer.render(scene, camera);
    if (held) restore();       // the scene's own state stays untouched
    if (first) { first = false; if (held) S.modelReady?.(); window.Site?.worldReady?.(); window.__worldFrames = 0; }
    window.__worldFrames++;
    if (!reduce) requestAnimationFrame(loop);
  }
  if (reduce) { addEventListener("scroll", () => requestAnimationFrame(loop), { passive: true }); }
  loop();
  return ctx;
}
