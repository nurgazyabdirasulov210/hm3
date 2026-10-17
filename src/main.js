import * as THREE from 'three';
import { createFigure } from './figure.js';
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
};

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
let sides = -1;
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

function step(input, dt, t) {
  const { lead, tool } = input;

  if (lead) {
    radius += (lead.size * CFG.radius - radius) * (1 - Math.exp(-10 * dt));
    // Target: above the hand, with a small orbit and bob so it never sits dead still.
    const tx = lead.x + Math.cos(t * 1.7) * lead.size * 0.12;
    const ty = lead.y - lead.size * CFG.hover + Math.sin(t * 2.3) * lead.size * 0.08;
    if (visibility < 0.05) {
      pos.x = tx;
      pos.y = ty;
      vel.x = vel.y = 0;
      pop = 0.3;
    }
    vel.x += (CFG.followK * (tx - pos.x) - CFG.followC * vel.x) * dt;
    vel.y += (CFG.followK * (ty - pos.y) - CFG.followC * vel.y) * dt;
    visibility += (1 - visibility) * (1 - Math.exp(-8 * dt));

    if (lead.fingers !== sides) {
      const first = sides < 0;
      sides = lead.fingers;
      figure.setSides(sides);
      if (!first) {
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

  if (tool?.fresh) {
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
function present(dt) {
  const speed = Math.hypot(vel.x, vel.y);
  const spin = omega.length();
  const pose = poses.length > figure.ghosts ? poses.pop() : { q: new THREE.Quaternion() };
  pose.x = pos.x;
  pose.y = -pos.y;
  pose.r = Math.max(1, radius * scale * pop);
  pose.q.copy(qBank).multiply(qUser).multiply(qTilt).multiply(qSpin);
  poses.unshift(pose);
  figure.place(poses, visibility, clamp(speed / 700 + spin / 8 + pulse, 0, 1));

  const blurTarget = clamp(speed / 450 + spin * 0.35 + Math.abs(scaleV) * 0.5 + pulse * 4, 0, CFG.maxBlur);
  blur += (blurTarget - blur) * (1 - Math.exp(-18 * dt));
  const glow = `drop-shadow(0 0 12px #${figure.color.getHexString()})`;
  sceneCanvas.style.filter = blur > 0.25 ? `blur(${blur.toFixed(2)}px) ${glow}` : glow;
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
function demoInput(t) {
  const fast = Math.sin(t * 0.5) > 0.3 ? 2 : 0.6;
  return {
    lead: {
      x: view.W / 2 + Math.sin(t * 1.1 * fast) * view.W * 0.25,
      y: view.H * 0.7 + Math.cos(t * 0.8) * view.H * 0.08,
      size: 110,
      fingers: Math.floor(t / 2) % 6,
    },
    tool: t % 12 > 6 && {
      open: 0.5 + 0.5 * Math.sin(t * 1.5),
      openRate: 0.75 * Math.cos(t * 1.5),
      vx: 700 * Math.sin(t * 2),
      vy: 0,
      twist: 0,
      fresh: true,
    },
    hands: [],
  };
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
  } else {
    const [, tracker] = await Promise.all([openCamera(), startTracking(video, view)]);
    read = tracker.read;
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
    present(dt);
    renderer.render(scene, camera);
    drawHands(input.hands);

    fps += (1 / Math.max(rawDt, 1e-3) - fps) * 0.05;
    if (frame++ % 10 === 0) {
      statusEl.style.opacity = input.lead ? 0 : 1;
      statusEl.textContent = 'Покажите руку в кадр';
      hud.textContent = input.lead
        ? `ведущая рука: ${input.lead.fingers} · вторая рука: ${input.tool ? `масштаб ×${scale.toFixed(2)}` : 'нет'} · ${fps.toFixed(0)} fps`
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
