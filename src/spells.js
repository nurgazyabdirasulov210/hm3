// Doctor Strange style sorcery: a toolkit of mandala elements (rings, rune bands, star polygons, nested squares,
// spokes, orbiting circles, spirals) and the spell designs built from them.
//
// Every element is prebuilt once into a flat list of line segments in unit coordinates (radius 1 = the spell's
// radius), each with a draw-in parameter range [sa, sb] and a random dissolve threshold. Per frame an element is
// only rotated, swept (drawn up to `sweep`, so rings draw themselves in) and dissolved (segments drop out in random
// order and drift outward), then written into a preallocated LineSegments2 buffer: no allocations per frame.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOut = (t) => 1 - (1 - t) ** 3;

// --- colour -----------------------------------------------------------------
// Heat 0..1: deep ember orange -> orange (#ff9a2e) -> amber -> hot white-yellow core. Linear RGB.
const STOPS = [0xc8420a, 0xff9a2e, 0xffc35a, 0xfff4d6].map((c) => new THREE.Color(c));
export function heatColor(h, out) {
  const x = clamp01(h) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  out[0] = a.r + (b.r - a.r) * f;
  out[1] = a.g + (b.g - a.g) * f;
  out[2] = a.b + (b.b - a.b) * f;
  return out;
}

// Seeded RNG (mulberry32): rune bands and dissolve orders are the same on every run.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap hash noise for per-frame flicker (no state, no allocation).
export const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// --- material / layer -------------------------------------------------------
/**
 * Line material with per-segment colours whose alpha follows the brightest channel, so a dim (fading) segment is
 * also transparent: correct premultiplied output over the video. `additive`: glow adds up (sparks); otherwise MAX
 * blending like the figure, so overlapping lines never bead.
 */
