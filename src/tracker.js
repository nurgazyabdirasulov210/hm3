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
const FAST = 500; // px/s: a lost hand moving faster than this is looked for ahead along its motion
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
// Wrist velocity (the throw detector's input) is a straight-line fit over the last WRIST_SAMPLES raw wrist
// positions no older than THROW_WINDOW_MS: 4 samples = 100 ms at 30 fps.
export const THROW_WINDOW_MS = 150;
const WRIST_SAMPLES = 4;
// A wrist sample this far (in palm sizes) off the line through the others is a landmark glitch and is left out.
// Real motion stays inside it: even a 2600 px/s flick bends the path by ~0.25 palm sizes over the window.
const GLITCH = 0.3;

// Least-squares line through samples { t (ms), x, y }: velocity (px/s) and position at time t.
function fitLine(s) {
  let tm = 0;
  let xm = 0;
  let ym = 0;
  for (const p of s) {
    tm += p.t / s.length;
    xm += p.x / s.length;
    ym += p.y / s.length;
  }
  let tt = 0;
  let tx = 0;
  let ty = 0;
  for (const p of s) {
    tt += (p.t - tm) ** 2;
    tx += (p.t - tm) * (p.x - xm);
    ty += (p.t - tm) * (p.y - ym);
  }
  const vx = tt ? tx / tt : 0;
  const vy = tt ? ty / tt : 0;
  return { vx: vx * 1000, vy: vy * 1000, at: (t) => ({ x: xm + vx * (t - tm), y: ym + vy * (t - tm) }) };
}

// Wrist velocity from raw (unfiltered) samples. Any smoothing filter in front of the slope lags behind a
// 150 ms flick, which made the old estimate read ~0.84x the true peak; the slope of a line fitted over ~100 ms
// has no bias for steady motion, reads ~0.93x the peak of a short flick (it averages the speed over the
// window) and averages the landmark noise down to ~20 px/s. With 4+ samples, a sample that the line through
// the others misses by more than GLITCH palm sizes is dropped, so a single bad frame cannot fake a throw
// (a smaller glitch shifts the reading by at most ~9 px/s per px, < 600 px/s).
function wristVelocity(s, size) {
  if (s.length < 2) return { vx: 0, vy: 0 };
  if (s.length >= 4) {
    // The suspect is the sample whose removal leaves the straightest line through the rest.
    let best = null;
    s.forEach((p, i) => {
      const rest = s.filter((_, j) => j !== i);
      const fit = fitLine(rest);
      let spread = 0;
      for (const r of rest) {
        const q = fit.at(r.t);
        spread += Math.hypot(r.x - q.x, r.y - q.y);
      }
      if (!best || spread < best.spread) best = { fit, spread, p };
    });
    const q = best.fit.at(best.p.t);
    if (Math.hypot(best.p.x - q.x, best.p.y - q.y) > GLITCH * size) return best.fit;
  }
  return fitLine(s);
}

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
    this.wrists = []; // recent raw wrist positions { t, x, y }
    this.vx = this.vy = this.pvx = this.pvy = this.twist = this.flip = this.openRate = 0;
    this.tipX = this.tipY = this.angle = this.flipAngle = null;
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
    this.up = d.up;
    this.twistW = d.twistW;
    this.flipW = d.flipW;

    // Wrist velocity (px/s), used to detect a throw (see wristVelocity). The wrist is the pivot of a twist
    // or a flip, so turning the hand does not read as moving it.
    this.wrists.push({ t: now, x: d.pts[0].x, y: d.pts[0].y });
    while (this.wrists.length > WRIST_SAMPLES || now - this.wrists[0].t > THROW_WINDOW_MS) this.wrists.shift();
    const v = wristVelocity(this.wrists, this.size);
    this.pvx = v.vx;
    this.pvy = v.vy;

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

  // Where the track is expected to be now: its last position carried along the wrist velocity,
  // so a hand that was flicked fast is found again where it landed.
  let frameNow = 0;
  let lastFrame = -Infinity; // time of the previous camera frame
  const lostFor = (tr) => (frameNow - tr.seen) / 1000; // s since the track last got a detection
  const gap = (tr, d) => {
    const ahead = Math.min(0.25, lostFor(tr));
    return Math.hypot(d.x - (tr.rawX + tr.pvx * ahead), d.y - (tr.rawY + tr.pvy * ahead));
  };
  // How far from that prediction a lone detection may be and still count as this hand: two palm sizes on an
  // ordinary frame, growing while the hand is lost, faster for a hand that was moving fast.
  const gate = (tr) => tr.size * 2 + (Math.hypot(tr.pvx, tr.pvy) * 0.5 + tr.size * 3) * lostFor(tr);
  // A fast hand the camera lost (motion blur in a flick) is re-acquired anywhere ahead along its motion,
  // up to where it could have got by now, instead of turning into a second hand.
  const reacquire = (tr, d) => {
    const v = Math.hypot(tr.pvx, tr.pvy);
    if (v < FAST) return false;
    const dx = d.x - tr.rawX;
    const dy = d.y - tr.rawY;
    const along = (dx * tr.pvx + dy * tr.pvy) / v;
    const across = Math.abs(dx * tr.pvy - dy * tr.pvx) / v;
    return along > 0 && along < v * (lostFor(tr) + 0.2) + tr.size && across < tr.size * 1.5;
  };
  // Cost of giving a lone detection to a track: distance from its prediction, plus a palm size for a track
  // that missed the previous frame (its prediction is a guess), so a hand that is being tracked keeps it.
  const cost = (tr, d) => gap(tr, d) + (tr.seen < lastFrame ? tr.size : 0);

  function process(result, now) {
    expire(now);
    frameNow = now;
    const dets = result.landmarks.map((lm, i) => measure(lm, result.worldLandmarks[i]));

    // Keep identities by position: MediaPipe does not give stable hand ids.
    if (dets.length >= 2) {
      // Both hands in view, and there are never more than two: every track is one of them,
      // paired up so that the total distance from the predictions is smallest.
      const [a, b] = dets;
      if (lead && tool) {
        const straight = gap(lead, a) + gap(tool, b) <= gap(lead, b) + gap(tool, a);
        lead.update(straight ? a : b, now);
        tool.update(straight ? b : a, now);
        dets.length = 0;
      } else if (lead || tool) {
        const tr = lead || tool;
        tr.update(dets.splice(gap(tr, a) <= gap(tr, b) ? 0 : 1, 1)[0], now);
      }
    } else if (dets.length === 1) {
      // One hand in view: it goes to the track it fits best, and only to a track it plausibly is.
      // A lost track never takes a detection sitting where the other, still tracked, hand is.
      const d = dets[0];
      let best = null;
      for (const tr of [lead, tool]) {
        if (!tr || !(gap(tr, d) < gate(tr) || reacquire(tr, d))) continue;
        if (!best || cost(tr, d) < cost(best, d)) best = tr;
      }
      if (best) {
        best.update(d, now);
        dets.length = 0;
      }
    }
    // A detection no track claims is a hand entering the frame.
    for (const d of dets) {
      if (!lead) lead = new Track(d, now);
      else if (!tool) tool = new Track(d, now);
    }
    lastFrame = now;
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
