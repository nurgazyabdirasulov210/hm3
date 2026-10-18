// Embers: a pooled particle system drawn as short glowing streaks (head white-hot, tail fading to ember red).
// Fixed-size pool (oldest particle is reused when full), no allocations per frame.
import { createLayer, heatColor, hash } from './spells.js';

const MAX = 600;
const GRAVITY = 520; // px/s^2, screen y down
const DRAG = 1.4; // 1/s
const STREAK = 0.045; // s of motion shown as the streak
const rgb = [0, 0, 0];

export function createSparks(scene) {
  const layer = createLayer(scene, MAX, { core: 1.5, halo: 4.5, haloGain: 0.3, additive: true, order: 20 });
  const x = new Float32Array(MAX);
  const y = new Float32Array(MAX);
  const vx = new Float32Array(MAX);
  const vy = new Float32Array(MAX);
  const life = new Float32Array(MAX);
  const span = new Float32Array(MAX);
  const heat = new Float32Array(MAX);
  const seed = new Float32Array(MAX);
  let next = 0;
  let alive = 0;

  /** One spark at (px, py) screen px with velocity (pvx, pvy) px/s, lifetime s, heat 0..1. */
  function emit(px, py, pvx, pvy, t, h = 1) {
    const i = next;
    next = (next + 1) % MAX;
    x[i] = px;
    y[i] = py;
    vx[i] = pvx;
    vy[i] = pvy;
    life[i] = t;
    span[i] = t;
    heat[i] = h;
    seed[i] = Math.random() * 100;
  }

  function update(dt, t) {
    layer.begin();
    const drag = Math.exp(-DRAG * dt);
    alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) continue;
      alive++;
      vx[i] *= drag;
      vy[i] = vy[i] * drag + GRAVITY * dt;
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      const f = life[i] / span[i]; // 1 -> 0
      // Cools from white-hot to ember red as it dies, and flickers.
      heatColor(heat[i] * (0.35 + 0.65 * f), rgb);
      const fl = (0.55 + 0.45 * hash(seed[i] + Math.floor(t * 30) * 1.7)) * Math.min(1, f * 2.5);
      const tx = x[i] - vx[i] * STREAK;
      const ty = y[i] - vy[i] * STREAK;
      layer.seg(x[i], y[i], tx, ty, rgb[0] * fl, rgb[1] * fl, rgb[2] * fl, rgb[0] * fl * 0.08, rgb[1] * fl * 0.03, 0);
    }
    layer.end(1);
  }

  return {
    emit,
    update,
    resize: layer.resize,
    get alive() {
      return alive;
    },
  };
}

// Number of particles for a rate (per s) over dt, with the fraction carried by chance.
const howMany = (rate, dt) => {
  const n = rate * dt;
  return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
};

/**
 * Embers thrown tangentially off a spinning rim of radius R (unit space of frame f), like the sling-ring portal.
 * dir: +1 / -1 spin direction; speed: in spell radii per second.
 */
export function rimSparks(sparks, f, R, rate, dt, dir, speed) {
  const n = howMany(rate, dt);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const rr = R * (0.98 + 0.05 * Math.random());
    const px = f.cx + f.r * rr * (c * f.ax + s * f.bx);
    const py = f.cy + f.r * rr * (c * f.ay + s * f.by);
    const sp = f.r * speed * (0.55 + 0.7 * Math.random());
    const out = 0.1 + 0.35 * Math.random();
    // Tangent (-s, c) and radial (c, s) in unit space, mapped to the screen axes.
    const tu = -s * dir + c * out;
    const tv = c * dir + s * out;
    sparks.emit(px, py, sp * (tu * f.ax + tv * f.bx), sp * (tu * f.ay + tv * f.by), 0.3 + 0.65 * Math.random(), 0.75 + 0.25 * Math.random());
  }
}

/** A few sparks off the tip of a ring that is drawing itself (frame f's pen). */
export function penSparks(sparks, f, rate, dt) {
  if (!f.pen.on) return;
  const n = howMany(rate, dt);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = f.r * (0.4 + Math.random() * 0.9);
    sparks.emit(f.pen.x, f.pen.y, Math.cos(a) * sp, Math.sin(a) * sp - f.r * 0.3, 0.2 + 0.4 * Math.random(), 1);
  }
}

/** Embers off random segments of a layer (range n0..n1), flying outward from (cx, cy): a spell crumbling away. */
export function crumbleSparks(sparks, layer, n0, n1, cx, cy, scale, rate, dt) {
  if (n1 <= n0) return;
  const n = howMany(rate, dt);
  const p = layer.pos;
  for (let i = 0; i < n; i++) {
    const k = (n0 + Math.floor(Math.random() * (n1 - n0))) * 6;
    const q = Math.random();
    const x = p[k] + (p[k + 3] - p[k]) * q;
    const y = -(p[k + 1] + (p[k + 4] - p[k + 1]) * q);
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy) || 1;
    const sp = scale * (0.3 + 0.8 * Math.random());
    sparks.emit(x, y, (dx / d) * sp + (Math.random() - 0.5) * sp, (dy / d) * sp - scale * 0.2, 0.3 + 0.5 * Math.random(), 0.8);
  }
}