export function spellMaterial(width, additive = false) {
  const m = new LineMaterial({
    linewidth: width,
    vertexColors: true,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: additive ? THREE.AddEquation : THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
  m.fragmentShader = m.fragmentShader.replace(
    '#include <colorspace_fragment>',
    '#include <colorspace_fragment>\n\tgl_FragColor.a = alpha * max( gl_FragColor.r, max( gl_FragColor.g, gl_FragColor.b ) );',
  );
  return m;
}

/**
 * A preallocated LineSegments2 buffer drawn twice: a wide dim halo and a thin hot core on top.
 * begin() ... seg() ... end() once per frame.
 */
export function createLayer(scene, maxSegs, { core = 1.7, halo = 6.5, haloGain = 0.3, additive = false, order = 0 } = {}) {
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(new Float32Array(maxSegs * 6));
  geometry.setColors(new Float32Array(maxSegs * 6));
  const pos = geometry.attributes.instanceStart.data;
  const col = geometry.attributes.instanceColorStart.data;
  const meshes = [];
  for (const [w, gain] of [[halo, haloGain], [core, 1]]) {
    if (!w) continue;
    const mesh = new LineSegments2(geometry, spellMaterial(w, additive));
    mesh.material.color.setScalar(gain);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = order + meshes.length;
    scene.add(mesh);
    meshes.push(mesh);
  }
  const layer = {
    n: 0,
    max: maxSegs,
    pos: pos.array,
    begin() {
      layer.n = 0;
    },
    /** Screen-space segment (y down), colour rgb at the start and rgb2 at the end (premultiplied brightness). */
    seg(x0, y0, x1, y1, r, g, b, r2 = r, g2 = g, b2 = b) {
      if (layer.n >= maxSegs) return;
      const o = layer.n++ * 6;
      const p = pos.array;
      p[o] = x0;
      p[o + 1] = -y0;
      p[o + 2] = 0;
      p[o + 3] = x1;
      p[o + 4] = -y1;
      p[o + 5] = 0;
      const c = col.array;
      c[o] = r;
      c[o + 1] = g;
      c[o + 2] = b;
      c[o + 3] = r2;
      c[o + 4] = g2;
      c[o + 5] = b2;
    },
    end(opacity = 1) {
      geometry.instanceCount = layer.n;
      pos.needsUpdate = true;
      col.needsUpdate = true;
      for (const m of meshes) {
        m.visible = layer.n > 0;
        m.material.opacity = opacity;
      }
    },
    resize(w, h) {
      for (const m of meshes) m.material.resolution.set(w, h);
    },
  };
  return layer;
}

// --- element builders (unit space, built once) --------------------------------
// A segment is [x0, y0, x1, y1, sa, sb]: drawn once the sweep passes sa, fully at sb.
const S = 6;

function finish(list, opts, seed) {
  const r = rng(seed);
  const n = list.length / S;
  const segs = new Float32Array(n * 7);
  // Sorted by sa, so drawing can stop at the sweep front.
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => list[a * S + 4] - list[b * S + 4]);
  idx.forEach((k, i) => {
    for (let j = 0; j < S; j++) segs[i * 7 + j] = list[k * S + j];
    segs[i * 7 + 6] = r();
  });
  return {
    segs,
    count: n,
    speed: 0,
    phase: 0,
    heat: 0.5,
    alpha: 1,
    level: 0,
    delay: null,
    dur: 0.5,
    breathe: 0,
    ...opts,
  };
}

let seedCounter = 1;
const el = (list, opts = {}) => finish(list, opts, opts.seed ?? seedCounter++ * 7919);

function arcPts(list, r, a0, a1, n, s0 = 0, s1 = 1, cx = 0, cy = 0) {
  for (let i = 0; i < n; i++) {
    const p = a0 + ((a1 - a0) * i) / n;
    const q = a0 + ((a1 - a0) * (i + 1)) / n;
    list.push(
      cx + r * Math.cos(p),
      cy + r * Math.sin(p),
      cx + r * Math.cos(q),
      cy + r * Math.sin(q),
      s0 + ((s1 - s0) * i) / n,
      s0 + ((s1 - s0) * (i + 1)) / n,
    );
  }
  return list;
}
const ringSegs = (r) => Math.max(24, Math.round(40 + 56 * r));

/** Full circle. */
export const ring = (r, o) => el(arcPts([], r, 0, TAU, ringSegs(r)), o);

/** `count` arcs, each covering `fill` of its slot; drawn in one sweep around. */
export function arcs(r, count, fill, o) {
  const list = [];
  const sub = Math.max(2, Math.round((ringSegs(r) * fill) / count));
  for (let i = 0; i < count; i++) {
    const a0 = (i / count) * TAU;
    arcPts(list, r, a0, a0 + (fill / count) * TAU, sub, i / count, (i + fill) / count);
  }
  return el(list, o);
}

/** Radial ticks between r0 and r1; every `major`-th one reaches r2. */
export function ticks(r0, r1, count, o = {}) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    const rr = o.major && i % o.major === 0 ? o.r2 ?? r1 + (r1 - r0) : r1;
    list.push(r0 * Math.cos(a), r0 * Math.sin(a), rr * Math.cos(a), rr * Math.sin(a), i / count, i / count);
  }
  return el(list, o);
}

/** Star polygon {n/k} with circumradius r (k = 1: regular polygon). */
export function star(n, k, r, o = {}) {
  const list = [];
  const rot = o.rot ?? -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const b = rot + (((i + k) % n) / n) * TAU;
    list.push(r * Math.cos(a), r * Math.sin(a), r * Math.cos(b), r * Math.sin(b), i / n, (i + 1) / n);
  }
  return el(list, o);
}

/** `count` nested squares, each rotated 45° to the last and inscribed in it. */
export function squares(r, count, o = {}) {
  const list = [];
  let rr = r;
  for (let j = 0; j < count; j++) {
    const rot = (o.rot ?? 0) + (j * Math.PI) / 4;
    for (let i = 0; i < 4; i++) {
      const a = rot + (i / 4) * TAU;
      const b = rot + ((i + 1) / 4) * TAU;
      const s = (j + i / 4) / count;
      list.push(rr * Math.cos(a), rr * Math.sin(a), rr * Math.cos(b), rr * Math.sin(b), s, s + 0.25 / count);
    }
    rr *= Math.SQRT1_2;
  }
  return el(list, o);
}

/** Small circles of radius rs evenly spaced on radius R (optionally with an inner ring / dot). */
export function orbit(R, count, rs, o = {}) {
  const list = [];
  const sub = Math.max(10, Math.round(rs * 160));
  for (let i = 0; i < count; i++) {
    const a = (o.rot ?? 0) + (i / count) * TAU;
    const cx = R * Math.cos(a);
    const cy = R * Math.sin(a);
    arcPts(list, rs, a, a + TAU, sub, i / count, (i + 0.8) / count, cx, cy);
    if (o.inner) arcPts(list, rs * o.inner, a, a + TAU, Math.ceil(sub * 0.6), (i + 0.4) / count, (i + 0.9) / count, cx, cy);
    if (o.dot) list.push(cx - rs * 0.12, cy, cx + rs * 0.12, cy, (i + 0.8) / count, (i + 0.8) / count);
  }
  return el(list, o);
}

