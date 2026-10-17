import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuro, clamp } from './filters.js';

const PALM = [0, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const FINGERS = [
  [5, 6, 8],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, 20],
];

const LEAD_GRACE_MS = 500; // lead survives short detection dropouts
const TOOL_GRACE_MS = 300;
// Openness (mean fingertip distance from palm centre / palm length) of a fist and of a spread hand.
// The ranges are deliberately narrower than the full motion, so a partial squeeze already covers the whole scale.
const OPEN_MIN = 0.65;
const OPEN_MAX = 0.95;
// Thumb tip to index tip distance / palm length: pinched vs spread.
const PINCH_MIN = 0.25;
const PINCH_MAX = 0.9;

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);

// Bitmask of raised fingers: bit 0 thumb, 1 index, 2 middle, 3 ring, 4 pinky.
// Uses metric world landmarks, so the result does not depend on distance to the camera.
function fingerMask(w) {
  let m = 0;
  FINGERS.forEach(([mcp, pip, tip], i) => {
    if (dist3(w[tip], w[0]) > dist3(w[pip], w[0]) * 1.12 && dist3(w[tip], w[mcp]) > dist3(w[pip], w[mcp]) * 1.25) {
      m |= 2 << i;
    }
  });
  // Thumb: stuck out when its tip is far from the pinky knuckle relative to palm width.
  if (dist3(w[4], w[17]) > dist3(w[5], w[17]) * 1.4) m |= 1;
  return m;
}

function openness(w) {
  const c = { x: 0, y: 0, z: 0 };
  for (const i of PALM) {
    c.x += w[i].x / PALM.length;
    c.y += w[i].y / PALM.length;
    c.z += w[i].z / PALM.length;
  }
  let sum = 0;
  for (const i of TIPS) sum += dist3(w[i], c);
  const palm = dist3(w[0], w[9]);
  const open = clamp((sum / TIPS.length / palm - OPEN_MIN) / (OPEN_MAX - OPEN_MIN), 0, 1);
  const pinch = clamp((dist3(w[4], w[8]) / palm - PINCH_MIN) / (PINCH_MAX - PINCH_MIN), 0, 1);
  // Either closing the whole hand or pinching thumb and index shrinks the figure.
  return Math.min(open, pinch);
}

class Track {
  constructor(d, now) {
    this.t = now;
    this.seen = now;
    this.fx = new OneEuro(1.5, 0.012);
    this.fy = new OneEuro(1.5, 0.012);
    this.fs = new OneEuro(0.8, 0.003);
    this.fo = new OneEuro(2.5, 2.0);
    this.ftx = new OneEuro(2.5, 0.02);
    this.fty = new OneEuro(2.5, 0.02);
    this.hist = [];
    this.mask = d.mask;
    this.fingers = popcount(d.mask);
    this.vx = this.vy = this.pvx = this.pvy = this.twist = this.openRate = 0;
    this.px = this.py = null;
    this.tipX = this.tipY = this.angle = null;
    this.update(d, now);
  }

  update(d, now) {
    const dt = Math.max(1 / 120, (now - this.t) / 1000);
    this.t = this.seen = now;
    this.rawX = d.x;
    this.rawY = d.y;
    this.pts = d.pts;
    this.x = this.fx.filter(d.x, dt);
    this.y = this.fy.filter(d.y, dt);
    this.size = this.fs.filter(d.size, dt);
    // Palm velocity (px/s), used to detect a throw.
    if (this.px !== null) {
      this.pvx += 0.5 * ((this.x - this.px) / dt - this.pvx);
      this.pvy += 0.5 * ((this.y - this.py) / dt - this.pvy);
    }
    this.px = this.x;
    this.py = this.y;

    // Debounce: the finger mask switches only after 3 identical frames in a row.
    this.hist.push(d.mask);
    if (this.hist.length > 3) this.hist.shift();
    if (this.hist.length === 3 && this.hist.every((v) => v === d.mask)) {
      this.mask = d.mask;
      this.fingers = popcount(d.mask);
    }

    const open = this.fo.filter(d.open, dt);
    if (this.open !== undefined) this.openRate += 0.5 * ((open - this.open) / dt - this.openRate);
    this.open = open;

    const tx = this.ftx.filter(d.pts[8].x, dt);
    const ty = this.fty.filter(d.pts[8].y, dt);
    if (this.tipX !== null) {
      this.vx += 0.6 * ((tx - this.tipX) / dt - this.vx);
      this.vy += 0.6 * ((ty - this.tipY) / dt - this.vy);
      this.twist += 0.5 * (wrapAngle(d.angle - this.angle) / dt - this.twist);
    }
    this.tipX = tx;
    this.tipY = ty;
    this.angle = d.angle;
  }
}

