import * as THREE from 'three';
import { createFigure } from './figure.js';
import { createSolids, SOLID_KEYS, MIDDLE } from './shapes.js';
import { createPortal } from './portal.js';
import { startTracking } from './hands.js';
import { clamp, smoothstep } from './filters.js';

const CFG = {
  hover: 2.3, // figure hovers this many palm lengths above the palm centre
  radius: 0.8, // figure radius in palm lengths at scale 1
  followK: 180, // position spring: stiff enough to feel responsive...
  followC: 16, // ...underdamped enough to trail and overshoot a little
  gravity: 1400, // px/s^2, pulls the figure down once the lead hand is gone
  scaleMin: 0.35,
  scaleMax: 3.2,
  idleSpin: 0.9, // rad/s
  spinFriction: 0.7,
  spinGain: 0.84,
  maxBlur: 6,
  // Distances between the two palms, in palm sizes. The gap between the thresholds is hysteresis.
  joinAt: 2.0, // closer than this: hands joined
  portalAt: 2.8, // joined, then pulled further apart than this: portal
  leaveAt: 1.8, // portal, then brought closer than this: back to joined
};

// Throwing the figure: a fast sideways palm flick sends it flying.
const THROW = {
  speed: 9, // palm sizes per second
  minSpeed: 900, // px/s
  ratio: 1.5, // sideways must beat vertical by this factor
  launch: 1900, // px/s at least
  outTime: 0.5, // s of free flight before the figure comes back (no hand to catch it)
  cooldown: 0.7, // s after a catch or return before the next throw
  homeK: 90,
  homeC: 14,
  backK: 70,
  backC: 12,
  maxSpeed: 3500,
};

const GLOW = { single: null, joined: new THREE.Color(0xb28dff), middle: new THREE.Color(0xff5a5a), portal: new THREE.Color(0xff9a2e) };
const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);
// Only the middle finger up (the thumb is too unreliable to count).
const isMiddle = (m) => (m & 4) !== 0 && (m & 0b11010) === 0;

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

// --- simulation state -------------------------------------------------------
const pos = { x: view.W / 2, y: view.H / 2 };
const vel = { x: 0, y: 0 };
let radius = 90;
let scale = 1;
let scaleV = 0;
let scaleTarget = 1;
let pop = 1; // extra scale spring used for appear / morph "pop"
let popV = 0;
let visibility = 0;
let pulse = 0; // decaying kick after the shape changes
let blur = 0;
let shapeKey = '';
let shapeLock = null;
let mode = 'single'; // 'single' | 'joined' | 'portal'
let vPrism = 0;
let solidKey = null;
let flight = null; // { dir, t, phase: 'out' | 'home' | 'back' }
let cooldown = 0;
let swapHands = () => {};
let portalPts = null;
let portalLevel = 0;
const glow = new THREE.Color(0xc8d8ff);
let spinY = 0;
const omega = new THREE.Vector3();
const qUser = new THREE.Quaternion();
const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
const qSpin = new THREE.Quaternion();
const qBank = new THREE.Quaternion();
const dq = new THREE.Quaternion();
const axis = new THREE.Vector3();
const euler = new THREE.Euler();
const Y = new THREE.Vector3(0, 1, 0);
const poses = [];

function nextMode(lead, tool) {
  if (!lead || !tool?.fresh) return 'single';
  const d = Math.hypot(lead.x - tool.x, lead.y - tool.y) / ((lead.size + tool.size) / 2);
  if (mode === 'single') return d < CFG.joinAt ? 'joined' : 'single';
  if (mode === 'joined') return d > CFG.portalAt ? 'portal' : 'joined';
  return d < CFG.leaveAt ? 'joined' : 'portal';
}

// Four corners in loop order: two fingertips (thumb, index) of each hand.
function portalCorners(lead, tool) {
  const [lt, li, tt, ti] = [lead.pts[4], lead.pts[8], tool.pts[4], tool.pts[8]];
  const parallel = (li.x - lt.x) * (ti.x - tt.x) + (li.y - lt.y) * (ti.y - tt.y) >= 0;
  return parallel ? [lt, li, ti, tt] : [lt, li, tt, ti];
}