/** Archimedean spiral arms from r0 to r1 over `turns` revolutions. */
export function spiral(r0, r1, turns, arms, o = {}) {
  const list = [];
  const n = Math.round(60 * turns + 20);
  for (let k = 0; k < arms; k++) {
    const a0 = (k / arms) * TAU;
    for (let i = 0; i < n; i++) {
      const f0 = i / n;
      const f1 = (i + 1) / n;
      const p = a0 + (o.dir ?? 1) * turns * TAU * f0;
      const q = a0 + (o.dir ?? 1) * turns * TAU * f1;
      const ra = r0 + (r1 - r0) * f0;
      const rb = r0 + (r1 - r0) * f1;
      list.push(ra * Math.cos(p), ra * Math.sin(p), rb * Math.cos(q), rb * Math.sin(q), f0, f1);
    }
  }
  return el(list, o);
}

/** Almond (vesica) shape: two circular arcs through (±w, 0) bulging to ±h. */
export function almond(w, h, o = {}) {
  const list = [];
  const R = (w * w + h * h) / (2 * h);
  const half = Math.asin(w / R);
  const n = 28;
  for (const side of [1, -1]) {
    const cy = -side * (R - h);
    for (let i = 0; i < n; i++) {
      const p = -half + (2 * half * i) / n;
      const q = -half + (2 * half * (i + 1)) / n;
      // Both lids draw from the left corner to the right one.
      list.push(
        R * Math.sin(p),
        cy + side * R * Math.cos(p),
        R * Math.sin(q),
        cy + side * R * Math.cos(q),
        i / n,
        (i + 1) / n,
      );
    }
  }
  return el(list, o);
}

/** Straight segments (rays, chords) given as [x0, y0, x1, y1, ...], drawn in order. */
export function lines(pts, o = {}) {
  const list = [];
  const n = pts.length / 4;
  for (let i = 0; i < n; i++) list.push(pts[i * 4], pts[i * 4 + 1], pts[i * 4 + 2], pts[i * 4 + 3], i / n, (i + 1) / n);
  return el(list, o);
}

/** Radial spokes in `count` sectors (r0..r1), optionally fanned in pairs. */
export function spokes(r0, r1, count, o = {}) {
  const list = [];
  const fan = o.fan ?? 0;
  for (let i = 0; i < count; i++) {
    const a = (o.rot ?? 0) + (i / count) * TAU;
    for (const d of fan ? [-fan, fan] : [0]) {
      list.push(r0 * Math.cos(a), r0 * Math.sin(a), r1 * Math.cos(a + d), r1 * Math.sin(a + d), i / count, (i + 1) / count);
    }
  }
  return el(list, o);
}

// --- rune glyphs ------------------------------------------------------------
// Procedural Sanskrit- / Theban-like glyphs in a cell x 0..1 (along the ring), y 0..1 (outward): short angular
// strokes between points of a 3x3 grid, small arcs, hooks and dots. Never real letters.
const GX = [0.12, 0.5, 0.88];
const GY = [0.08, 0.5, 0.92];

