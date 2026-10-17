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
  spinFriction: 0.7, // spin decay: a hard twist keeps the figure turning for a few revolutions
  spinGain: 0.84, // figure angular speed / hand angular speed while the hand turns
  maxBlur: 3.5,
  // Distances between the two palms, in palm sizes. The gap between the thresholds is hysteresis.
  joinAt: 2.0, // closer than this: hands joined
  portalAt: 2.8, // joined, then pulled further apart than this: portal
  leaveAt: 1.8, // portal, then brought closer than this: back to joined
};

// Throwing the figure: a fast sideways flick of the lead hand sends it flying.
// The flight is a chain of smooth legs (cubic Hermite curves): position and velocity stay continuous
// from launch to landing, and each leg ends at rest on its target, so the hand-off back to the
// follow spring is seamless too.
const THROW = {
  speed: 9, // wrist speed that counts as a flick, in palm sizes per second...
  minSpeed: 900, // ...and never below this, px/s
  ratio: 1.6, // sideways speed must beat vertical speed by this factor
  launchMin: 900, // px/s
  launchMax: 1600,
  cruise: 0.75, // leg duration = distance / (cruise * launch speed)
  legMin: 0.32, // s
  legMax: 0.9,
  reach: 0.38, // with no hand to catch it, the figure flies this fraction of the screen width out
  lift: 0.35, // upward arc: initial vertical speed as a fraction of the horizontal one
  boost: 30000, // px/s^2, launch acceleration: reaches full speed in ~50 ms without a jump
  spin: 11, // rad/s while flying
  cooldown: 0.7, // s after a landing before the next throw
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
let flight = null; // { dir, speed, phase: 'out' | 'home' | 'back', leg, outX, outY }
let cooldown = 0;
let middle = false;
let lastAnchor = null; // where the figure would rest, kept while the hand is briefly lost mid-flight
let scaleHeld = 1; // after a catch the scale eases from this value to what the new tool hand says
let scaleEase = 1;
const bank = { x: 0, z: 0 };
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
  // A tool that is briefly missing (inside its grace period) keeps the mode, so it does not flicker.
  if (!lead || !tool) return 'single';
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

// Starts a flight leg from the current position and velocity, so velocity never jumps between legs.
// A fast approach gets a shorter leg, so the curve does not overshoot its target.
function startLeg(vx, vy, ex, ey) {
  const d = Math.hypot(ex - pos.x, ey - pos.y);
  let T = clamp(d / (THROW.cruise * flight.speed), THROW.legMin, THROW.legMax);
  const along = d > 1 ? (vx * (ex - pos.x) + vy * (ey - pos.y)) / d : 0;
  if (along > 0) T = Math.max(0.15, Math.min(T, (1.4 * d) / along));
  flight.leg = { x0: pos.x, y0: pos.y, vx, vy, T, t: 0 };
}

// Advances the leg towards a (possibly moving) end point; sets pos and vel. Returns true at the end.
function legStep(L, ex, ey, dt) {
  L.t = Math.min(L.t + dt, L.T);
  const s = L.t / L.T;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = (s3 - 2 * s2 + s) * L.T;
  const h01 = 3 * s2 - 2 * s3;
  const d00 = (6 * s2 - 6 * s) / L.T;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = (6 * s - 6 * s2) / L.T;
  pos.x = h00 * L.x0 + h10 * L.vx + h01 * ex;
  pos.y = h00 * L.y0 + h10 * L.vy + h01 * ey;
  vel.x = d00 * L.x0 + d10 * L.vx + d01 * ex;
  vel.y = d00 * L.y0 + d10 * L.vy + d01 * ey;
  return s >= 1;
}

const restOver = (h) => ({ x: h.x, y: h.y - h.size * CFG.hover });

function launch(lead, tool) {
  const dir = Math.sign(lead.pvx);
  const speed = clamp(Math.abs(lead.pvx) * 0.9, THROW.launchMin, THROW.launchMax);
  const m = radius * scale * 1.2;
  flight = {
    dir,
    speed,
    phase: tool && (tool.x - pos.x) * dir > 0 ? 'home' : 'out',
    outX: clamp(pos.x + dir * view.W * THROW.reach, m, view.W - m),
    outY: pos.y,
    // Launch: speed up to the throw velocity with a bounded acceleration, then follow the curve.
    boost: { x: dir * speed, y: -speed * THROW.lift },
    leg: null,
  };
}

// One flight step. Returns 'caught' when the other hand has taken the figure.
function fly(tool, rest, dt) {
  const f = flight;
  // A hand showing up on the far side catches the figure; a catcher that disappears sends it back.
  if (f.phase === 'out' && tool && (tool.x - pos.x) * f.dir > 0) {
    f.phase = 'home';
    if (f.leg) startLeg(vel.x, vel.y, restOver(tool).x, restOver(tool).y);
  } else if (f.phase === 'home' && !tool) {
    f.phase = 'back';
    if (f.leg) startLeg(vel.x, vel.y, rest.x, rest.y);
  }
  omega.y += (f.dir * THROW.spin - omega.y) * (1 - Math.exp(-5 * dt));
  const end = f.phase === 'home' ? restOver(tool) : f.phase === 'out' ? { x: f.outX, y: f.outY } : rest;

  if (f.boost) {
    const dvx = f.boost.x - vel.x;
    const dvy = f.boost.y - vel.y;
    const dv = Math.hypot(dvx, dvy);
    const k = Math.min(1, (THROW.boost * dt) / (dv || 1));
    vel.x += dvx * k;
    vel.y += dvy * k;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    if (k === 1) {
      f.boost = null;
      startLeg(vel.x, vel.y, end.x, end.y);
    }
    return null;
  }

  if (!legStep(f.leg, end.x, end.y, dt)) return null;
  if (f.phase === 'out') {
    // Reached the far point: boomerang back to the hand that threw it.
    f.phase = 'back';
    startLeg(0, 0, rest.x, rest.y);
    return null;
  }
  flight = null;
  cooldown = THROW.cooldown;
  return f.phase === 'home' ? 'caught' : 'back';
}

// Turning a hand turns the figure: twisting in the screen plane rolls it around the view axis,
// turning the hand over spins it around the hand's own up axis. It keeps spinning afterwards and slows down.
const handAxis = new THREE.Vector3();
function handSpin(h, dt) {
  if (!h?.fresh) return;
  // Ignored while the hand is opening/closing so scaling does not spin the figure.
  const steady = 1 - smoothstep(1, 2.5, Math.abs(h.openRate));
  const kTwist = 1 - Math.exp(-14 * smoothstep(1, 5, Math.abs(h.twist)) * h.twistW * steady * dt);
  omega.z += (-h.twist * CFG.spinGain - omega.z) * kTwist;
  const kFlip = 1 - Math.exp(-14 * smoothstep(1, 5, Math.abs(h.flip)) * h.flipW * steady * dt);
  handAxis.set(h.up.x, h.up.y, h.up.z);
  omega.addScaledVector(handAxis, (h.flip * CFG.spinGain - omega.dot(handAxis)) * kFlip);
}

function step(input, dt, t) {
  let { lead, tool } = input;
  cooldown = Math.max(0, cooldown - dt);
  // While the figure is in the air nothing else changes: no mode switches, no morphs.
  if (!flight) {
    mode = nextMode(lead, tool);
    // After a catch the figure keeps its shape until the catching hand changes its gesture.
    if (shapeLock && (!lead || lead.mask !== shapeLock.mask || mode !== 'single')) shapeLock = null;
    if (!shapeLock) {
      middle = mode === 'single' && !!lead && isMiddle(lead.mask);
      if (lead) solidKey = mode === 'joined' ? SOLID_KEYS[Math.min(lead.fingers, 5)] : middle ? MIDDLE : null;
    }
  }
  const joined = mode === 'joined';
  portalPts = mode === 'portal' ? portalCorners(lead, tool) : null;
  portalLevel = mode === 'portal' ? popcount(lead.mask & 0b11100) + popcount(tool.mask & 0b11100) : 0;
  vPrism += ((mode === 'single' && !middle ? 1 : 0) - vPrism) * (1 - Math.exp(-10 * dt));

  // Joined hands act as one: the figure hangs above the point between them.
  if (lead) {
    lastAnchor = joined
      ? { x: (lead.x + tool.x) / 2, y: (lead.y + tool.y) / 2, size: (lead.size + tool.size) / 2 }
      : { x: lead.x, y: lead.y, size: lead.size };
  }
  const a = lead || flight ? lastAnchor : null;

  if (a) {
    radius += (a.size * CFG.radius - radius) * (1 - Math.exp(-10 * dt));
    // Target: above the hand, with a small orbit and bob so it never sits dead still.
    const rest = {
      x: a.x + Math.cos(t * 1.7) * a.size * 0.12,
      y: a.y - a.size * CFG.hover + Math.sin(t * 2.3) * a.size * 0.08,
    };
    if (visibility < 0.05 && !flight) {
      pos.x = rest.x;
      pos.y = rest.y;
      vel.x = vel.y = 0;
      pop = 0.3;
    }
    visibility += (1 - visibility) * (1 - Math.exp(-8 * dt));

    if (flight) {
      if (fly(tool, rest, dt) === 'caught' && tool) {
        // The receiving hand leads now, the thrower becomes the tool.
        swapHands();
        [lead, tool] = [tool, lead];
        [input.lead, input.tool] = [lead, tool];
        // Keep the shape and the size: they only change once the new hands actually ask for it.
        if (lead) shapeLock = { key: shapeKey, mask: lead.mask };
        scaleHeld = scale;
        scaleEase = 0;
        pulse = Math.max(pulse, 0.35);
        popV += 2.5;
      }
    } else {
      vel.x += (CFG.followK * (rest.x - pos.x) - CFG.followC * vel.x) * dt;
      vel.y += (CFG.followK * (rest.y - pos.y) - CFG.followC * vel.y) * dt;
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;
      const flick =
        lead.fresh &&
        Math.abs(lead.pvx) > Math.max(THROW.minSpeed, lead.size * THROW.speed) &&
        Math.abs(lead.pvx) > Math.abs(lead.pvy) * THROW.ratio;
      // Bringing the hands together fast is joining them, not a throw.
      const close = tool && Math.hypot(lead.x - tool.x, lead.y - tool.y) < CFG.portalAt * (lead.size + tool.size) * 0.5;
      if (mode === 'single' && !cooldown && visibility > 0.5 && flick && !close) {
        launch(lead, tool);
      }
    }

    if (lead && !flight) {
      const key = shapeLock
        ? shapeLock.key
        : mode === 'portal'
          ? 'portal'
          : joined
            ? `j${lead.fingers}`
            : middle
              ? 'm'
              : `s${lead.fingers}`;
      if (key !== shapeKey) {
        const first = shapeKey === '';
        shapeKey = key;
        if (mode === 'single' && !middle && !shapeLock) figure.setSides(lead.fingers);
        if (!first && mode !== 'portal') {
          pulse = 1;
          popV += 5;
          omega.y += 5;
        }
      }
    }
  } else {
    vel.y += CFG.gravity * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    visibility *= Math.exp(-4 * dt);
  }

  if (!flight && mode !== 'portal') {
    handSpin(lead, dt);
    handSpin(tool, dt);
  }
  if (mode === 'single' && tool?.fresh && !flight) {
    const goal = CFG.scaleMin + (CFG.scaleMax - CFG.scaleMin) * tool.open;
    scaleEase = Math.min(1, scaleEase + dt / 0.8);
    scaleTarget = scaleHeld + (goal - scaleHeld) * smoothstep(0, 1, scaleEase);
    // Trackball: fast finger flicks drag the surface, slow return strokes barely touch it.
    const steady = 1 - smoothstep(1, 2.5, Math.abs(tool.openRate));
    const r = Math.max(40, radius * scale);
    // Not right after a landing: the hand that just threw is still moving and must not spin the figure.
    const wSwipe = cooldown ? 0 : smoothstep(150, 900, Math.hypot(tool.vx, tool.vy)) * steady;
    const kSwipe = 1 - Math.exp(-14 * wSwipe * dt);
    omega.x += ((tool.vy / r) * CFG.spinGain - omega.x) * kSwipe;
    omega.y += ((tool.vx / r) * CFG.spinGain - omega.y) * kSwipe;
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
  // Lean into the motion, like something light being dragged through the air. Smoothed, so a throw
  // (a sudden change of velocity) tilts the figure over a few frames instead of snapping it.
  const kBank = 1 - Math.exp(-10 * dt);
  bank.x += (clamp(vel.y * 0.00045, -0.5, 0.5) - bank.x) * kBank;
  bank.z += (clamp(vel.x * 0.00045, -0.5, 0.5) - bank.z) * kBank;
  qBank.setFromEuler(euler.set(bank.x, 0, bank.z));

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

  // Motion blur stays light: the figure must remain readable while it flies and spins.
  const blurTarget =
    clamp(speed / 1100 + spin * 0.12 + Math.abs(scaleV) * 0.4 + pulse * 2, 0, CFG.maxBlur) * (mode === 'portal' ? 0.15 : 1);
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
    swapHands = () => (demoSwapped = !demoSwapped);
  } else {
    const [, tracker] = await Promise.all([openCamera(), startTracking(video, view)]);
    read = tracker.read;
    swapHands = tracker.swap;
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
      step(input, dt / n, simTime);
    }
    present(dt, simTime);
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