function step(input, dt, t) {
  let { lead, tool } = input;
  mode = nextMode(lead, tool);
  if (flight && (mode !== 'single' || !lead)) flight = null;
  cooldown = Math.max(0, cooldown - dt);
  const joined = mode === 'joined';
  const middle = mode === 'single' && !!lead && isMiddle(lead.mask);
  portalPts = mode === 'portal' ? portalCorners(lead, tool) : null;
  portalLevel = mode === 'portal' ? popcount(lead.mask & 0b11100) + popcount(tool.mask & 0b11100) : 0;
  vPrism += ((mode === 'single' && !middle ? 1 : 0) - vPrism) * (1 - Math.exp(-10 * dt));

  if (lead) {
    // Joined hands act as one: the figure hangs above the point between them.
    const a = joined
      ? { x: (lead.x + tool.x) / 2, y: (lead.y + tool.y) / 2, size: (lead.size + tool.size) / 2 }
      : lead;
    solidKey = joined ? SOLID_KEYS[Math.min(lead.fingers, 5)] : middle ? MIDDLE : null;
    radius += (a.size * CFG.radius - radius) * (1 - Math.exp(-10 * dt));
    // Target: above the hand, with a small orbit and bob so it never sits dead still.
    const tx = a.x + Math.cos(t * 1.7) * a.size * 0.12;
    const ty = a.y - a.size * CFG.hover + Math.sin(t * 2.3) * a.size * 0.08;
    if (visibility < 0.05) {
      pos.x = tx;
      pos.y = ty;
      vel.x = vel.y = 0;
      pop = 0.3;
    }
    if (flight) {
      flight.t += dt;
      const hasTool = !!tool?.fresh;
      const ahead = hasTool && (tool.x - pos.x) * flight.dir > 0;
      if (flight.phase === 'home' && !hasTool) flight.phase = 'back';
      else if (flight.phase === 'out' && ahead) flight.phase = 'home';
      else if (flight.phase === 'out' && flight.t > THROW.outTime) flight.phase = 'back';
      omega.y += (flight.dir * 14 - omega.y) * (1 - Math.exp(-6 * dt));

      if (flight.phase === 'out') {
        // Free flight with a little drag; bounces off the screen edges.
        const k = Math.exp(-1.2 * dt);
        vel.x *= k;
        vel.y *= k;
        const m = radius * scale;
        if ((pos.x < m && vel.x < 0) || (pos.x > view.W - m && vel.x > 0)) vel.x *= -0.7;
        if ((pos.y < m && vel.y < 0) || (pos.y > view.H - m && vel.y > 0)) vel.y *= -0.7;
      } else if (flight.phase === 'home') {
        const hx = tool.x;
        const hy = tool.y - tool.size * CFG.hover;
        vel.x += (THROW.homeK * (hx - pos.x) - THROW.homeC * vel.x) * dt;
        vel.y += (THROW.homeK * (hy - pos.y) - THROW.homeC * vel.y) * dt;
        if (flight.t > 0.12 && Math.hypot(hx - pos.x, hy - pos.y) < tool.size * 0.9) {
          // Caught: the receiving hand leads, the thrower becomes the tool.
          swapHands();
          [lead, tool] = [tool, lead];
          [input.lead, input.tool] = [lead, tool];
          flight = null;
          cooldown = THROW.cooldown;
          pulse = 1;
          popV += 6;
          shapeLock = { key: shapeKey, mask: lead.mask };
        }
      } else {
        vel.x += (THROW.backK * (tx - pos.x) - THROW.backC * vel.x) * dt;
        vel.y += (THROW.backK * (ty - pos.y) - THROW.backC * vel.y) * dt;
        if (Math.hypot(tx - pos.x, ty - pos.y) < lead.size * 0.8 && flight.t > 0.3) {
          flight = null;
          cooldown = THROW.cooldown * 0.6;
        }
      }
      const sp = Math.hypot(vel.x, vel.y);
      if (sp > THROW.maxSpeed) {
        vel.x *= THROW.maxSpeed / sp;
        vel.y *= THROW.maxSpeed / sp;
      }
    } else {
      vel.x += (CFG.followK * (tx - pos.x) - CFG.followC * vel.x) * dt;
      vel.y += (CFG.followK * (ty - pos.y) - CFG.followC * vel.y) * dt;
      const fast = Math.abs(lead.pvx) > Math.max(THROW.minSpeed, lead.size * THROW.speed);
      if (mode === 'single' && !cooldown && visibility > 0.5 && fast && Math.abs(lead.pvx) > Math.abs(lead.pvy) * THROW.ratio) {
        const dir = Math.sign(lead.pvx);
        flight = { dir, t: 0, phase: 'out' };
        vel.x = dir * Math.max(THROW.launch, Math.abs(lead.pvx) * 1.2);
        vel.y = clamp(lead.pvy * 0.4, -400, 400);
        omega.y = dir * 16;
        pulse = 1;
      }
    }
    visibility += (1 - visibility) * (1 - Math.exp(-8 * dt));

    let key = mode === 'portal' ? 'portal' : joined ? `j${lead.fingers}` : middle ? 'm' : `s${lead.fingers}`;
    // After a catch the figure keeps its shape until the catching hand changes its gesture.
    if (shapeLock && lead.mask !== shapeLock.mask) shapeLock = null;
    if (shapeLock) key = shapeLock.key;
    if (key !== shapeKey) {
      const first = shapeKey === '';
      shapeKey = key;
      if (mode === 'single' && !middle) figure.setSides(lead.fingers);
      if (!first && mode !== 'portal') {
        pulse = 1;
        popV += 5;
        omega.y += 5;
      }
    }
  } else {
    vel.y += CFG.gravity * dt;
    visibility *= Math.exp(-4 * dt);
  }
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;

  if (mode === 'single' && tool?.fresh && !flight) {
    scaleTarget = CFG.scaleMin + (CFG.scaleMax - CFG.scaleMin) * tool.open;
    // Trackball: fast finger flicks drag the surface, slow return strokes barely touch it.
    // Ignored while the hand is opening/closing so scaling does not spin the figure.
    const steady = 1 - smoothstep(1, 2.5, Math.abs(tool.openRate));
    const r = Math.max(40, radius * scale);
    const wSwipe = smoothstep(150, 900, Math.hypot(tool.vx, tool.vy)) * steady;
    const kSwipe = 1 - Math.exp(-14 * wSwipe * dt);
    omega.x += ((tool.vy / r) * CFG.spinGain - omega.x) * kSwipe;
    omega.y += ((tool.vx / r) * CFG.spinGain - omega.y) * kSwipe;
    const kTwist = 1 - Math.exp(-14 * smoothstep(1, 5, Math.abs(tool.twist)) * steady * dt);
    omega.z += (-tool.twist * CFG.spinGain - omega.z) * kTwist;
  }
  if (mode !== 'single') scaleTarget = 1;
  scaleV += (320 * (scaleTarget - scale) - 20 * scaleV) * dt;
  scale += scaleV * dt;
  popV += (260 * (1 - pop) - 14 * popV) * dt;
  pop += popV * dt;

  omega.clampLength(0, 21).multiplyScalar(Math.exp(-CFG.spinFriction * dt));
  const angle = omega.length() * dt;
  if (angle > 1e-6) qUser.premultiply(dq.setFromAxisAngle(axis.copy(omega).normalize(), angle)).normalize();
  spinY += CFG.idleSpin * dt;
  qSpin.setFromAxisAngle(Y, spinY);
  // Lean into the motion, like something light being dragged through the air.
  qBank.setFromEuler(euler.set(clamp(vel.y * 0.00045, -0.5, 0.5), 0, clamp(vel.x * 0.00045, -0.5, 0.5)));

  figure.update(dt);
  pulse *= Math.exp(-5 * dt);
}