function glyph(r, headline) {
  const out = [];
  const seg = (x0, y0, x1, y1) => out.push(x0, y0, x1, y1);
  const stemX = GX[Math.floor(r() * 3)];
  if (r() < 0.75) seg(stemX, GY[0], stemX, headline ? 0.92 : GY[2]);
  const strokes = 1 + Math.floor(r() * 2.6);
  for (let s = 0; s < strokes; s++) {
    const i = Math.floor(r() * 3);
    const j = Math.floor(r() * 3);
    let di = Math.floor(r() * 3) - 1;
    let dj = Math.floor(r() * 3) - 1;
    if (!di && !dj) di = i < 2 ? 1 : -1;
    const i2 = Math.min(2, Math.max(0, i + di));
    const j2 = Math.min(2, Math.max(0, j + dj));
    if (i2 === i && j2 === j) continue;
    seg(GX[i], GY[j], GX[i2], GY[j2]);
  }
  const extra = r();
  if (extra < 0.4) {
    // Small arc (a bowl or a hook) around a grid point.
    const cx = GX[Math.floor(r() * 3)];
    const cy = 0.3 + r() * 0.35;
    const rad = 0.18 + r() * 0.14;
    const a0 = Math.floor(r() * 4) * (Math.PI / 2);
    const span = Math.PI * (r() < 0.5 ? 1 : 1.5);
    for (let k = 0; k < 4; k++) {
      const p = a0 + (span * k) / 4;
      const q = a0 + (span * (k + 1)) / 4;
      seg(cx + rad * Math.cos(p), cy + rad * Math.sin(p), cx + rad * Math.cos(q), cy + rad * Math.sin(q));
    }
  } else if (extra < 0.65) {
    // Chevron.
    const y = GY[Math.floor(r() * 2)];
    seg(0.15, y + 0.35, 0.5, y);
    seg(0.5, y, 0.85, y + 0.35);
  }
  if (r() < 0.45) {
    // Dot: a very short stroke reads as a dot at this line width.
    const x = 0.2 + r() * 0.6;
    const y = r() < 0.5 ? 0.0 : 0.62;
    seg(x, y, x + 0.04, y + 0.04);
  }
  if (headline) seg(-0.12, 0.92, 1.12, 0.92); // joined top bar, as in Devanagari
  return out;
}

/**
 * Band of procedural glyphs between radii r0 and r1, `count` glyph slots, deterministic per seed.
 * o.headline joins the glyphs with a top bar; o.fill is the share of each slot a glyph takes.
 */
export function runes(r0, r1, count, seed, o = {}) {
  const r = rng(seed);
  const list = [];
  const fill = o.fill ?? 0.7;
  const map = (i, x, y) => {
    const a = ((i + (1 - fill) / 2 + fill * x) / count) * TAU;
    const rr = r0 + (r1 - r0) * y;
    return [rr * Math.cos(a), rr * Math.sin(a)];
  };
  for (let i = 0; i < count; i++) {
    if (o.gaps && r() < o.gaps) continue;
    const g = glyph(r, o.headline);
    for (let k = 0; k < g.length; k += 4) {
      const [x0, y0] = map(i, g[k], g[k + 1]);
      const [x1, y1] = map(i, g[k + 2], g[k + 3]);
      list.push(x0, y0, x1, y1, i / count, (i + 1) / count);
    }
  }
  return el(list, { seed, ...o });
}

/** Rune band framed by two rings, all turning together. Returns several elements. */
export function band(r0, r1, count, seed, o = {}) {
  const pad = (r1 - r0) * 0.16;
  return [
    ring(r1, { ...o, heat: (o.heat ?? 0.5) - 0.1 }),
    runes(r0 + pad, r1 - pad, count, seed, { ...o }),
    ring(r0, { ...o, heat: (o.heat ?? 0.5) - 0.1 }),
  ];
}

// Dynamic, per-frame element: a crackling (jittering) ring, the look of a sling-ring portal's edge.
export const crackle = (r, o = {}) => ({ dynamic: 'crackle', r, n: o.n ?? 120, amp: o.amp ?? 0.025, ...finish([], o, 1) });

// --- drawing ------------------------------------------------------------------
/**
 * Mapping from unit space to the screen: centre (cx, cy), orthonormal axes a, b (screen px directions), radius r.
 * `pen` reports the last sweep front drawn (for sparks at the tip of a ring drawing itself).
 */
export function createFrame() {
  return { cx: 0, cy: 0, ax: 1, ay: 0, bx: 0, by: 1, r: 1, pen: { x: 0, y: 0, on: false, heat: 0 } };
}

const rgb = [0, 0, 0];

/**
 * Draws one element into the layer. sweep 0..1: draw-in; fade 0..1: dissolve (1 = solid); gain: brightness.
 */
