import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { lineMaterial } from './figure.js';

// Solids for the "joined hands" mode, indexed by the number of raised fingers on both hands (0..10).
// Ordered so that neighbours (one finger more or less) look clearly different.
export const SOLID_KEYS = [
  'sphere', // 0
  'tetra', // 1
  'torus', // 2
  'octa', // 3
  'knot', // 4
  'icosa', // 5
  'helix', // 6
  'dodeca', // 7
  'merkaba', // 8
  'geo', // 9
  'tesseract', // 10: both hands open
];
export const MIDDLE = 'middle';
// Single-hand special gestures (finger mask: bit 0 thumb .. bit 4 pinky) that override the prism-by-count.
export const SPECIAL_KEYS = {
  0b00001: 'star', // thumb up
  0b10001: 'mobius', // thumb + pinky, "call me"
  0b10010: 'crystal', // index + pinky, "rock"
  0b10000: 'diamond', // pinky only
};

// Short display names (Russian, for the HUD): every solid key, plus the prism figure by finger count.
export const SHAPE_NAMES = {
  sphere: 'сфера',
  tetra: 'тетраэдр',
  torus: 'тор',
  octa: 'октаэдр',
  knot: 'торический узел',
  icosa: 'икосаэдр',
  helix: 'двойная спираль',
  dodeca: 'додекаэдр',
  merkaba: 'мербаха',
  geo: 'геодезическая сфера',
  tesseract: 'тессеракт',
  star: 'звёздчатый додекаэдр',
  mobius: 'лента Мёбиуса',
  crystal: 'рогатый кристалл',
  diamond: 'бриллиант',
  [MIDDLE]: 'средний палец',
  prism0: 'цилиндр',
  prism1: 'линия',
  prism2: 'плоская рамка',
  prism3: 'треугольная призма',
  prism4: 'куб',
  prism5: 'пятиугольная призма',
};

// Each solid's own colour (the middle-finger fist has none: it takes the tint passed to place()).
export const SOLID_COLORS = {
  sphere: 0x8fb8ff,
  tetra: 0xff7a7a,
  torus: 0xff9fd8,
  octa: 0xffd36e,
  knot: 0xff6bd6,
  icosa: 0x7dffb2,
  helix: 0x6bc8ff,
  dodeca: 0xb28dff,
  merkaba: 0xffc861,
  geo: 0xa8ff60,
  tesseract: 0x7df9ff,
  star: 0xfff27a,
  mobius: 0x9f8bff,
  crystal: 0x8be9ff,
  diamond: 0xe8f4ff,
};

const PHI = (1 + Math.sqrt(5)) / 2;
const TAU = Math.PI * 2;

const edges = (g, angle = 1) => new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(g, angle));
const segments = (arr) => new LineSegmentsGeometry().setPositions(arr);
const push = (arr, a, b) => arr.push(a[0], a[1], a[2], b[0], b[1], b[2]);

// A blocky fist with one raised finger, built from box outlines.
function middleFinger() {
  const boxes = [
    [0, -0.55, 0, 1.0, 0.7, 0.45], // palm
    [-0.375, -0.08, 0.1, 0.22, 0.3, 0.3], // index, curled
    [0.125, -0.08, 0.1, 0.22, 0.3, 0.3], // ring, curled
    [0.375, -0.08, 0.1, 0.22, 0.3, 0.3], // pinky, curled
    [-0.64, -0.45, 0.1, 0.24, 0.42, 0.22], // thumb
    [-0.125, 0.5, 0, 0.22, 1.3, 0.22], // middle, raised
  ];
  const arr = [];
  for (const [cx, cy, cz, w, h, d] of boxes) {
    const g = new THREE.BoxGeometry(w, h, d);
    const e = new THREE.EdgesGeometry(g).attributes.position;
    for (let i = 0; i < e.count; i++) arr.push(e.getX(i) + cx, e.getY(i) + cy - 0.15, e.getZ(i) + cz);
  }
  return segments(arr);
}

// Wire lines of a tube-like grid geometry (TorusKnotGeometry): every strand along the tube, and a ring every few steps.
function gridLines(g, along, around, ringEvery) {
  const p = g.attributes.position;
  const v = (i, j) => [p.getX(i * (around + 1) + j), p.getY(i * (around + 1) + j), p.getZ(i * (around + 1) + j)];
  const arr = [];
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      push(arr, v(i, j), v(i + 1, j));
      if (i % ringEvery === 0) push(arr, v(i, j), v(i, j + 1));
    }
  }
  return segments(arr);
}

