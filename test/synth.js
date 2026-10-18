// Synthetic hands: MediaPipe-shaped HandLandmarker results generated from a few pose parameters,
// so the tracker and the simulation can be driven in Node without a camera.
//
// Conventions follow MediaPipe: image landmarks are normalised 0..1 in the (not mirrored) camera image,
// world landmarks are metres around the hand centre, x right in the camera image, y down, z away from the camera.
// The tracker mirrors the image itself, so pose positions below are given in mirrored screen pixels,
// exactly where the user sees the hand.
import { toScreen } from '../src/tracker.js';

export const VIEW = { W: 1440, H: 900 }; // CSS pixels of a typical laptop screen
export const CAM = { W: 1280, H: 720 }; // webcam resolution, shown with object-fit: cover
export const toPx = (lm) => toScreen(lm, VIEW, CAM.W, CAM.H);

const PALM_M = 0.088; // wrist -> middle knuckle in metres, an adult hand
const DEG = Math.PI / 180;

// Hand skeleton in palm lengths (wrist -> middle knuckle = 1): u across the palm toward the pinky,
// v up along the palm, w out of the palm (toward the camera when the palm faces it).
const KNUCKLES = { 5: [-0.36, 0.95], 9: [0, 1], 13: [0.3, 0.95], 17: [0.55, 0.86] };
const FINGERS = [
  { mcp: 5, len: [0.42, 0.25, 0.2], fan: -6 },
  { mcp: 9, len: [0.47, 0.29, 0.22], fan: 0 },
  { mcp: 13, len: [0.43, 0.27, 0.21], fan: 5 },
  { mcp: 17, len: [0.33, 0.2, 0.19], fan: 12 },
];
const CURL = [85, 185, 245]; // segment directions of a fully curled finger, degrees from straight up toward the palm
const THUMB_OUT = [[-0.22, 0.22, 0.05], [-0.42, 0.42, 0.08], [-0.64, 0.6, 0.08], [-0.9, 0.74, 0.06]];
const THUMB_IN = [[-0.2, 0.22, 0.08], [-0.35, 0.35, 0.15], [-0.2, 0.5, 0.3], [0, 0.6, 0.32]];
const PALM = [0, 5, 9, 13, 17];

/** Seeded PRNG (mulberry32) with a Gaussian helper, so every run sees the same noise. */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

// The 21 landmarks in palm-length units (u, v, w) for a raised-finger mask and openness.
function skeleton(mask, open) {
  const p = new Array(21);
  p[0] = [0, 0, 0];
  const thumb = mask & 1 ? THUMB_OUT : THUMB_IN;
  for (let i = 0; i < 4; i++) p[1 + i] = thumb[i];
  FINGERS.forEach(({ mcp, len, fan }, f) => {
    const raised = (mask >> (f + 1)) & 1;
    const c = raised ? 1 - open : 1; // 0 straight .. 1 fully curled
    let [u, v, w] = [...KNUCKLES[mcp], 0];
    p[mcp] = [u, v, w];
    for (let s = 0; s < 3; s++) {
      const a = CURL[s] * c * DEG;
      u += len[s] * Math.cos(a) * Math.sin(fan * DEG);
      v += len[s] * Math.cos(a) * Math.cos(fan * DEG);
      w += len[s] * Math.sin(a);
      p[mcp + 1 + s] = [u, v, w];
    }
  });
  return p;
}

// What the tracker measures as palm size, in palm lengths (see measure() in tracker.js).
const SIZE_FACTOR = Math.max(1, Math.hypot(KNUCKLES[5][0] - KNUCKLES[17][0], KNUCKLES[5][1] - KNUCKLES[17][1]) * 1.3);

/**
 * One hand. pose: {
 *   x, y: palm centre in mirrored screen px (the tracker's palm centre when roll = turn = 0),
 *   size: palm size in screen px as the tracker measures it (realistic: 150..230 for a 1280x720 webcam),
 *   mask: raised fingers, bit 0 thumb .. bit 4 pinky (default 31), open: 0 fist .. 1 spread (default 1),
 *   roll: in-plane rotation, radians, counter-clockwise on screen,
 *   turn: turning the hand over about its own up axis (wrist -> middle knuckle), radians; PI shows the back,
 *   side: 1 right hand (thumb on the left of the mirrored picture), -1 left hand,
 *   pivot: where the in-plane rotation pivots, 0 at the wrist .. 1 at the palm centre (default 0.2).
 * }
 * Returns { image, world } landmark arrays with Gaussian noise (imageNoise px on screen, worldNoise metres).
 */
