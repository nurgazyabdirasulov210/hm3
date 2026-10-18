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
const solidTint = glow.clone();
const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
const poses = [];
const spare = [];

// Once per rendered frame: record the pose for the ghost trail and set the blur.
function present(dt, t) {
  const { pos, vel, omega, mode } = S;
  const speed = Math.hypot(vel.x, vel.y);
  const spin = omega.length();
  // Keep just enough history for the ghost trail (plus one older frame to interpolate from).
  while (poses.length > 2 && t - poses[poses.length - 2].t > figure.trail) spare.push(poses.pop());
  const pose = spare.pop() ?? { q: new THREE.Quaternion() };
  pose.t = t;
  pose.x = pos.x;
  pose.y = -pos.y;
  pose.r = Math.max(1, S.radius * S.scale * S.pop);
  pose.q.copy(S.qBank).multiply(S.qUser).multiply(qTilt).multiply(S.qSpin);
  poses.unshift(pose);
  figure.place(poses, S.visibility * S.vPrism, clamp(speed / 700 + spin / 8 + S.pulse, 0, 1));

  const target = GLOW[mode === 'portal' ? 'portal' : mode === 'joined' ? 'joined' : S.solidKey === MIDDLE ? 'middle' : 'single'] ?? figure.color;
  glow.lerp(target, 1 - Math.exp(-8 * dt));
  // A solid keeps its own tint while it fades out, instead of taking on the next mode's colour (brown, grey).
  if (S.solidKey) solidTint.lerp(target, 1 - Math.exp(-8 * dt));
  solids.place(S.solidKey, pose, S.visibility, solidTint, dt);
  portal.update(S.portalPts, S.portalLevel, dt, t, GLOW.portal);

  // Motion blur stays light: the figure must remain readable while it flies and spins.
  const blurTarget =
    clamp(speed / 1500 + spin * 0.06 + Math.abs(S.scaleV) * 0.4 + S.pulse * 0.8, 0, CFG.maxBlur) * (mode === 'portal' ? 0.15 : 1);
  blur += (blurTarget - blur) * (1 - Math.exp(-18 * dt));
  const glowCss = `drop-shadow(0 0 12px #${glow.getHexString()})`;
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
const ease = (t, a, b) => (t <= a ? 0 : t >= b ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (t - a)) / (b - a)));
const FINGER_MASKS = [0, 1, 3, 7, 15, 31]; // 0..5 raised fingers

// Schematic hand for the skeleton overlay. Thumb (4) and index (8) tips sit on the inner side of the hand
// (side +1: toward +x); `frame` (0..1) turns them into the "L" of the portal gesture: index up, thumb down.
function demoPts(x, y, s, mask, side, frame) {
  const pts = Array.from({ length: 21 }, () => ({ x, y }));
  pts[0] = { x, y: y + 0.5 * s };
  const finger = (base, kx, ky, up, len) => {
    for (let j = 0; j < 4; j++) {
      const f = j / 3;
      pts[base + j] = up
        ? { x: x + side * kx, y: y + ky - len * f }
        : { x: x + side * (kx + 0.08 * s * Math.sin(f * 2.4)), y: y + ky - 0.22 * s * Math.sin(f * 2.4) };
    }
  };
  finger(5, 0.3 * s, -0.3 * s, mask & 2, 0.65 * s);
  finger(9, 0.1 * s, -0.33 * s, mask & 4, 0.72 * s);
  finger(13, -0.1 * s, -0.3 * s, mask & 8, 0.66 * s);
  finger(17, -0.3 * s, -0.24 * s, mask & 16, 0.5 * s);
  // Thumb: from the wrist out sideways when raised (pointing down in the portal gesture), tucked in when not.
  const tx = mask & 1 ? 0.72 + (0.3 - 0.72) * frame : 0.22;
  const ty = mask & 1 ? -0.05 + 0.7 * frame : 0.05;
  for (let j = 1; j <= 4; j++) {
    const f = j / 4;
    pts[j] = { x: x + side * s * (0.12 + (tx - 0.12) * f), y: y + s * (0.35 + (ty - 0.35) * f) };
  }
  return pts;
}