// Two tetrahedra interlocked into a star (stella octangula), one pointing up and one down.
function merkaba() {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 1, 1).normalize(), new THREE.Vector3(0, 1, 0));
  const arr = [];
  for (const s of [1, -1]) {
    const vs = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(
      ([x, y, z]) => new THREE.Vector3(s * x, s * y, s * z).multiplyScalar(0.68).applyQuaternion(q).toArray(),
    );
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) push(arr, vs[a], vs[b]);
  }
  return segments(arr);
}

// DNA: two helices half a turn apart around the vertical axis, with base-pair rungs between them.
function helix() {
  const N = 64;
  const turns = 2;
  const R = 0.5;
  const H = 1.15;
  const at = (i, phase) => {
    const a = (i / N) * turns * TAU + phase;
    return [R * Math.cos(a), -H + (2 * H * i) / N, R * Math.sin(a)];
  };
  const arr = [];
  for (let i = 0; i < N; i++) {
    push(arr, at(i, 0), at(i + 1, 0));
    push(arr, at(i, Math.PI), at(i + 1, Math.PI));
  }
  for (let i = 2; i < N; i += 4) push(arr, at(i, 0), at(i, Math.PI));
  return segments(arr);
}

// Small stellated dodecahedron: the 12 icosahedron vertices joined by the 30 pentagram edges (the pairs φ edges apart).
function star() {
  const vs = [];
  for (const a of [-1, 1]) for (const b of [-PHI, PHI]) vs.push([0, a, b], [a, b, 0], [b, 0, a]);
  const s = 1.15 / Math.hypot(1, PHI);
  const arr = [];
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      const d = Math.hypot(vs[i][0] - vs[j][0], vs[i][1] - vs[j][1], vs[i][2] - vs[j][2]);
      if (Math.abs(d - 2 * PHI) < 1e-6) push(arr, vs[i].map((c) => c * s), vs[j].map((c) => c * s));
    }
  }
  return segments(arr);
}

// Möbius strip: both edges (one closed curve), the centre line and cross rungs that show the half twist.
function mobius() {
  const R = 0.78;
  const W = 0.34;
  const N = 72;
  const at = (u, v) => [
    (R + v * Math.cos(u / 2)) * Math.cos(u),
    v * Math.sin(u / 2),
    (R + v * Math.cos(u / 2)) * Math.sin(u),
  ];
  const arr = [];
  for (let i = 0; i < N; i++) {
    const u0 = (i / N) * TAU;
    const u1 = ((i + 1) / N) * TAU;
    for (const v of [-W, 0, W]) push(arr, at(u0, v), at(u1, v));
    if (i % 3 === 0) push(arr, at(u0, -W), at(u0, W));
  }
  return segments(arr);
}

// Hexagonal quartz crystals: a big central column with two smaller ones leaning out like horns.
function crystal() {
  const arr = [];
  const column = (r, h, tip, tilt, x, y) => {
    const m = new THREE.Matrix4().makeRotationZ(tilt).setPosition(x, y, 0);
    const v = (a, b, c) => new THREE.Vector3(a, b, c).applyMatrix4(m).toArray();
    const ring = (yy) => Array.from({ length: 6 }, (_, k) => v(r * Math.cos((k * TAU) / 6), yy, r * Math.sin((k * TAU) / 6)));
    const top = ring(h);
    const bottom = ring(-h);
    const apexT = v(0, h + tip, 0);
    const apexB = v(0, -h - tip * 0.6, 0);
    for (let k = 0; k < 6; k++) {
      const n = (k + 1) % 6;
      push(arr, top[k], top[n]);
      push(arr, bottom[k], bottom[n]);
      push(arr, top[k], bottom[k]);
      push(arr, top[k], apexT);
      push(arr, bottom[k], apexB);
    }
  };
  column(0.3, 0.55, 0.42, 0, 0, -0.1);
  column(0.17, 0.32, 0.26, 0.62, -0.42, 0.05);
  column(0.17, 0.32, 0.26, -0.62, 0.42, 0.05);
  return segments(arr);
}

// Brilliant-cut diamond: octagonal table, crown facets down to a 16-sided girdle, pavilion to the culet.
function diamond() {
  const ring = (n, r, y, rot = 0) => Array.from({ length: n }, (_, k) => [r * Math.cos((k * TAU) / n + rot), y, r * Math.sin((k * TAU) / n + rot)]);
  const table = ring(8, 0.55, 0.5, Math.PI / 8);
  const girdle = ring(16, 1.05, 0.12);
  const girdleLow = ring(16, 1.05, 0.02);
  const culet = [0, -1.0, 0];
  const arr = [];
  for (let k = 0; k < 8; k++) push(arr, table[k], table[(k + 1) % 8]);
  for (let k = 0; k < 16; k++) {
    push(arr, girdle[k], girdle[(k + 1) % 16]);
    push(arr, girdleLow[k], girdleLow[(k + 1) % 16]);
  }
  for (let k = 0; k < 8; k++) {
    // Each table corner fans out to three girdle points: kite and star facets of the crown.
    push(arr, table[k], girdle[(2 * k) % 16]);
    push(arr, table[k], girdle[(2 * k + 1) % 16]);
    push(arr, table[k], girdle[(2 * k + 2) % 16]);
    push(arr, girdleLow[2 * k], culet);
    push(arr, girdleLow[2 * k], girdle[2 * k]);
  }
  return segments(arr);
}

