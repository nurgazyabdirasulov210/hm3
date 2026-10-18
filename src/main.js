import * as THREE from 'three';
import { createFigure } from './figure.js';
import { createSolids, MIDDLE } from './shapes.js';
import { createPortal } from './portal.js';
import { startTracking } from './hands.js';
import { createSim, CFG, popcount } from './sim.js';
import { clamp } from './filters.js';

const GLOW = { single: null, joined: new THREE.Color(0xb28dff), middle: new THREE.Color(0xff5a5a), portal: new THREE.Color(0xff9a2e) };

const video = document.getElementById('cam');
const sceneCanvas = document.getElementById('scene');
const skeleton = document.getElementById('skeleton');
const statusEl = document.getElementById('status');
const hud = document.getElementById('hud');
const sk = skeleton.getContext('2d');

const view = { W: innerWidth, H: innerHeight };
const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, alpha: true, antialias: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 10000);
const figure = createFigure(scene);
const solids = createSolids(scene);
const portal = createPortal(scene);

function resize() {
  view.W = innerWidth;
  view.H = innerHeight;
  const dpr = Math.min(devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(view.W, view.H, false);
  skeleton.width = view.W * dpr;
  skeleton.height = view.H * dpr;
  sk.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Camera distance is chosen so that 1 world unit == 1 CSS pixel on the z = 0 plane.
  camera.aspect = view.W / view.H;
  camera.position.set(view.W / 2, -view.H / 2, view.H / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.updateProjectionMatrix();
  figure.resize(view.W, view.H);
  solids.resize(view.W, view.H);
  portal.resize(view.W, view.H);
}
addEventListener('resize', resize);
resize();

// --- simulation -------------------------------------------------------------
// The gesture / physics state machine lives in sim.js; this file renders it.
const sim = createSim({ view, figure });
const S = sim.state;
let blur = 0;
const glow = new THREE.Color(0xc8d8ff);
const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
const poses = [];

// Once per rendered frame: record the pose for the ghost trail and set the blur.
function present(dt, t) {
  const { pos, vel, omega, mode } = S;
  const speed = Math.hypot(vel.x, vel.y);
  const spin = omega.length();
  const pose = poses.length > figure.ghosts ? poses.pop() : { q: new THREE.Quaternion() };
  pose.x = pos.x;
  pose.y = -pos.y;
  pose.r = Math.max(1, S.radius * S.scale * S.pop);
  pose.q.copy(S.qBank).multiply(S.qUser).multiply(qTilt).multiply(S.qSpin);
  poses.unshift(pose);
  figure.place(poses, S.visibility * S.vPrism, clamp(speed / 700 + spin / 8 + S.pulse, 0, 1));

  const target = GLOW[mode === 'portal' ? 'portal' : mode === 'joined' ? 'joined' : S.solidKey === MIDDLE ? 'middle' : 'single'] ?? figure.color;
  glow.lerp(target, 1 - Math.exp(-8 * dt));
  solids.place(S.solidKey, pose, S.visibility, glow, dt);
  portal.update(S.portalPts, S.portalLevel, dt, t, GLOW.portal);

  // Motion blur stays light: the figure must remain readable while it flies and spins.
  const blurTarget =
    clamp(speed / 1100 + spin * 0.12 + Math.abs(S.scaleV) * 0.4 + S.pulse * 2, 0, CFG.maxBlur) * (mode === 'portal' ? 0.15 : 1);
  blur += (blurTarget - blur) * (1 - Math.exp(-18 * dt));
  const glowCss = `drop-shadow(0 0 12px #${(mode === 'portal' ? GLOW.portal : glow).getHexString()})`;
  sceneCanvas.style.filter = blur > 0.25 ? `blur(${blur.toFixed(2)}px) ${glowCss}` : glowCss;
}

// --- hand skeleton overlay --------------------------------------------------
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function drawHands(hands) {
  sk.clearRect(0, 0, view.W, view.H);
  hands.forEach((pts, i) => {
    sk.strokeStyle = sk.fillStyle = i === 0 ? 'rgba(125,249,255,0.45)' : 'rgba(255,107,214,0.45)';
    sk.lineWidth = 1;
    sk.beginPath();
    for (const [a, b] of BONES) {
      sk.moveTo(pts[a].x, pts[a].y);
      sk.lineTo(pts[b].x, pts[b].y);
    }
    sk.stroke();
    for (const p of pts) {
      sk.beginPath();
      sk.arc(p.x, p.y, 2, 0, Math.PI * 2);
      sk.fill();
    }
  });
}

// --- input ------------------------------------------------------------------
// `?demo` drives the figure with a synthetic hand, to check rendering without a camera.
function demoHand(x, y, mask, side, pvx = 0) {
  // Thumb and index tips sit on the inner side of the hand, like an "L" frame.
  const pts = Array.from({ length: 21 }, () => ({ x, y }));
  pts[4] = { x: x + side * 30, y: y + 60 };
  pts[8] = { x: x + side * 30, y: y - 60 };
  return {
    x,
    y,
    size: 110,
    fingers: popcount(mask),
    mask,
    pts,
    pvx,
    pvy: 0,
    open: (1 - CFG.scaleMin) / (CFG.scaleMax - CFG.scaleMin), // the tool hand asks for scale 1
    openRate: 0,
    vx: 0,
    vy: 0,
    twist: 0,
    twistW: 1,
    flip: 0,
    flipW: 1,
    up: { x: 0, y: 1, z: 0 },
    fresh: true,
  };
}

// Cycle (40 s): prism figures, middle finger, joined hands, portal with growing mandala levels,
// then throws between two hands (the roles swap on each catch) and a throw with no hand to catch it.
let demoSwapped = false;
function demoInput(t) {
  const c = t % 40;
  const cx = view.W / 2;
  const cy = view.H * 0.7;
  let lead;
  let tool = null;
  if (c < 4) {
    lead = demoHand(cx + Math.sin(t * 1.1) * view.W * 0.25, cy, [0, 1, 3, 7, 15, 31][Math.floor(c * 1.5)], 1);
    // Turn the hand over and back once: the figure spins with it and keeps turning for a while.
    if (c > 2.4 && c < 3.2) lead.flip = 8 * Math.sin(((c - 2.4) / 0.8) * Math.PI);
  } else if (c < 7) {
    lead = demoHand(cx, cy, 4, 1);
  } else if (c < 12) {
    lead = demoHand(cx - 50, cy, [0, 1, 3, 7, 15, 31][Math.floor(c - 7)], 1);
    tool = demoHand(cx + 50, cy, 0, -1);
  } else if (c < 24) {
    const sep = Math.min(1, (c - 12) / 1.5);
    const level = Math.floor((c - 12) / 1.7) % 7;
    const mask = (n) => 0b00011 | ((0b11100 >> (3 - Math.min(n, 3))) & 0b11100);
    lead = demoHand(cx - 50 - 170 * sep, cy, mask(Math.min(level, 3)), 1);
    tool = demoHand(cx + 50 + 170 * sep, cy, mask(Math.max(level - 3, 0)), -1);
  } else {
    if (c < 25) demoSwapped = false; // hands leave the frame for a second, which ends the portal
    // Two hands far apart; a flick of the lead hand toward the other one every 3 s.
    const left = demoHand(cx - 330, cy, 31, 1);
    const right = demoHand(cx + 330, cy, 31, -1);
    const [a, b] = demoSwapped ? [right, left] : [left, right];
    const dir = Math.sign(b.x - a.x);
    const phase = c < 25 ? 9 : (c - 25) % 3;
    if (phase < 0.4) a.pvx = dir * 2200;
    lead = a;
    tool = c >= 25 && c < 34 ? b : null; // the last seconds: nobody to catch it
    if (!tool) a.pvx = phase < 0.4 ? 2200 : 0; // no hand ahead: the figure comes back
  }
  return { lead, tool, hands: [] };
}

async function openCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
  });
  video.srcObject = stream;
  await video.play();
}