export function drawElement(layer, f, e, t, sweep, fade, gain) {
  if (sweep <= 0 || fade <= 0) return;
  const ang = e.phase + e.speed * t;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const sc = 1 + (e.breathe ? e.breathe * Math.sin(t * 2.1 + e.phase) : 0);
  heatColor(e.heat + (fade < 1 ? (1 - fade) * 0.3 : 0), rgb);
  const k0 = e.alpha * gain;
  const R = f.r;
  // Dynamic crackle ring.
  if (e.dynamic === 'crackle') {
    const n = e.n;
    const frame = Math.floor(t * 24);
    const lim = Math.ceil(n * sweep);
    let px = 0;
    let py = 0;
    for (let i = 0; i <= lim && i <= n; i++) {
      const a = ang + (i / n) * TAU;
      const jit = (hash(i * 13.7 + frame * 3.1 + e.phase) - 0.5) * 2 * e.amp + (hash(i * 3.3 + frame) < 0.06 ? e.amp * 2.5 : 0);
      const rr = e.r * (1 + jit) * sc;
      const u = rr * Math.cos(a);
      const v = rr * Math.sin(a);
      const x = f.cx + R * (u * f.ax + v * f.bx);
      const y = f.cy + R * (u * f.ay + v * f.by);
      if (i > 0) {
        const h = hash(i * 7.1 + e.phase);
        const kk = fade < 1 ? smooth(h * 0.7, h * 0.7 + 0.3, fade) : 1;
        const fl = k0 * kk * (0.75 + 0.25 * hash(i + frame * 7.7));
        if (kk > 0.01) layer.seg(px, py, x, y, rgb[0] * fl, rgb[1] * fl, rgb[2] * fl);
      }
      px = x;
      py = y;
    }
    if (sweep < 1) {
      f.pen.x = px;
      f.pen.y = py;
      f.pen.on = true;
    }
    return;
  }
  const g = e.segs;
  for (let i = 0; i < e.count; i++) {
    const o = i * 7;
    const sa = g[o + 4];
    if (sweep <= sa) break;
    const sb = g[o + 5];
    let x0 = g[o];
    let y0 = g[o + 1];
    let x1 = g[o + 2];
    let y1 = g[o + 3];
    let partial = false;
    if (sweep < sb && sb > sa) {
      const q = (sweep - sa) / (sb - sa);
      x1 = x0 + (x1 - x0) * q;
      y1 = y0 + (y1 - y0) * q;
      partial = true;
    }
    let k = 1;
    let d = sc;
    if (fade < 1) {
      const h = g[o + 6];
      // The survivors dim too, so the last pieces burn out instead of hanging on at full brightness.
      k = smooth(h * 0.75, h * 0.75 + 0.25, fade) * (0.35 + 0.65 * fade);
      if (k < 0.01) continue;
      d = sc * (1 + (1 - k) * 0.22);
    }
    const u0 = (x0 * c - y0 * s) * d;
    const v0 = (x0 * s + y0 * c) * d;
    const u1 = (x1 * c - y1 * s) * d;
    const v1 = (x1 * s + y1 * c) * d;
    const X0 = f.cx + R * (u0 * f.ax + v0 * f.bx);
    const Y0 = f.cy + R * (u0 * f.ay + v0 * f.by);
    const X1 = f.cx + R * (u1 * f.ax + v1 * f.bx);
    const Y1 = f.cy + R * (u1 * f.ay + v1 * f.by);
    const kk = k * k0;
    if (partial) {
      // The pen tip burns white-hot.
      layer.seg(X0, Y0, X1, Y1, rgb[0] * kk, rgb[1] * kk, rgb[2] * kk, 1.4 * kk, 1.3 * kk, 1.1 * kk);
      f.pen.x = X1;
      f.pen.y = Y1;
      f.pen.on = true;
    } else layer.seg(X0, Y0, X1, Y1, rgb[0] * kk, rgb[1] * kk, rgb[2] * kk);
  }
}

// --- designs ----------------------------------------------------------------
// Each design: { name, elements, rim (spark radius), sparks (base rate /s at level 0), perLevel (extra rate),
// dir (spark spin direction) }. Elements carry `level` (the portal level that shows them).
// Elements are drawn in to the order listed (delay), outer first, so a spell sweeps in from the rim.

function design(name, elements, o = {}) {
  const els = elements.flat();
  const n = els.length;
  els.forEach((e, i) => {
    if (e.delay === null) e.delay = n > 1 ? (0.5 * i) / (n - 1) : 0;
  });
  return { name, elements: els, rim: 1, sparks: 40, perLevel: 30, dir: 1, spark: 2.2, ...o };
}

const sq = Math.SQRT1_2;