// Once per rendered frame: record the pose for the ghost trail and set the blur.
function present(dt, t) {
  const speed = Math.hypot(vel.x, vel.y);
  const spin = omega.length();
  const pose = poses.length > figure.ghosts ? poses.pop() : { q: new THREE.Quaternion() };
  pose.x = pos.x;
  pose.y = -pos.y;
  pose.r = Math.max(1, radius * scale * pop);
  pose.q.copy(qBank).multiply(qUser).multiply(qTilt).multiply(qSpin);
  poses.unshift(pose);
  figure.place(poses, visibility * vPrism, clamp(speed / 700 + spin / 8 + pulse, 0, 1));

  const target = GLOW[mode === 'portal' ? 'portal' : mode === 'joined' ? 'joined' : solidKey === MIDDLE ? 'middle' : 'single'] ?? figure.color;
  glow.lerp(target, 1 - Math.exp(-8 * dt));
  solids.place(solidKey, pose, visibility, glow, dt);
  portal.update(portalPts, portalLevel, dt, t, GLOW.portal);

  const blurTarget = clamp(speed / 450 + spin * 0.35 + Math.abs(scaleV) * 0.5 + pulse * 4, 0, CFG.maxBlur) * (mode === 'portal' ? 0.15 : 1);
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
  return { x, y, size: 110, fingers: popcount(mask), mask, pts, pvx, pvy: 0, open: 1, openRate: 0, vx: 0, vy: 0, twist: 0, fresh: true };
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
    lead.fingers = Math.floor(c * 1.5);
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
    swapHands = () => (demoSwapped = !demoSwapped);
  } else {
    const [, tracker] = await Promise.all([openCamera(), startTracking(video, view)]);
    read = tracker.read;
    swapHands = tracker.swap;
  }

  let last = performance.now();
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
    for (let i = 0; i < n; i++) step(input, dt / n, now / 1000 - dt + ((i + 1) * dt) / n);
    present(dt, now / 1000);
    renderer.render(scene, camera);
    drawHands(input.hands);

    fps += (1 / Math.max(rawDt, 1e-3) - fps) * 0.05;
    if (frame++ % 10 === 0) {
      statusEl.style.opacity = input.lead ? 0 : 1;
      statusEl.textContent = 'Покажите руку в кадр';
      const modeName = { single: 'одна рука', joined: 'руки вместе', portal: 'портал' }[mode];
      hud.textContent = input.lead
        ? `${flight ? `бросок (${flight.phase})` : modeName} · ведущая рука: ${input.lead.fingers} · вторая рука: ${input.tool ? `масштаб ×${scale.toFixed(2)}` : 'нет'} · ${fps.toFixed(0)} fps`
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