// A hand snapshot with every field the tracker gives the simulation. h: { x, y, mask, side, frame }, v: velocity.
function demoHand(h, v, size, age) {
  return {
    id: h.id,
    age, // ms since the hand came into view
    x: h.x,
    y: h.y,
    size,
    fingers: popcount(h.mask),
    mask: h.mask,
    pts: demoPts(h.x, h.y, size, h.mask, h.side, h.frame ?? 0),
    // Wrist and fingertip velocity: the hand really moves, a flick is a fast sideways motion of the whole hand.
    pvx: v.x,
    pvy: v.y,
    vx: v.x,
    vy: v.y,
    open: (1 - CFG.scaleMin) / (CFG.scaleMax - CFG.scaleMin), // the tool hand asks for scale 1
    openRate: 0,
    twist: 0,
    twistW: 1,
    flip: h.flip ?? 0,
    flipW: 1,
    up: { x: 0, y: 1, z: 0 },
    fresh: true,
  };
}

// Cycle (40 s), every hand moves continuously (no jumps between phases):
//  0– 4  one hand drifting sideways, 0..5 raised fingers (prism shapes); turns over once at ~3 s
//  4– 7  middle finger
//  7–12.6 the second hand comes in, the hands are held together: solids for 0..5 fingers
// 12.6–24.6 pulled apart into the portal, mandala levels 0..6
// 24.6–35 the second hand leaves and comes back on the far side; three throws between the hands (roles swap)
// 35–40 the catcher leaves: a throw with nobody to catch it comes back; the hand returns to the centre
const CYCLE = 40;
const FLICK = { at: 0.4, out: 0.15, hold: 0.1, back: 0.5, reach: 150 }; // a ~1500 px/s sideways flick
let demoSwapped = false;
const demoBorn = {}; // id -> time (s) the hand came into view
let flicker = null; // { slot, right, dir }: the hand flicking in the current throw slot (fixed for the whole slot)

function demoPose(t) {
  const { W, H } = view;
  const c = ((t % CYCLE) + CYCLE) % CYCLE;
  const cx = W / 2;
  const cy = H * 0.7;
  const s = clamp(Math.min(W, H) * 0.14, 60, 110);
  const far = Math.min(330, W * 0.36); // hand offset from the centre while throwing
  let lead;
  let tool = null;
  if (c < 4) {
    const sway = Math.sin((c / 4) * Math.PI * 2) * Math.sin((c / 4) * Math.PI) * Math.min(W, 2000) * 0.2;
    lead = { x: cx + sway, y: cy, mask: FINGER_MASKS[Math.min(5, Math.floor(c / 0.65))], side: 1, id: 'L' };
    // Turn the hand over and back once: the figure spins with it and keeps turning for a while.
    if (c > 2.5 && c < 3.2) lead.flip = 8 * Math.sin(((c - 2.5) / 0.7) * Math.PI);
  } else if (c < 7) {
    lead = { x: cx, y: cy, mask: 4, side: 1, id: 'L' };
  } else if (c < 12.6) {
    const e = ease(c, 7, 7.8);
    const mask = FINGER_MASKS[clamp(Math.floor((c - 8.1) / 0.75), 0, 5)];
    lead = { x: cx - 0.45 * s * e, y: cy, mask, side: 1, id: 'L' };
    tool = { x: cx + (2.3 - 1.85 * e) * s, y: cy, mask: 0, side: -1, id: 'R' };
  } else if (c < 24.6) {
    const e = ease(c, 12.6, 14);
    const half = (0.45 + 1.15 * e) * s;
    // Extra raised fingers (middle, ring, pinky; lead first) set the mandala level.
    const level = clamp(Math.floor((c - 14.2) / 1.45), 0, 6);
    const extra = (n) => 0b00011 | ((0b11100 >> (3 - n)) & 0b11100);
    const open = 2 * half > CFG.portalAt * s; // until the portal opens the hands still show the torus
    lead = { x: cx - half, y: cy, mask: open ? extra(Math.min(level, 3)) : 31, side: 1, frame: e, id: 'L' };
    tool = { x: cx + half, y: cy, mask: open ? extra(Math.max(level - 3, 0)) : 0, side: -1, frame: e, id: 'R' };
  } else {
    // The lead hand moves out to the left; the other hand shows up on the right.
    const settle = ease(c, 24.6, 25.6);
    const home = (right) => cx + (right ? far : -far + (far - 1.6 * s) * (1 - settle));
    const L = { x: home(false), y: cy, mask: 31, side: 1, id: 'L' };
    const R = { x: home(true), y: cy, mask: 31, side: -1, id: 'R' };
    const f = flicker;
    if (f && c >= f.slot) {
      const tau = c - f.slot - FLICK.at;
      const a = FLICK.out + FLICK.hold;
      const d = FLICK.reach * f.dir * (tau < a ? ease(tau, 0, FLICK.out) : 1 - ease(tau, a, a + FLICK.back));
      (f.right ? R : L).x += d;
    }
    const [a, b] = demoSwapped ? [R, L] : [L, R];
    lead = a;
    if (c >= 25.6 && c < 35) tool = b;
    // At the end the hand drifts back to the centre, where the next cycle starts.
    if (c >= 37.8) lead.x += (cx - lead.x) * ease(c, 37.8, 39.6);
    if (c >= 39.6) lead.mask = 0;
  }
  return { lead, tool, s };
}

