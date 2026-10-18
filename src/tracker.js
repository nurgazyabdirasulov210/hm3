// Pure part of the hand tracker: per-hand measurements from MediaPipe landmarks, filtering, gesture rates,
// and stable lead / tool identities across frames. No DOM and no MediaPipe import, so it runs in Node too.
import { OneEuro, clamp, smoothstep } from './filters.js';

const PALM = [0, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];
const FINGERS = [
  [5, 6, 8],
  [9, 10, 12],
  [13, 14, 16],
  [17, 18, 20],
];

export const LEAD_GRACE_MS = 500; // lead survives short detection dropouts
export const TOOL_GRACE_MS = 300;
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
// Wrist velocity is measured over this window, so a single glitchy frame cannot fake a throw.
export const THROW_WINDOW_MS = 120;

// Hand orientation from metric world landmarks, in mirrored scene space (x right, y up, z toward the viewer),
// so rotations match what the user sees on screen.
// up: unit wrist -> middle knuckle axis. flip: angle of the knuckle line around that axis, i.e. turning the hand over.
// It does not change when the hand rotates in the screen plane, so it never doubles up with the in-plane twist.
export function orientation(w) {
  const P = (i) => [-w[i].x, -w[i].y, -w[i].z];
  const [wx, wy, wz] = P(0);
  const [mx, my, mz] = P(9);
  const [ix, iy, iz] = P(5);
  const [px, py, pz] = P(17);
  const ul = Math.hypot(mx - wx, my - wy, mz - wz) || 1;
  const ux = (mx - wx) / ul;
  const uy = (my - wy) / ul;
  const uz = (mz - wz) / ul;
  // e1 = camera axis x up (lies in the screen plane, across the hand); e2 = up x e1.
  const el = Math.hypot(ux, uy) || 1e-6;
  const e1x = -uy / el;
  const e1y = ux / el;
  const e2x = -uz * e1y;
  const e2y = uz * e1x;
  const e2z = ux * e1y - uy * e1x;
  const ax = px - ix;
  const ay = py - iy;
  const az = pz - iz;
  return {
    up: { x: ux, y: uy, z: uz },
    flip: Math.atan2(ax * e2x + ay * e2y + az * e2z, ax * e1x + ay * e1y),
    // Unreliable when the hand points at the camera.
    flipW: smoothstep(0.45, 0.75, el),
  };
}

const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);

// Bitmask of raised fingers: bit 0 thumb, 1 index, 2 middle, 3 ring, 4 pinky.
// Uses metric world landmarks, so the result does not depend on distance to the camera.
export function fingerMask(w) {
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

export function openness(w) {
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
    this.fwx = new OneEuro(2.0, 0.02);
    this.fwy = new OneEuro(2.0, 0.02);
    this.wrists = []; // recent filtered wrist positions { t, x, y }
    this.vx = this.vy = this.pvx = this.pvy = this.twist = this.flip = this.openRate = 0;
    this.tipX = this.tipY = this.angle = this.flipAngle = null;
    this.update(d, now);
  }

  update(d, now) {
    // After a dropout the old wrist samples say nothing about the current motion.
    if (now - this.t > 150) this.wrists.length = 0;
    const dt = Math.max(1 / 120, (now - this.t) / 1000);
    this.t = this.seen = now;
    this.rawX = d.x;
    this.rawY = d.y;
    this.pts = d.pts;
    this.x = this.fx.filter(d.x, dt);
    this.y = this.fy.filter(d.y, dt);
    this.size = this.fs.filter(d.size, dt);
    this.up = d.up;
    this.twistW = d.twistW;
    this.flipW = d.flipW;

    // Wrist velocity (px/s), used to detect a throw. The wrist is the pivot of a twist or a flip,
    // so turning the hand does not read as moving it.
    const wx = this.fwx.filter(d.pts[0].x, dt);
    const wy = this.fwy.filter(d.pts[0].y, dt);
    this.wrists.push({ t: now, x: wx, y: wy });
    while (this.wrists.length > 2 && now - this.wrists[1].t >= THROW_WINDOW_MS) this.wrists.shift();
    const w0 = this.wrists[0];
    const span = (now - w0.t) / 1000;
    if (this.wrists.length < 2) {
      this.pvx = this.pvy = 0;
    } else if (span > 0.02) {
      this.pvx += 0.6 * ((wx - w0.x) / span - this.pvx);
      this.pvy += 0.6 * ((wy - w0.y) / span - this.pvy);
    }

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
      this.flip += 0.5 * (wrapAngle(d.flip - this.flipAngle) / dt - this.flip);
    }
    this.tipX = tx;
    this.tipY = ty;
    this.angle = d.angle;
    this.flipAngle = d.flip;
  }
}

// Normalised landmark -> mirrored screen pixels for a vw x vh video shown with object-fit: cover.
export function toScreen(lm, view, vw, vh) {
  const s = Math.max(view.W / vw, view.H / vh);
  const dw = vw * s;
  const dh = vh * s;
  return { x: (view.W - dw) / 2 + (1 - lm.x) * dw, y: (view.H - dh) / 2 + lm.y * dh };
}

/**
 * Hand tracker. `toPx(lm)` maps a normalised landmark to screen pixels (see toScreen).
 * process(result, now) takes a MediaPipe HandLandmarker result { landmarks, worldLandmarks } at time `now` (ms).
 * read(now) -> { lead, tool, hands }. The first hand to enter the frame becomes the lead, the second one the tool.
 */
export function createTracker(view, toPx) {
  let lead = null;
  let tool = null;

  function measure(lm, world) {
    const pts = lm.map(toPx);
    let x = 0;
    let y = 0;
    for (const i of PALM) {
      x += pts[i].x / PALM.length;
      y += pts[i].y / PALM.length;
    }
    const size = Math.max(dist2(pts[0], pts[9]), dist2(pts[5], pts[17]) * 1.3);
    return {
      ...orientation(world),
      pts,
      x,
      y,
      size,
      // The in-plane angle is noise when the wrist -> knuckle line is foreshortened (hand pointing at the camera).
      twistW: smoothstep(0.35, 0.6, dist2(pts[0], pts[9]) / size),
      mask: fingerMask(world),
      open: openness(world),
      angle: Math.atan2(pts[9].y - pts[0].y, pts[9].x - pts[0].x),
    };
  }

  // Distance from where the track is expected to be now (last position carried along its velocity),
  // so a hand that was flicked fast is found again where it landed.
  let frameNow = 0;
  const gap = (tr, d) => {
    const ahead = Math.min(0.25, (frameNow - tr.seen) / 1000 + 0.03);
    return Math.hypot(d.x - (tr.rawX + tr.pvx * ahead), d.y - (tr.rawY + tr.pvy * ahead));
  };
  const near = (tr, d) => gap(tr, d) < Math.max(view.W * 0.25, tr.size * 3);

  function process(result, now) {
    frameNow = now;
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
      // A track that got nothing this frame and was moving fast is most likely this hand after a flick:
      // there are never more than two hands, so it must not turn into a "new" one.
      const lost = [lead, tool].find((tr) => tr && tr.seen !== now && Math.hypot(tr.pvx, tr.pvy) > 500);
      if (lost) lost.update(d, now);
      else if (!lead) lead = new Track(d, now);
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
    twistW: tr.twistW,
    flip: tr.flip,
    flipW: tr.flipW,
    up: tr.up,
    fresh: now - tr.seen < 120,
  });

  return {
    process,
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
    // The live Track objects, for tests that check hand identity.
    tracks: () => ({ lead, tool }),
  };
}
