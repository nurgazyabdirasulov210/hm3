// The synthetic hands must read back through the tracker as what they were generated to be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hand, detect, makeRng, VIEW, toPx } from './synth.js';
import { createTracker, fingerMask, openness, orientation } from '../src/tracker.js';
import { createSim } from '../src/sim.js';

test('synth: raised-finger masks read back for both hands, palm or back to the camera', () => {
  const rng = makeRng(5);
  for (const mask of [0, 1, 2, 3, 4, 6, 7, 14, 15, 30, 31]) {
    for (const side of [1, -1]) {
      for (const turn of [0, Math.PI]) {
        for (let k = 0; k < 5; k++) {
          assert.equal(fingerMask(hand({ x: 600, y: 600, size: 200, mask, side, turn }, rng).world), mask);
        }
      }
    }
  }
});

test('synth: openness spans fist .. spread', () => {
  const rng = makeRng(6);
  assert.equal(openness(hand({ x: 600, y: 600, size: 200, open: 0 }, rng).world), 0);
  assert.equal(openness(hand({ x: 600, y: 600, size: 200, open: 1 }, rng).world), 1);
});

test('synth: turning the hand over changes the flip angle by the same amount, the up axis stays', () => {
  const rng = makeRng(7);
  const noise = { worldNoise: 0 };
  const a = orientation(hand({ x: 600, y: 600, size: 200 }, rng, noise).world);
  const b = orientation(hand({ x: 600, y: 600, size: 200, turn: 1 }, rng, noise).world);
  const d = Math.atan2(Math.sin(a.flip - b.flip), Math.cos(a.flip - b.flip));
  assert.ok(Math.abs(Math.abs(d) - 1) < 1e-6, `flip changed by ${d}`);
  assert.ok(Math.abs(a.up.y - 1) < 1e-6 && Math.abs(b.up.y - 1) < 1e-6, 'fingers up');
});

test('synth: tracker reads palm centre and size in screen px; first hand is the lead', () => {
  const rng = makeRng(8);
  const tracker = createTracker(VIEW, toPx);
  const left = { x: 400, y: 620, size: 180, side: -1, mask: 6 };
  const right = { x: 1000, y: 600, size: 210, side: 1, mask: 31 };
  for (let k = 0; k < 30; k++) tracker.process(detect([left, k > 5 ? right : null], rng), k * (1000 / 30));
  const { lead, tool } = tracker.read(1000);
  for (const [h, p] of [[lead, left], [tool, right]]) {
    assert.ok(Math.abs(h.x - p.x) < 3 && Math.abs(h.y - p.y) < 3, `centre ${h.x.toFixed(1)},${h.y.toFixed(1)}`);
    assert.ok(Math.abs(h.size - p.size) < 3, `size ${h.size.toFixed(1)}`);
    assert.equal(h.mask, p.mask);
    assert.ok(Math.abs(h.pvx) < 60 && Math.abs(h.pvy) < 60, 'resting hand reads as still');
  }
});

test('sim: runs without a renderer and calls the injected figure', () => {
  const calls = { setSides: [], update: 0 };
  const figure = { setSides: (n) => calls.setSides.push(n), update: () => calls.update++ };
  const sim = createSim({ view: VIEW, figure });
  const lead = {
    x: 700, y: 650, size: 200, fingers: 3, mask: 0b01110, pts: [], open: 1, openRate: 0, vx: 0, vy: 0, pvx: 0, pvy: 0,
    twist: 0, twistW: 1, flip: 0, flipW: 1, up: { x: 0, y: 1, z: 0 }, fresh: true,
  };
  for (let i = 0; i < 240; i++) sim.step({ lead, tool: null }, 1 / 120, i / 120);
  assert.equal(calls.update, 240);
  assert.deepEqual(calls.setSides, [3]);
  assert.equal(sim.state.shapeKey, 's3');
  assert.equal(sim.state.mode, 'single');
  assert.ok(sim.state.visibility > 0.99);
  const y = sim.state.pos.y;
  assert.ok(Math.abs(y - (650 - 200 * 2.3)) < 40, `hovers above the hand (y ${y.toFixed(0)})`);
});
