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
// Wrist velocity (the throw detector's input) is a straight-line fit over the newest raw wrist positions:
// at least FIT_SAMPLES of them spanning at least FIT_SPAN_MS, none older than FIT_MAX_AGE_MS. That is defined in
// time, not frames, so it behaves the same at any camera rate: 4 samples / 100 ms at 30 fps, 7 / 100 ms at 60 fps,
// 4 / 200 ms at 15 fps. With fewer samples than that the reading is 0: a short window cannot tell a glitch from motion.
const FIT_SPAN_MS = 90;
const FIT_SAMPLES = 4;
const FIT_MAX_AGE_MS = 300;
const MAX_SAMPLES = 8;
// A wrist sample this far (in palm sizes) off the line through the others is a landmark glitch and is left out.
// A hard flick bends its path by up to ~0.25 palm sizes over 100 ms, so its first or last sample may be left out
// too, which costs little: the line through the other samples still follows the flick.
const GLITCH = 0.2;
// A hand re-acquired after a gap of up to GAP_MAX_MS (motion blur drops frames at the peak of a flick) reads the
// speed across the gap if on the next frame it still moves the same way at GAP_KEEP times that speed or more,
// and, if it was moving faster than GAP_MIN_SPEED px/s before the gap, the gap continues that motion.
const GAP_MAX_MS = 250;
const GAP_FRAMES = 1.8; // a gap is a step this many typical frame intervals long (a frame or more dropped)
const GAP_KEEP = 0.3;
const GAP_MIN_SPEED = 300;
// Smoothing time constant (ms) of the gesture rates (twist, flip, open/close, fingertip velocity): k = 1 - exp(-dt / tau),
// so the result does not depend on the camera frame rate.
const RATE_TAU_MS = 60;
const TIP_TAU_MS = 50;

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

// The line through the samples, leaving out the one sample (a landmark glitch) that the line through the others
// misses by more than GLITCH palm sizes. The suspect is the sample whose removal leaves the straightest line.
function robustFit(s, size) {
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
  return Math.hypot(best.p.x - q.x, best.p.y - q.y) > GLITCH * size ? best.fit : fitLine(s);
}

const median = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];