function demoInput(t) {
  const c = ((t % CYCLE) + CYCLE) % CYCLE;
  if (c < 25.6) {
    demoSwapped = false;
    flicker = null;
  } else if (c < 38) {
    // Throw slots start at 26, 29, 32 (to the other hand) and 35 (nobody to catch it).
    const slot = 26 + 3 * Math.floor((c - 26) / 3);
    if (c >= 26 && flicker?.slot !== slot) {
      const right = demoSwapped;
      const x = right ? view.W / 2 + Math.min(330, view.W * 0.36) : view.W / 2 - Math.min(330, view.W * 0.36);
      let dir = right ? -1 : 1; // toward the other hand
      // Nobody to catch it: toward the near screen edge if there is room for the flick, else across the screen.
      if (slot >= 35 && (right ? view.W - x : x) > FLICK.reach * 1.5) dir = -dir;
      flicker = { slot, right, dir };
    }
  }
  const h = 1 / 240;
  const now = demoPose(t);
  const prev = demoPose(t - h);
  const vel = (p, q) => (p && q ? { x: (p.x - q.x) / h, y: (p.y - q.y) / h } : { x: 0, y: 0 });
  for (const id of ['L', 'R']) {
    if (now.lead.id !== id && now.tool?.id !== id) delete demoBorn[id];
    else demoBorn[id] ??= t;
  }
  const age = (hd) => (t - demoBorn[hd.id]) * 1000;
  const lead = demoHand(now.lead, vel(now.lead, prev.lead), now.s, age(now.lead));
  const tool = now.tool && demoHand(now.tool, vel(now.tool, prev.tool), now.s, age(now.tool));
  return { lead, tool, hands: [lead, tool].filter(Boolean).map((hd) => hd.pts) };
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
    // Scripted on the simulation clock, so a slow machine plays the same motions, only slower.
    read = (now, t) => demoInput(t);
    // Idempotent: the hand with this id leads now (the right one, 'R', means swapped).
    sim.swapHands = (id) => (demoSwapped = id === undefined ? !demoSwapped : id === 'R');
  } else {
    const [, tracker] = await Promise.all([openCamera(), startTracking(video, view)]);
    read = tracker.read;
    sim.swapHands = tracker.swap;
  }

  let last = performance.now();
  // Simulation clock: follows real time, except over long gaps, so a stalled tab never makes anything jump.
  let simTime = 0;
  let fps = 60;
  let frame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const rawDt = (now - last) / 1000;
    last = now;
    // Real time on slow machines too; a long gap (hidden tab, first frame) counts as one ordinary frame.
    const dt = rawDt > 0 && rawDt <= 0.25 ? rawDt : 1 / 60;
    const input = read(now, simTime + dt);
    // Substeps keep the springs stable when a frame is dropped.
    const n = Math.max(1, Math.ceil(dt * 120));
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
      const modeName = S.flight
        ? { out: 'бросок: летит', home: 'бросок: к другой руке', back: 'бросок: возвращается' }[S.flight.phase]
        : S.mode === 'single' && S.solidKey === MIDDLE
          ? 'средний палец'
          : { single: 'одна рука', joined: 'руки вместе', portal: `портал, уровень ${S.portalLevel}` }[S.mode];
      hud.textContent = input.lead
        ? `${modeName} · ведущая рука: ${input.lead.fingers} · вторая рука: ${input.tool ? `масштаб ×${S.scale.toFixed(2)}` : 'нет'} · ${fps.toFixed(0)} fps`
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