export const PORTAL_DESIGNS = [
  // 0 — the sling-ring portal: a crackling ring of fire throwing a shower of sparks.
  design(
    'кольцо-портал',
    [
      crackle(1.0, { speed: 2.6, heat: 0.95, amp: 0.02 }),
      crackle(0.975, { speed: -1.9, heat: 0.55, amp: 0.03, phase: 1.3, alpha: 0.8 }),
      arcs(1.05, 28, 0.35, { speed: 3.2, heat: 0.75, alpha: 0.8 }),
      runes(0.86, 0.94, 40, 101, { speed: -0.5, heat: 0.5, level: 1, alpha: 0.75 }),
      ring(0.84, { speed: -0.5, heat: 0.3, level: 2, alpha: 0.6 }),
      ticks(0.78, 0.83, 72, { speed: 0.6, heat: 0.4, level: 2, alpha: 0.6, major: 6, r2: 0.75 }),
      arcs(1.16, 7, 0.55, { speed: -1.1, heat: 0.45, level: 3 }),
      crackle(1.1, { speed: 1.5, heat: 0.6, amp: 0.035, level: 3, alpha: 0.6, phase: 2.2 }),
    ],
    { sparks: 230, perLevel: 110, rim: 1.0, dir: 1, spark: 2.6 },
  ),

  // 1 — classic Kamar-Taj triple-ring mandala with an octagram of two squares.
  design('мандала Камар-Тадж', [
    band(0.9, 1.0, 36, 211, { speed: 0.22, heat: 0.55 }),
    ticks(0.82, 0.87, 72, { speed: -0.35, heat: 0.4, major: 4, r2: 0.9 }),
    star(8, 2, 0.82, { speed: 0.3, heat: 0.65 }),
    ring(0.72, { speed: 0, heat: 0.5 }),
    band(0.46, 0.56, 20, 223, { speed: -0.55, heat: 0.75, level: 1, headline: true }),
    star(6, 2, 0.44, { speed: 0.7, heat: 0.85, level: 1 }),
    ring(0.16, { heat: 1 }),
    spokes(0.16, 0.36, 12, { speed: -1.1, heat: 0.95, level: 3 }),
    arcs(1.1, 8, 0.7, { speed: 0.45, heat: 0.45, level: 2 }),
    orbit(1.1, 4, 0.06, { speed: 0.45, heat: 0.6, level: 2, rot: Math.PI / 4 + 0.04, inner: 0.5 }),
    arcs(1.22, 12, 0.42, { speed: -0.35, heat: 0.35, level: 3, alpha: 0.85 }),
  ]),

  // 2 — square-in-square seal: nested squares turning in alternating directions.
  design('печать квадратов', [
    band(1.0, 1.1, 40, 307, { speed: -0.18, heat: 0.5 }),
    squares(1.0, 1, { speed: 0.25, heat: 0.65 }),
    squares(1.0, 1, { speed: 0.25, heat: 0.65, rot: Math.PI / 4 }),
    ring(sq, { heat: 0.55 }),
    squares(sq, 2, { speed: -0.4, heat: 0.75, level: 1 }),
    ring(0.5, { heat: 0.7, level: 1 }),
    squares(0.5, 3, { speed: 0.6, heat: 0.9 }),
    ring(0.12, { heat: 1 }),
    orbit(1.0, 8, 0.055, { speed: 0.25, heat: 0.7, level: 2, inner: 0.45 }),
    runes(0.53, 0.66, 16, 311, { speed: -0.4, heat: 0.65, level: 2 }),
    ticks(1.12, 1.17, 96, { speed: 0.12, heat: 0.35, level: 3, major: 8, r2: 1.22 }),
  ]),

  // 3 — hexagram seal with circled points.
  design('печать гексаграммы', [
    band(0.9, 1.0, 30, 401, { speed: -0.22, heat: 0.5 }),
    star(6, 2, 0.9, { speed: 0.3, heat: 0.75 }),
    orbit(0.9, 6, 0.085, { speed: 0.3, heat: 0.8, rot: -Math.PI / 2, inner: 0.45, level: 1 }),
    ring(0.52, { heat: 0.6 }),
    star(6, 1, 0.52, { speed: 0.3, heat: 0.6, rot: -Math.PI / 2 + Math.PI / 6, level: 1 }),
    star(6, 2, 0.45, { speed: -0.6, heat: 0.95 }),
    ring(0.18, { heat: 1 }),
    spokes(0.52, 0.86, 6, { speed: 0.3, heat: 0.5, rot: -Math.PI / 2 + Math.PI / 6, level: 2 }),
    ticks(1.02, 1.07, 120, { speed: 0.2, heat: 0.4, level: 2, major: 10, r2: 1.12 }),
    arcs(1.18, 6, 0.8, { speed: -0.5, heat: 0.45, level: 3 }),
  ]),

  // 4 — the Eye of Agamotto: an almond eye with iris rings, lashes of light and a turning outer seal.
  design('Глаз Агамотто', [
    band(0.9, 1.0, 32, 503, { speed: 0.2, heat: 0.5 }),
    almond(0.82, 0.4, { heat: 0.85, delay: 0.15 }),
    almond(0.88, 0.5, { heat: 0.55, delay: 0.2, level: 1 }),
    ring(0.3, { heat: 0.9 }),
    ticks(0.21, 0.29, 36, { speed: 0.9, heat: 0.95 }),
    almond(0.17, 0.07, { heat: 1, delay: 0.45, phase: Math.PI / 2 }),
    lines(
      [...Array(7)].flatMap((_, i) => {
        const x = -0.45 + i * 0.15;
        const top = 0.4 * (1 - (x / 0.82) ** 2);
        return [x, -top - 0.08, x * 1.25, -top - 0.24 + Math.abs(x) * 0.1, x, top + 0.08, x * 1.25, top + 0.24 - Math.abs(x) * 0.1];
      }),
      { heat: 0.7, level: 2 },
    ),
    ring(0.38, { heat: 0.6, level: 1 }),
    arcs(1.1, 3, 0.8, { speed: -0.4, heat: 0.45, level: 2 }),
    orbit(1.1, 3, 0.05, { speed: -0.4, heat: 0.6, level: 2, rot: 0.9 * TAU / 3 - 0.09, dot: true }),
    star(8, 3, 0.86, { speed: -0.15, heat: 0.3, level: 3, alpha: 0.55 }),
  ]),

  // 5 — Dormammu's time loop: spiral arms, clock rings and hands turning at different rates.
  design('петля времени', [
    ring(1.0, { heat: 0.55 }),
    ticks(0.9, 0.96, 60, { speed: -0.3, heat: 0.45, major: 5, r2: 0.99 }),
    spiral(0.12, 0.88, 1.25, 3, { speed: 1.3, heat: 0.75 }),
    ring(0.62, { heat: 0.55 }),
    lines([0, 0, 0.55, 0], { speed: 0.8, heat: 1, delay: 0.4 }),
    lines([0, 0, 0, -0.8], { speed: -0.2, heat: 0.95, delay: 0.45 }),
    ring(0.1, { heat: 1 }),
    band(0.64, 0.74, 24, 601, { speed: 0.45, heat: 0.6, level: 1 }),
    orbit(0.82, 12, 0.04, { speed: -0.3, heat: 0.7, level: 2, dot: true }),
    spiral(0.15, 0.6, 0.8, 3, { speed: -2.1, heat: 0.8, dir: -1, level: 3, alpha: 0.7 }),
    arcs(1.12, 4, 0.6, { speed: 0.9, heat: 0.45, level: 3 }),
    arcs(1.2, 9, 0.35, { speed: -0.7, heat: 0.35, level: 3 }),
  ], { dir: -1 }),

  // 6 — a Seraphim-style dense disc of rune bands and stars.
  design('диск Серафима', [
    band(0.88, 1.0, 44, 701, { speed: 0.18, heat: 0.5 }),
    star(12, 5, 0.86, { speed: -0.25, heat: 0.6 }),
    band(0.6, 0.7, 30, 709, { speed: 0.4, heat: 0.65, headline: true }),
    star(8, 3, 0.58, { speed: -0.5, heat: 0.8, level: 1 }),
    band(0.3, 0.38, 14, 719, { speed: 0.7, heat: 0.85, level: 1 }),
    squares(0.28, 2, { speed: -0.9, heat: 0.95 }),
    ticks(0.78, 0.84, 96, { speed: 0.25, heat: 0.4, level: 2 }),
    spokes(0.4, 0.58, 16, { speed: -0.5, heat: 0.6, level: 2, fan: 0.05 }),
    arcs(1.1, 16, 0.5, { speed: -0.3, heat: 0.4, level: 3 }),
    orbit(1.1, 8, 0.04, { speed: 0.5, heat: 0.6, level: 3, dot: true }),
  ]),

  // 7 — the star of the Vishanti: an eight-pointed {8/3} star with sector spokes and a pentagram heart.
  design('звезда Вишанти', [
    ring(1.0, { heat: 0.55 }),
    star(8, 3, 1.0, { speed: 0.22, heat: 0.75 }),
    orbit(1.0, 8, 0.06, { speed: 0.22, heat: 0.75, rot: -Math.PI / 2, dot: true, level: 1 }),
    ring(0.4, { heat: 0.6 }),
    spokes(0.4, 0.92, 8, { speed: 0.22, heat: 0.45, rot: -Math.PI / 2 + Math.PI / 8, fan: 0.12, level: 1 }),
    star(5, 2, 0.38, { speed: -0.5, heat: 0.95 }),
    ring(0.12, { heat: 1 }),
    band(1.02, 1.12, 40, 811, { speed: -0.2, heat: 0.45, level: 2 }),
    star(8, 2, 0.4, { speed: 0.6, heat: 0.7, level: 2, alpha: 0.7 }),
    arcs(1.22, 8, 0.6, { speed: 0.4, heat: 0.4, level: 3 }),
    ticks(1.14, 1.18, 64, { speed: 0.4, heat: 0.4, level: 3 }),
  ]),
];