/**
 * Starts hand tracking on the video. Returns read(now) -> { lead, tool, hands }.
 * The first hand to enter the frame becomes the lead; the second one is the tool.
 */
export async function startTracking(video, view) {
  const base = import.meta.env.BASE_URL;
  const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  let lead = null;
  let tool = null;

  // Normalised landmark -> mirrored screen pixels, accounting for object-fit: cover.
  function toPx(lm) {
    const s = Math.max(view.W / video.videoWidth, view.H / video.videoHeight);
    const dw = video.videoWidth * s;
    const dh = video.videoHeight * s;
    return { x: (view.W - dw) / 2 + (1 - lm.x) * dw, y: (view.H - dh) / 2 + lm.y * dh };
  }

  function measure(lm, world) {
    const pts = lm.map(toPx);
    let x = 0;
    let y = 0;
    for (const i of PALM) {
      x += pts[i].x / PALM.length;
      y += pts[i].y / PALM.length;
    }
    return {
      pts,
      x,
      y,
      size: Math.max(dist2(pts[0], pts[9]), dist2(pts[5], pts[17]) * 1.3),
      mask: fingerMask(world),
      open: openness(world),
      angle: Math.atan2(pts[9].y - pts[0].y, pts[9].x - pts[0].x),
    };
  }

  const gap = (tr, d) => Math.hypot(d.x - tr.rawX, d.y - tr.rawY);
  const near = (tr, d) => gap(tr, d) < Math.max(view.W * 0.25, tr.size * 3);

  function process(result, now) {
    const dets = result.landmarks.map((lm, i) => measure(lm, result.worldLandmarks[i]));

    // Keep identities by position: MediaPipe does not give stable hand ids.
    if (lead && tool && dets.length === 2) {
      const [a, b] = dets;
      const straight = gap(lead, a) + gap(tool, b) <= gap(lead, b) + gap(tool, a);
      lead.update(straight ? a : b, now);
      tool.update(straight ? b : a, now);
      dets.length = 0;
    } else {
      for (const tr of [lead, tool]) {
        if (!tr || !dets.length) continue;
        let best = 0;
        for (let i = 1; i < dets.length; i++) if (gap(tr, dets[i]) < gap(tr, dets[best])) best = i;
        if (near(tr, dets[best])) tr.update(dets.splice(best, 1)[0], now);
      }
    }
    for (const d of dets) {
      if (!lead) lead = new Track(d, now);
      else if (!tool) tool = new Track(d, now);
    }
  }

  function expire(now) {
    if (tool && now - tool.seen > TOOL_GRACE_MS) tool = null;
    if (lead && now - lead.seen > LEAD_GRACE_MS) {
      lead = tool; // the remaining hand takes over the figure
      tool = null;
    }
  }

  const onFrame = () => {
    const now = performance.now();
    if (video.videoWidth) process(landmarker.detectForVideo(video, now), now);
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  const snap = (tr, now) => ({
    x: tr.x,
    y: tr.y,
    size: tr.size,
    fingers: tr.fingers,
    mask: tr.mask,
    pts: tr.pts,
    open: tr.open,
    openRate: tr.openRate,
    vx: tr.vx,
    vy: tr.vy,
    pvx: tr.pvx,
    pvy: tr.pvy,
    twist: tr.twist,
    fresh: now - tr.seen < 120,
  });

  return {
    read(now) {
      expire(now);
      return {
        lead: lead && snap(lead, now),
        tool: tool && snap(tool, now),
        hands: [lead, tool].filter(Boolean).map((tr) => tr.pts),
      };
    },
    // The hands trade roles: the figure now follows the former tool.
    swap() {
      [lead, tool] = [tool, lead];
    },
  };
}