// Wrist velocity (px/s) from raw (unfiltered) samples, newest last. Any smoothing filter in front of the slope
// lags behind a 150 ms flick; the slope of a line fitted over ~100 ms has no bias for steady motion, reads ~0.93x
// the peak of a short flick (it averages the speed over the window) and averages the landmark noise down.
// A single bad frame cannot fake a throw: it is dropped (robustFit) or, if smaller than GLITCH, shifts the
// reading by at most ~9 px/s per px at 30 fps (less at 15 or 60 fps): < 400 px/s for a 200 px palm.
// `tr` keeps the state of the gap rule between frames (tr.gapEnd: the first sample after a gap).
function wristVelocity(s, size, tr) {
  const n = s.length;
  const b = s[n - 1];
  const a = s[n - 2];
  // Gaps: the camera lost the hand for a few frames (motion blur at the peak of a flick, an occlusion) and has
  // it again. One frame later it is clear what happened: a flick blurred out by the camera keeps going the way
  // it jumped, and then the speed across the gap is the reading (a line through the samples before the gap and
  // the new ones would call the new ones a glitch: the hand sped up meanwhile). A hand that is found a little
  // elsewhere and stays there, or a glitch, is not a flick: the samples before the gap are forgotten and the
  // speed is measured afresh.
  if (tr.gapEnd) {
    const end = tr.gapEnd;
    tr.gapEnd = null;
    const i = s.indexOf(end);
    const start = s[i - 1];
    if (end === a && start) {
      const g = (end.t - start.t) / 1000;
      const h = (b.t - end.t) / 1000;
      const gx = (end.x - start.x) / g;
      const gy = (end.y - start.y) / g;
      const cx = (b.x - end.x) / h;
      const cy = (b.y - end.y) / h;
      const vg = Math.hypot(gx, gy);
      const vc = Math.hypot(cx, cy);
      const pre = tr.gapPre;
      const pv = Math.hypot(pre.vx, pre.vy);
      const keeps = vg && vc >= GAP_KEEP * vg && (gx * cx + gy * cy) / (vg * vc) > 0.7;
      const sameWay = pv < GAP_MIN_SPEED || (gx * pre.vx + gy * pre.vy) / (vg * pv) > 0.7;
      if (g * 1000 <= GAP_MAX_MS && keeps && sameWay) return { vx: gx, vy: gy };
    }
    if (i > 0) s.splice(0, i);
  } else if (n >= 4) {
    const intervals = [];
    for (let k = Math.max(1, n - MAX_SAMPLES); k < n - 1; k++) intervals.push(s[k].t - s[k - 1].t);
    if (b.t - a.t >= GAP_FRAMES * median(intervals)) {
      tr.gapEnd = b;
      tr.gapPre = { vx: tr.pvx, vy: tr.pvy };
      return { vx: 0, vy: 0 };
    }
  }
  // Newest samples first, until there are enough of them over a long enough time.
  const m = s.length;
  const now = s[m - 1].t;
  let k = m - 1;
  while (
    k > 0 &&
    m - k < MAX_SAMPLES &&
    !(m - k >= FIT_SAMPLES && now - s[k].t >= FIT_SPAN_MS) &&
    now - s[k - 1].t <= FIT_MAX_AGE_MS
  ) {
    k--;
  }
  const fit = s.slice(k);
  if (fit.length < FIT_SAMPLES || now - fit[0].t < FIT_SPAN_MS) return { vx: 0, vy: 0 };
  return robustFit(fit, size);
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

let nextId = 1; // track ids are never reused, so the simulation can name a hand across role changes

class Track {
  constructor(d, now) {
    this.id = nextId++;
    this.born = now;
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
    this.resetMotion();
    this.update(d, now);
  }

  // Forgets every motion baseline: the next frames start measuring speeds and rates afresh.
  resetMotion() {
    this.wrists = []; // recent raw wrist positions { t, x, y }
    this.gapEnd = null; // see wristVelocity
    this.vx = this.vy = this.pvx = this.pvy = this.twist = this.flip = this.openRate = 0;
    this.tipX = this.tipY = this.angle = this.flipAngle = null; // null: no baseline for the rates yet
  }

  // The camera -> screen mapping changed (window resize, new video size): x' = ox + sx * x, y' = oy + sy * y.
  // Positions move with it, so the hand stays the same hand and the filters do not see a jump; speeds restart.
  remap(ox, sx, oy, sy) {
    const s = (Math.abs(sx) + Math.abs(sy)) / 2;
    const move = (f, o, k) => {
      if (f.x !== null) f.x = o + k * f.x;
      f.dx *= k;
    };
    move(this.fx, ox, sx);
    move(this.fy, oy, sy);
    move(this.ftx, ox, sx);
    move(this.fty, oy, sy);
    move(this.fs, 0, s);
    this.x = ox + sx * this.x;
    this.y = oy + sy * this.y;
    this.rawX = ox + sx * this.rawX;
    this.rawY = oy + sy * this.rawY;
    this.size *= s;
    this.pts = this.pts.map((p) => ({ ...p, x: ox + sx * p.x, y: oy + sy * p.y }));
    this.resetMotion();
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
    while (this.wrists.length > MAX_SAMPLES + 2 || now - this.wrists[0].t > FIT_MAX_AGE_MS + GAP_MAX_MS) {
      this.wrists.shift();
    }
    const v = wristVelocity(this.wrists, this.size, this);
    this.pvx = v.vx;
    this.pvy = v.vy;

    // Debounce: the finger mask switches only after 3 identical frames in a row.
    this.hist.push(d.mask);
    if (this.hist.length > 3) this.hist.shift();
    if (this.hist.length === 3 && this.hist.every((v) => v === d.mask)) {
      this.mask = d.mask;
      this.fingers = popcount(d.mask);
    }

    // Rates are smoothed with a time constant, not a per-frame factor, so a faster camera does not let
    // more landmark noise through.
    const kRate = 1 - Math.exp((-dt * 1000) / RATE_TAU_MS);
    const kTip = 1 - Math.exp((-dt * 1000) / TIP_TAU_MS);
    const open = this.fo.filter(d.open, dt);
    const tx = this.ftx.filter(d.pts[8].x, dt);
    const ty = this.fty.filter(d.pts[8].y, dt);
    if (this.tipX !== null) {
      this.openRate += kRate * ((open - this.open) / dt - this.openRate);
      this.vx += kTip * ((tx - this.tipX) / dt - this.vx);
      this.vy += kTip * ((ty - this.tipY) / dt - this.vy);
      this.twist += kRate * (wrapAngle(d.angle - this.angle) / dt - this.twist);
      this.flip += kRate * (wrapAngle(d.flip - this.flipAngle) / dt - this.flip);
    }
    this.open = open;
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
 * Each snapshot carries the track's `id`, unique for as long as the page runs, and its `age` (ms).
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

  // Where the lead was when it expired with no other hand to take over: when hands come back after that,
  // the one nearest to it leads again (MediaPipe's order is random), so the figure does not jump across.
  let lastLead = null;

  // The camera -> screen mapping as two probe points. A window resize or a new video size changes it, which
  // moves every hand on screen in one frame: without this that jump reads as a flick and throws the figure.
  let mapping = null;
  function checkMapping() {
    const a = toPx({ x: 0, y: 0, z: 0 });
    const b = toPx({ x: 1, y: 1, z: 0 });
    const m = { a, b, W: view.W, H: view.H };
    const old = mapping;
    mapping = m;
    if (!old || (old.a.x === a.x && old.a.y === a.y && old.b.x === b.x && old.b.y === b.y)) return;
    const sx = (b.x - a.x) / (old.b.x - old.a.x || 1);
    const sy = (b.y - a.y) / (old.b.y - old.a.y || 1);
    const ox = a.x - sx * old.a.x;
    const oy = a.y - sy * old.a.y;
    for (const tr of [lead, tool]) tr?.remap(ox, sx, oy, sy);
    if (lastLead) lastLead = { x: ox + sx * lastLead.x, y: oy + sy * lastLead.y };
  }

  function process(result, now) {
    expire(now);
    checkMapping();
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
    if (!lead && lastLead && dets.length === 2) {
      const off = (d) => Math.hypot(d.x - lastLead.x, d.y - lastLead.y);
      if (off(dets[1]) < off(dets[0])) dets.reverse();
    }
    for (const d of dets) {
      if (!lead) lead = new Track(d, now);
      else if (!tool) tool = new Track(d, now);
    }
    lastFrame = now;
  }

  function expire(now) {
    if (tool && now - tool.seen > TOOL_GRACE_MS) tool = null;
    if (lead && now - lead.seen > LEAD_GRACE_MS) {
      if (!tool) lastLead = { x: lead.rawX, y: lead.rawY };
      lead = tool; // the remaining hand takes over the figure
      tool = null;
    }
  }

  const snap = (tr, now) => ({
    id: tr.id,
    age: now - tr.born, // ms since the hand was first tracked
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
    // The track with this id becomes the lead (the figure follows it), the other one the tool. Idempotent:
    // nothing happens if it already leads or is gone. Without an id the hands simply trade roles.
    swap(id) {
      if (id === undefined || tool?.id === id) [lead, tool] = [tool, lead];
    },
    // The live Track objects, for tests that check hand identity.
    tracks: () => ({ lead, tool }),
  };
}