// Tesseract: the 16 vertices of the 4D hypercube and its 32 edges (vertex pairs differing in one coordinate).
const TESS_V = Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].map((b) => ((i >> b) & 1 ? 1 : -1)));
const TESS_E = [];
for (let i = 0; i < 16; i++) for (let b = 0; b < 4; b++) if (!(i & (1 << b))) TESS_E.push([i, i | (1 << b)]);
const TESS_D = 3.2; // 4D eye distance for the perspective projection to 3D
const TESS_S = 0.48; // final scale: the outer cube reaches ~1.2

/** Rotates the hypercube in the XW and ZW planes by angles a, b, projects it to 3D and writes the segments to arr. */
export function tesseractSegments(a, b, arr = new Float32Array(TESS_E.length * 6)) {
  const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
  const p = TESS_V.map(([x, y, z, w]) => {
    const x1 = x * ca - w * sa;
    const w1 = x * sa + w * ca;
    const z1 = z * cb - w1 * sb;
    const w2 = z * sb + w1 * cb;
    const k = (TESS_S * TESS_D) / (TESS_D - w2);
    return [x1 * k, y * k, z1 * k];
  });
  TESS_E.forEach(([i, j], s) => {
    arr.set(p[i], s * 6);
    arr.set(p[j], s * 6 + 3);
  });
  return arr;
}

const GEOMETRIES = {
  sphere: () => edges(new THREE.SphereGeometry(1, 14, 10), 8),
  tetra: () => edges(new THREE.TetrahedronGeometry(1.15)),
  torus: () => edges(new THREE.TorusGeometry(0.75, 0.28, 10, 24), 12),
  octa: () => edges(new THREE.OctahedronGeometry(1.1)),
  knot: () => gridLines(new THREE.TorusKnotGeometry(0.62, 0.2, 90, 3, 2, 3), 90, 3, 6),
  icosa: () => edges(new THREE.IcosahedronGeometry(1)),
  helix,
  dodeca: () => edges(new THREE.DodecahedronGeometry(1)),
  merkaba,
  geo: () => edges(new THREE.IcosahedronGeometry(1.05, 2), 1),
  tesseract: () => segments(tesseractSegments(0, 0)),
  star,
  mobius,
  crystal,
  diamond,
  [MIDDLE]: middleFinger,
};

/** Number of line segments of each solid (for tests: the geometry stays light). */
export function segmentCounts() {
  return Object.fromEntries(Object.entries(GEOMETRIES).map(([k, make]) => [k, make().attributes.instanceStart.count]));
}

/** Wireframe solids that share one pose; only the active one is visible, the others fade out. */
export function createSolids(scene) {
  const items = {};
  for (const [key, make] of Object.entries(GEOMETRIES)) {
    const mesh = new LineSegments2(make(), lineMaterial());
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    items[key] = { mesh, vis: 0, color: key in SOLID_COLORS ? new THREE.Color(SOLID_COLORS[key]) : null };
  }
  const tess = items.tesseract.mesh.geometry.attributes.instanceStart.data;
  let tessA = 0;
  let tessB = 0;

  /**
   * `key` null hides everything. `pose` is { x, y, r, q } as for the prism figure. `tint` colours only the solids
   * without their own colour (SOLID_COLORS). Per-frame animation (the tesseract's 4D rotation) runs here, on dt.
   */
  function place(key, pose, visibility, tint, dt) {
    tessA += 0.7 * dt;
    tessB += 0.43 * dt;
    for (const [k, it] of Object.entries(items)) {
      it.vis += ((k === key ? 1 : 0) - it.vis) * (1 - Math.exp(-10 * dt));
      const a = it.vis * visibility;
      it.mesh.visible = a > 0.01;
      if (!it.mesh.visible) continue;
      if (k === 'tesseract') {
        tesseractSegments(tessA, tessB, tess.array);
        tess.needsUpdate = true;
      }
      it.mesh.position.set(pose.x, pose.y, 0);
      it.mesh.quaternion.copy(pose.q);
      it.mesh.scale.setScalar(pose.r);
      it.mesh.material.color.copy(it.color ?? tint).multiplyScalar(a);
      it.mesh.material.opacity = a;
    }
  }

  function resize(w, h) {
    for (const it of Object.values(items)) it.mesh.material.resolution.set(w, h);
  }

  return { place, resize };
}