export function hand(pose, rng, { imageNoise = 1.5, worldNoise = 0.002 } = {}) {
  const { x, y, size, mask = 31, open = 1, roll = 0, turn = 0, side = 1, pivot = 0.2 } = pose;
  const L = size / SIZE_FACTOR; // palm length in px
  const local = skeleton(mask, open);
  // Palm centre at rest, relative to the wrist (scene units: X right, Y up, Z toward the viewer).
  let cx = 0;
  let cy = 0;
  for (const i of PALM) {
    cx += (side * local[i][0]) / PALM.length;
    cy += local[i][1] / PALM.length;
  }
  const px = pivot * cx;
  const py = pivot * cy;
  const [ct, st, cr, sr] = [Math.cos(turn), Math.sin(turn), Math.cos(roll), Math.sin(roll)];
  const scene = local.map(([u, v, w]) => {
    // Turn over about the up axis (it passes through the wrist), then roll in the screen plane about the pivot.
    const X0 = side * u;
    const X1 = X0 * ct - w * st;
    const Z = X0 * st + w * ct;
    const X = px + (X1 - px) * cr - (v - py) * sr;
    const Y = py + (X1 - px) * sr + (v - py) * cr;
    return [X, Y, Z];
  });
  // Screen placement: the wrist sits where it puts the resting palm centre at (x, y).
  const wx = x - cx * L;
  const wy = y + cy * L;
  const s = Math.max(VIEW.W / CAM.W, VIEW.H / CAM.H);
  const dw = CAM.W * s;
  const dh = CAM.H * s;
  const ox = (VIEW.W - dw) / 2;
  const oy = (VIEW.H - dh) / 2;
  const image = scene.map(([X, Y, Z]) => {
    const sx = wx + X * L + rng.gauss() * imageNoise;
    const sy = wy - Y * L + rng.gauss() * imageNoise;
    return { x: 1 - (sx - ox) / dw, y: (sy - oy) / dh, z: (-Z * L) / dw };
  });
  // World landmarks: metres around the hand centre, camera axes (mirror back x, y down, z away).
  const m = scene.reduce((a, q) => [a[0] + q[0] / 21, a[1] + q[1] / 21, a[2] + q[2] / 21], [0, 0, 0]);
  const world = scene.map(([X, Y, Z]) => ({
    x: -(X - m[0]) * PALM_M + rng.gauss() * worldNoise,
    y: -(Y - m[1]) * PALM_M + rng.gauss() * worldNoise,
    z: -(Z - m[2]) * PALM_M + rng.gauss() * worldNoise,
  }));
  return { image, world };
}

/** A HandLandmarker result for the visible hands; MediaPipe does not keep the order, so it is shuffled. */
export function detect(poses, rng, noise) {
  const hands = poses.filter(Boolean).map((p) => hand(p, rng, noise));
  if (hands.length === 2 && rng.next() < 0.5) hands.reverse();
  return { landmarks: hands.map((h) => h.image), worldLandmarks: hands.map((h) => h.world) };
}

/**
 * Displacement (px) and speed (px/s) of a flick at time tau since its start: the speed rises to `peak`
 * over `rise` seconds and falls back to zero over `fall` seconds (sin^2 profiles, so it is smooth).
 */
export function flick(tau, { peak, rise = 0.15, fall = 0.2 }) {
  if (tau <= 0) return { d: 0, v: 0 };
  if (tau < rise) {
    const d = peak * (tau / 2 - (rise / (2 * Math.PI)) * Math.sin((Math.PI * tau) / rise));
    return { d, v: peak * Math.sin((Math.PI * tau) / (2 * rise)) ** 2 };
  }
  const u = Math.min(tau - rise, fall);
  const v = tau - rise < fall ? peak * Math.cos((Math.PI * u) / (2 * fall)) ** 2 : 0;
  return { d: (peak * rise) / 2 + peak * (u / 2 + (fall / (2 * Math.PI)) * Math.sin((Math.PI * u) / fall)), v };
}

/** Smooth 0 -> 1 ramp over [a, b] (cosine ease). */
export const ease = (t, a, b) => (t <= a ? 0 : t >= b ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * (t - a)) / (b - a)));