async function main() {
  let read;
  if (new URLSearchParams(location.search).has('demo')) {
    read = (now) => demoInput(now / 1000);
    sim.swapHands = () => (demoSwapped = !demoSwapped);
  } else {
    const [, tracker] = await Promise.all([openCamera(), startTracking(video, view)]);
    read = tracker.read;
    sim.swapHands = tracker.swap;
  }

  let last = performance.now();
  // Simulation clock: advances by the clamped dt, so a dropped frame never makes anything jump.
  let simTime = 0;
  let fps = 60;
  let frame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const rawDt = (now - last) / 1000;
    last = now;
    const input = read(now);
    // Substeps keep the springs stable when a frame is dropped.
    const dt = Math.min(rawDt, 0.05);
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < n; i++) {
      simTime += dt / n;
      sim.step(input, dt / n, simTime);
    }
    present(dt, simTime);
    renderer.render(scene, camera);
    drawHands(input.hands);

    fps += (1 / Math.max(rawDt, 1e-3) - fps) * 0.05;
    if (frame++ % 10 === 0) {
      statusEl.style.opacity = input.lead ? 0 : 1;
      statusEl.textContent = 'Покажите руку в кадр';
      const modeName = { single: 'одна рука', joined: 'руки вместе', portal: 'портал' }[S.mode];
      hud.textContent = input.lead
        ? `${S.flight ? `бросок (${S.flight.phase})` : modeName} · ведущая рука: ${input.lead.fingers} · вторая рука: ${input.tool ? `масштаб ×${S.scale.toFixed(2)}` : 'нет'} · ${fps.toFixed(0)} fps`
        : `${fps.toFixed(0)} fps`;
    }
  }
  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  statusEl.style.opacity = 1;
  statusEl.textContent =
    err.name === 'NotAllowedError'
      ? 'Нет доступа к камере. Разрешите камеру для этой страницы и обновите её.'
      : `Не удалось запустить: ${err.message}`;
});
