import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { lineMaterial } from './figure.js';

// Polyhedra for the "joined hands" mode, indexed by the number of raised fingers.
export const SOLID_KEYS = ['sphere', 'tetra', 'octa', 'icosa', 'dodeca', 'torus'];
export const MIDDLE = 'middle';

const edges = (g, angle = 1) => new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(g, angle));

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
  return new LineSegmentsGeometry().setPositions(arr);
}

const GEOMETRIES = {
  sphere: () => edges(new THREE.SphereGeometry(1, 14, 10), 8),
  tetra: () => edges(new THREE.TetrahedronGeometry(1.15)),
  octa: () => edges(new THREE.OctahedronGeometry(1.1)),
  icosa: () => edges(new THREE.IcosahedronGeometry(1)),
  dodeca: () => edges(new THREE.DodecahedronGeometry(1)),
  torus: () => edges(new THREE.TorusGeometry(0.75, 0.28, 10, 24), 12),
  [MIDDLE]: middleFinger,
};

/** Wireframe solids that share one pose; only the active one is visible, the others fade out. */
export function createSolids(scene) {
  const items = {};
  for (const [key, make] of Object.entries(GEOMETRIES)) {
    const mesh = new LineSegments2(make(), lineMaterial());
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    items[key] = { mesh, vis: 0 };
  }

  const color = new THREE.Color();

  /** `key` null hides everything. `pose` is { x, y, r, q } as for the prism figure. */
  function place(key, pose, visibility, tint, dt) {
    color.copy(tint);
    for (const [k, it] of Object.entries(items)) {
      it.vis += ((k === key ? 1 : 0) - it.vis) * (1 - Math.exp(-10 * dt));
      const a = it.vis * visibility;
      it.mesh.visible = a > 0.01;
      if (!it.mesh.visible) continue;
      it.mesh.position.set(pose.x, pose.y, 0);
      it.mesh.quaternion.copy(pose.q);
      it.mesh.scale.setScalar(pose.r);
      it.mesh.material.color.copy(color).multiplyScalar(a);
      it.mesh.material.opacity = a;
    }
  }

  function resize(w, h) {
    for (const it of Object.values(items)) it.mesh.material.resolution.set(w, h);
  }

  return { place, resize };
}