// The Shield of the Seraphim: a dense flat disc, no levels.
export const SHIELD_DESIGN = design(
  'щит Серафима',
  [
    ring(1.0, { heat: 0.6 }),
    ticks(0.95, 0.99, 120, { speed: 0.3, heat: 0.5, major: 6, r2: 1.03 }),
    band(0.8, 0.93, 40, 907, { speed: -0.35, heat: 0.6 }),
    star(16, 7, 0.79, { speed: 0.45, heat: 0.55, alpha: 0.85 }),
    ring(0.6, { heat: 0.7 }),
    band(0.47, 0.58, 24, 911, { speed: 0.7, heat: 0.8, headline: true }),
    squares(0.46, 2, { speed: -0.8, heat: 0.85 }),
    star(6, 2, 0.3, { speed: 1.1, heat: 0.95 }),
    spokes(0.06, 0.24, 12, { speed: -1.4, heat: 1 }),
    ring(0.07, { heat: 1 }),
  ],
  { sparks: 40, rim: 1.0, spark: 1.6 },
);

export function segmentsOf(d, level = 3) {
  let n = 0;
  for (const e of d.elements) if (e.level <= level) n += e.dynamic ? e.n + 1 : e.count;
  return n;
}

// --- spell state: draw-in / dissolve ----------------------------------------
export const DRAW_TIME = 1.1; // s for a spell to draw itself in
export const DISSOLVE_TIME = 0.55; // s to dissolve

