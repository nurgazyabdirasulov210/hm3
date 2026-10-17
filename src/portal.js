import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { lineMaterial } from './figure.js';

const MAX_SEGS = 1600;
const TAU = Math.PI * 2;
const COLOR = new THREE.Color(0xff9a2e);

/**
 * Flat square spanned between the hands (two corners per hand) with a Doctor Strange style
 * mandala inside it. Everything is drawn in the square's own (u, v) space, u, v in [-1, 1],
 * and mapped bilinearly onto the four fingertip corners, so the pattern bends with the frame.
 */
export function createPortal(scene) {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(new Float32Array(MAX_SEGS * 6));
  const buffer = geometry.attributes.instanceStart.data;
  const mesh = new LineSegments2(geometry, lineMaterial());
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  const corners = [0, 1, 2, 3].map(() => ({ x: 0, y: 0 }));
  let have = false;
  let grow = 0;
  let growV = 0;
  let n = 0;
  let arr = buffer.array;

  const p = [0, 0];
  const rect = { cx: 0, cy: 0, ax: 1, ay: 0, bx: 0, by: 1, r: 1 };
  let round = false;
  function map(u, v) {
    if (round) {
      p[0] = rect.cx + rect.r * (u * rect.ax + v * rect.bx);
      p[1] = rect.cy + rect.r * (u * rect.ay + v * rect.by);
      return p;
    }
    const s = (u + 1) / 2;
    const t = (v + 1) / 2;
    const [a, b, c, d] = corners;
    const w00 = (1 - s) * (1 - t);
    const w10 = s * (1 - t);
    const w11 = s * t;
    const w01 = (1 - s) * t;
    p[0] = a.x * w00 + b.x * w10 + c.x * w11 + d.x * w01;
    p[1] = a.y * w00 + b.y * w10 + c.y * w11 + d.y * w01;
    return p;
  }

  function line(u0, v0, u1, v1) {
    if (n >= MAX_SEGS) return;
    const [x0, y0] = map(u0, v0);
    const o = n++ * 6;
    arr[o] = x0;
    arr[o + 1] = -y0;
    arr[o + 2] = 0;
    const [x1, y1] = map(u1, v1);
    arr[o + 3] = x1;
    arr[o + 4] = -y1;
    arr[o + 5] = 0;
  }

  function poly(count, r, rot, step = 1) {
    for (let i = 0; i < count; i++) {
      const a0 = rot + (i / count) * TAU;
      const a1 = rot + (((i + step) % count) / count) * TAU;
      line(r * Math.cos(a0), r * Math.sin(a0), r * Math.cos(a1), r * Math.sin(a1));
    }
  }

  // Dashed ring: `count` arcs, each covering `fill` of its slot.
  function arcs(r, count, fill, rot, sub = 6) {
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < sub; j++) {
        const a0 = rot + ((i + (j / sub) * fill) / count) * TAU;
        const a1 = rot + ((i + ((j + 1) / sub) * fill) / count) * TAU;
        line(r * Math.cos(a0), r * Math.sin(a0), r * Math.cos(a1), r * Math.sin(a1));
      }
    }
  }

  function ticks(r0, r1, count, rot) {
    for (let i = 0; i < count; i++) {
      const a = rot + (i / count) * TAU;
      line(r0 * Math.cos(a), r0 * Math.sin(a), r1 * Math.cos(a), r1 * Math.sin(a));
    }
  }

  function brackets(o, l) {
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      line(sx * o, sy * o, sx * (o - l), sy * o);
      line(sx * o, sy * o, sx * o, sy * (o - l));
    }
  }

  /** corners: four {x, y} screen points in loop order, or null. level: 0..6, set by the extra raised fingers. */
  function update(pts, level, dt, t, tint) {
    if (pts) {
      if (!have) {
        pts.forEach((q, i) => Object.assign(corners[i], q));
        grow = 0;
        growV = 0;
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
    growV += (260 * ((pts ? 1 : 0) - grow) - 16 * growV) * dt;
    grow += growV * dt;

    mesh.visible = grow > 0.02;
    if (!mesh.visible) return;

    // Shrink the pattern around the square's centre while it opens.
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    const saved = corners.map((c) => ({ x: c.x, y: c.y }));
    for (const c of corners) {
      c.x = cx + (c.x - cx) * grow;
      c.y = cy + (c.y - cy) * grow;
    }

    // Frame axes: u runs corner 0 -> 1, v runs corner 0 -> 3.
    const [c0, c1, c2, c3] = corners;
    const len = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    let ax = c1.x - c0.x + c2.x - c3.x;
    let ay = c1.y - c0.y + c2.y - c3.y;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    let bx = c3.x - c0.x + c2.x - c1.x;
    let by = c3.y - c0.y + c2.y - c1.y;
    const dot = bx * ax + by * ay;
    bx -= ax * dot;
    by -= ay * dot;
    const bl = Math.hypot(bx, by) || 1;
    Object.assign(rect, {
      cx,
      cy,
      ax,
      ay,
      bx: bx / bl,
      by: by / bl,
      r: Math.min(len(c0, c1) + len(c3, c2), len(c0, c3) + len(c1, c2)) / 4,
    });

    n = 0;
    arr = buffer.array;
    round = false;
    // The frame itself: always there, joins the four fingertips.
    poly(4, Math.SQRT2, Math.PI / 4);
    brackets(1.08, 0.22);
    round = true;
    if (level >= 1) poly(64, 0.96, 0);
    if (level >= 2) {
      poly(64, 0.8, 0);
      ticks(0.8, 0.96, 36, t * 0.5);
    }
    if (level >= 3) {
      poly(3, 0.8, t * 0.4 - Math.PI / 2);
      poly(3, 0.8, t * 0.4 + Math.PI / 2);
    }
    if (level >= 4) {
      poly(8, 0.66, -t * 0.7, 3);
      poly(48, 0.42, 0);
    }
    if (level >= 5) {
      ticks(0.2, 0.34, 12, t * 1.4);
      poly(48, 0.2, 0);
      arcs(1.14, 8, 0.7, t * 0.35);
    }
    if (level >= 6) {
      arcs(1.3, 12, 0.5, -t * 0.5, 3);
      for (let i = 0; i < 6; i++) {
        const a = t * 0.35 + (i / 6) * TAU;
        for (let j = 0; j < 12; j++) {
          const b0 = (j / 12) * TAU;
          const b1 = ((j + 1) / 12) * TAU;
          const ox = 1.14 * Math.cos(a);
          const oy = 1.14 * Math.sin(a);
          line(ox + 0.08 * Math.cos(b0), oy + 0.08 * Math.sin(b0), ox + 0.08 * Math.cos(b1), oy + 0.08 * Math.sin(b1));
        }
      }
    }

    corners.forEach((c, i) => Object.assign(c, saved[i]));
    geometry.instanceCount = n;
    buffer.needsUpdate = true;

    const a = Math.min(1, grow);
    mesh.material.color.copy(tint).multiplyScalar(a);
    mesh.material.opacity = a;
  }

  function resize(w, h) {
    mesh.material.resolution.set(w, h);
  }

  return { update, resize, color: COLOR };
}
