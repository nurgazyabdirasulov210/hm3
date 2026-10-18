import * as THREE from 'three';
import { createLayer, createFrame, drawDesign, heatColor, spellState, stepSpell, PORTAL_DESIGNS } from './spells.js';
import { rimSparks, penSparks, crumbleSparks } from './sparks.js';

const MAX_SEGS = 5200;
const COLOR = new THREE.Color(0xff9a2e);
const OPEN_W = 16; // rad/s, open spring (critically damped)
const CLOSE_W = 9; // rad/s, close spring: a bit slower, so the dissolve can be seen
const rgb = [0, 0, 0];

/**
 * Flat frame spanned between the hands (two fingertips per hand) with a Doctor Strange mandala inside.
 * The frame is mapped bilinearly onto the four fingertips, so it bends with them; the mandala is drawn in
 * the frame's own orthonormal axes, so it stays round. `spell` (0..7) picks the design, `level` (0..3)
 * adds layers; designs cross-fade (the old one crumbles while the new one draws itself in).
 */
export function createPortal(scene, sparks) {
  const layer = createLayer(scene, MAX_SEGS, { order: 10 });
  const corners = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  const shown = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  const slots = PORTAL_DESIGNS.map(() => spellState());
  const f = createFrame();
  let have = false;
  let lastLevel = 0;
  let grow = 0;
  let growV = 0;
  let mg = 0; // mandala scale
  let quad = null; // quarter turns from the frame's u axis to the mandala's
  let stats = { segs: 0 };

  // Bilinear frame: (u, v) in [-1, 1]^2 onto the (shrunk) corners.
  const bil = [0, 0];
  function map(u, v) {
    const s = (u + 1) / 2;
    const t = (v + 1) / 2;
    const [a, b, c, d] = shown;
    const w00 = (1 - s) * (1 - t);
    const w10 = s * (1 - t);
    const w11 = s * t;
    const w01 = (1 - s) * t;
    bil[0] = a.x * w00 + b.x * w10 + c.x * w11 + d.x * w01;
    bil[1] = a.y * w00 + b.y * w10 + c.y * w11 + d.y * w01;
    return bil;
  }
  function fline(u0, v0, u1, v1, k) {
    const [x0, y0] = map(u0, v0);
    const [x1, y1] = map(u1, v1);
    layer.seg(x0, y0, x1, y1, rgb[0] * k, rgb[1] * k, rgb[2] * k);
  }
  // The frame: an edge between the fingertips, drawn as a chain of short segments so it bends.
  function frameDraw(k, t) {
    heatColor(0.45, rgb);
    const N = 10;
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let e = 0; e < 4; e++) {
      const [u0, v0] = P[e];
      const [u1, v1] = P[(e + 1) % 4];
      for (let i = 0; i < N; i++) {
        // A soft flicker runs along the edge.
        const fl = 0.55 + 0.25 * Math.sin(t * 9 + (e * N + i) * 0.9);
        fline(u0 + ((u1 - u0) * i) / N, v0 + ((v1 - v0) * i) / N, u0 + ((u1 - u0) * (i + 1)) / N, v0 + ((v1 - v0) * (i + 1)) / N, k * fl);
      }
    }
    // Corner brackets just outside the fingertips.
    heatColor(0.85, rgb);
    const o = 1.1;
    const l = 0.2;
    for (const [sx, sy] of P) {
      fline(sx * o, sy * o, sx * (o - l), sy * o, k);
      fline(sx * o, sy * o, sx * o, sy * (o - l), k);
    }
  }

  /** pts: four {x, y} screen points in loop order, or null. spell: 0..7. level: 0..3. */
  function update(pts, spell, level, dt, t) {
    spell = Math.max(0, Math.min(PORTAL_DESIGNS.length - 1, spell | 0));
    // While closing, the mandala keeps the level it had instead of dropping its layers at once.
    if (pts) lastLevel = Math.max(0, Math.min(3, level | 0));
    level = lastLevel;
    if (pts) {
      if (!have) {
        // Reopening while it still closes keeps the current size, so it never pops.
        pts.forEach((q, i) => Object.assign(corners[i], q));
        have = true;
      }
      const k = 1 - Math.exp(-30 * dt);
      pts.forEach((q, i) => {
        corners[i].x += (q.x - corners[i].x) * k;
        corners[i].y += (q.y - corners[i].y) * k;
      });
    } else {
      have = false;
    }
    // Critically damped and substepped: opens without overshoot and never blinks back after closing.
    const W = pts ? OPEN_W : CLOSE_W;
    const steps = Math.max(1, Math.ceil(dt * 240));
    for (let i = 0; i < steps; i++) {
      growV += (W * W * ((pts ? 1 : 0) - grow) - 2 * W * growV) * (dt / steps);
      grow += growV * (dt / steps);
    }
    let any = false;
    slots.forEach((st, i) => {
      stepSpell(st, !!pts && i === spell, level, dt);
      if (st.fade > 0) any = true;
    });

    layer.begin();
    stats.segs = 0;
    if (!any && grow < 0.02) {
      mg = 0;
      quad = null;
      layer.end();
      return;
    }

    // Shrink everything around the frame's centre while it opens.
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    const g = Math.max(0, grow);
    corners.forEach((c, i) => {
      shown[i].x = cx + (c.x - cx) * g;
      shown[i].y = cy + (c.y - cy) * g;
    });
    // The frame's u axis (corner 0 -> 1, averaged with 3 -> 2).
    const [c0, c1, c2, c3] = corners;
    const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    const ax = c1.x - c0.x + c2.x - c3.x;
    const ay = c1.y - c0.y + c2.y - c3.y;
    // Of the frame's four axis directions, the one closest to screen-right is the mandala's u axis and v is
    // u turned 90° clockwise: designs with a direction (the eye) stay upright and never mirror. The choice has
    // hysteresis, so a frame held near 45° does not flip the mandala back and forth.
    const base = Math.atan2(ay, ax);
    const want = Math.round(-base / (Math.PI / 2));
    if (quad === null || Math.abs(base + quad * (Math.PI / 2)) > Math.PI / 4 + 0.15) quad = want;
    const ang = base + quad * (Math.PI / 2);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    f.cx = cx;
    f.cy = cy;
    f.ax = ux;
    f.ay = uy;
    f.bx = -uy;
    f.by = ux;
    // The mandala grows with the frame while it opens; when the portal closes it keeps its size and
    // crumbles away instead of collapsing to a point.
    if (pts) mg = Math.max(mg, Math.min(1, g));
    else if (!any) mg = g;
    f.r = Math.max(1, (mg * Math.min(len(c0, c1) + len(c3, c2), len(c0, c3) + len(c1, c2))) / 4);

    const frameK = Math.min(1, g);
    if (frameK > 0.02) frameDraw(frameK, t);

    // Brighter with every level.
    const gain = 0.8 + 0.1 * level;
    slots.forEach((st, i) => {
      if (st.fade <= 0) return;
      const d = PORTAL_DESIGNS[i];
      const n0 = layer.n;
      f.pen.on = false;
      drawDesign(layer, f, d, st, t, gain);
      if (!sparks) return;
      if (st.on) {
        const ready = Math.min(1, st.draw * 1.5) * Math.min(1, g);
        rimSparks(sparks, f, d.rim, (d.sparks + d.perLevel * level) * ready, dt, d.dir, d.spark);
        if (st.draw < 1) penSparks(sparks, f, 90, dt);
      } else {
        crumbleSparks(sparks, layer, n0, layer.n, cx, cy, f.r * 1.4, 420 * st.fade, dt);
      }
    });
    stats.segs = layer.n;
    layer.end(1);
  }

  function resize(w, h) {
    layer.resize(w, h);
  }

  return { update, resize, color: COLOR, stats };
}
