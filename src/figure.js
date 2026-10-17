import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const RING = 120; // perimeter samples; divisible by 1..5 so corners stay sharp
const PILLARS = 5;
const HALF_H = 0.7;
const GHOSTS = 10;
const GHOST_STEP = 0.4; // frames of history between neighbouring ghosts (sub-frame, so the trail is dense)
const MORPH_K = 240; // per-vertex spring: underdamped, so the outline wobbles into the new shape
const MORPH_C = 15;

const COLORS = [0xc8d8ff, 0x7df9ff, 0x7dffb2, 0xffe66d, 0xffa05a, 0xff6bd6].map((c) => new THREE.Color(c));

// Point on the perimeter of a regular n-gon (radius 1) at fraction t.
// n = 0 is a circle, n = 1 collapses to a point (the prism becomes a single line).
function perimeter(n, t, out) {
  if (n === 0) {
    out[0] = Math.cos(t * Math.PI * 2);
    out[1] = Math.sin(t * Math.PI * 2);
  } else if (n === 1) {
    out[0] = out[1] = 0;
  } else {
    const u = t * n;
    const k = Math.floor(u);
    const f = u - k;
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    out[0] = Math.cos(a0) + (Math.cos(a1) - Math.cos(a0)) * f;
    out[1] = Math.sin(a0) + (Math.sin(a1) - Math.sin(a0)) * f;
  }
  return out;
}

export function lineMaterial() {
  // MAX blending: overlapping segment caps and ghosts never add up into bright beads.
  return new LineMaterial({
    linewidth: 2.4,
    transparent: true,
    depthTest: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });
}

/** Wireframe prism whose base morphs between n-gons, plus trailing ghost copies for motion blur. */
export function createFigure(scene) {
  const NV = RING + PILLARS;
  const cur = new Float32Array(NV * 2);
  const vel = new Float32Array(NV * 2);
  const tgt = new Float32Array(NV * 2);
  const tmp = [0, 0];

  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(new Float32Array((RING * 2 + PILLARS) * 6));
  const buffer = geometry.attributes.instanceStart.data;

  const layers = [];
  for (let i = 0; i <= GHOSTS; i++) {
    const mesh = new LineSegments2(geometry, lineMaterial());
    mesh.frustumCulled = false;
    mesh.renderOrder = GHOSTS - i;
    scene.add(mesh);
    layers.push(mesh);
  }

  const color = COLORS[0].clone();
  let sides = 0;

  function setSides(n) {
    sides = n;
    for (let i = 0; i < RING; i++) {
      perimeter(n, i / RING, tmp);
      tgt[i * 2] = tmp[0];
      tgt[i * 2 + 1] = tmp[1];
    }
    for (let j = 0; j < PILLARS; j++) {
      perimeter(n, n === 0 ? j / PILLARS : (j % n) / n, tmp);
      tgt[(RING + j) * 2] = tmp[0];
      tgt[(RING + j) * 2 + 1] = tmp[1];
    }
  }
  setSides(0);
  cur.set(tgt);

  function seg(arr, s, ax, ay, az, bx, by, bz) {
    const o = s * 6;
    arr[o] = ax;
    arr[o + 1] = ay;
    arr[o + 2] = az;
    arr[o + 3] = bx;
    arr[o + 4] = by;
    arr[o + 5] = bz;
  }

  function update(dt) {
    for (let i = 0; i < NV * 2; i++) {
      vel[i] += (MORPH_K * (tgt[i] - cur[i]) - MORPH_C * vel[i]) * dt;
      cur[i] += vel[i] * dt;
    }
    const arr = buffer.array;
    for (let i = 0; i < RING; i++) {
      const j = (i + 1) % RING;
      seg(arr, i, cur[i * 2], HALF_H, cur[i * 2 + 1], cur[j * 2], HALF_H, cur[j * 2 + 1]);
      seg(arr, RING + i, cur[i * 2], -HALF_H, cur[i * 2 + 1], cur[j * 2], -HALF_H, cur[j * 2 + 1]);
    }
    for (let p = 0; p < PILLARS; p++) {
      const x = cur[(RING + p) * 2];
      const z = cur[(RING + p) * 2 + 1];
      seg(arr, RING * 2 + p, x, -HALF_H, z, x, HALF_H, z);
    }
    buffer.needsUpdate = true;
    color.lerp(COLORS[sides], 1 - Math.exp(-8 * dt));
  }

  /**
   * poses[0] is the current pose, poses[1..] are previous frames.
   * `motion` (0..1) controls how visible the trailing ghosts are.
   */
  function place(poses, visibility, motion) {
    layers.forEach((mesh, i) => {
      const f = Math.min(i * GHOST_STEP, poses.length - 1);
      const a0 = poses[Math.floor(f)];
      const a1 = poses[Math.ceil(f)];
      const k = f - Math.floor(f);
      mesh.position.set(a0.x + (a1.x - a0.x) * k, a0.y + (a1.y - a0.y) * k, 0);
      mesh.quaternion.slerpQuaternions(a0.q, a1.q, k);
      mesh.scale.setScalar(a0.r + (a1.r - a0.r) * k);
      const a = i === 0 ? visibility : visibility * motion * 0.55 * (1 - i / (GHOSTS + 1));
      mesh.visible = a > 0.01;
      // Premultiplied output: the canvas is transparent over the video.
      mesh.material.color.copy(color).multiplyScalar(a);
      mesh.material.opacity = a;
    });
  }

  function resize(w, h) {
    for (const mesh of layers) mesh.material.resolution.set(w, h);
  }

  return { setSides, update, place, resize, color, ghosts: GHOSTS };
}