/** Draw-in / dissolve state of one spell: draw 0..1 (sweeps in), fade 0..1 (dissolves). */
export function spellState() {
  return { on: false, draw: 0, fade: 0, levels: [1, 0, 0, 0] };
}

export function stepSpell(st, on, level, dt) {
  st.on = on;
  if (on) {
    st.fade = Math.min(1, st.fade + dt / 0.25);
    st.draw = Math.min(1, st.draw + dt / DRAW_TIME);
  } else {
    st.fade = Math.max(0, st.fade - dt / DISSOLVE_TIME);
    if (st.fade === 0) st.draw = 0;
  }
  for (let l = 1; l < 4; l++) {
    const up = l <= level;
    st.levels[l] = up ? Math.min(1, st.levels[l] + dt / 0.7) : Math.max(0, st.levels[l] - dt / 0.45);
  }
}

/** Draws a whole design. Returns nothing; the frame's pen is updated. */
export function drawDesign(layer, f, d, st, t, gain) {
  // A spell that is dissolving away has been fully drawn: it crumbles, it does not rewind.
  const P = st.on ? st.draw : Math.max(st.draw, 1);
  for (const e of d.elements) {
    let sw = easeOut(clamp01((P - e.delay) / e.dur));
    if (e.level > 0) sw = Math.min(sw, easeOut(st.levels[e.level]));
    drawElement(layer, f, e, t, sw, st.fade, gain);
  }
}
