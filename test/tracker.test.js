// Tracker unit tests: the wrist speed the throw detector sees, and hand identity through detection dropouts.
// Synthetic hands go straight into the tracker at 30 fps, no simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW, toPx, makeRng, detect, flick } from './synth.js';
import { createTracker, LEAD_GRACE_MS } from '../src/tracker.js';

const FRAME = 1000 / 30; // ms
const SIZE = 200;

/**
 * Feeds `frames` camera frames to a fresh tracker. poses(t, k) -> [pose | null, ...] for the frame at t seconds
 * (k is the frame index); each(tracker, k, t) runs after every frame. Returns the tracker.
 */
function feed(frames, poses, each = () => {}, seed = 1) {
  const rng = makeRng(seed);
  const tracker = createTracker(VIEW, toPx);
  for (let k = 0; k < frames; k++) {
    const t = (k * FRAME) / 1000;
    tracker.process(detect(poses(t, k), rng), k * FRAME);
    each(tracker, k, t);
  }
  return tracker;
}

// --- wrist speed ----------------------------------------------------------------------------------------------------

/** Fastest |pvx| the lead reports for a 150 ms / 200 ms flick to `peak` px/s, starting at t0 (s). */
function seenPeak(peak, t0, seed) {
  let best = 0;
  feed(
    60,
    (t) => [{ x: 400 + flick(t - t0, { peak }).d, y: 600, size: SIZE }],
    (tr, k) => (best = Math.max(best, Math.abs(tr.read(k * FRAME).lead.pvx))),
    seed,
  );
  return best;
}

test('tracker: flick speed reads within 10% of the true wrist peak', (t) => {
  for (const peak of [1200, 1600, 2000, 2600]) {
    // The peak falls anywhere between two camera frames: ten phases over one frame interval.
    const ratios = [];
    for (let i = 0; i < 10; i++) ratios.push(seenPeak(peak, 1 + (i * FRAME) / 10000, i + 1) / peak);
    const mean = ratios.reduce((a, b) => a + b) / ratios.length;
    const lo = Math.min(...ratios);
    const hi = Math.max(...ratios);
    t.diagnostic(`peak ${peak} px/s: seen/true mean ${mean.toFixed(3)}, range ${lo.toFixed(3)}..${hi.toFixed(3)}`);
    assert.ok(mean > 0.9 && mean < 1.1, `mean ratio ${mean.toFixed(3)} for ${peak} px/s`);
    assert.ok(lo > 0.85 && hi < 1.15, `every phase within 15% (${lo.toFixed(3)}..${hi.toFixed(3)})`);
  }
});

test('tracker: a resting hand reads as still, a single glitch frame does not fake a throw', (t) => {
  for (const jump of [0.15, 0.3, 0.6, 1.5]) {
    // The whole hand jumps sideways by `jump` palm sizes for one frame (a landmark glitch), then is back.
    let worst = 0;
    feed(45, (tt, k) => [{ x: 600 + (k === 30 ? jump * SIZE : 0), y: 600, size: SIZE }], (tr, k) => {
      if (k > 5) worst = Math.max(worst, Math.hypot(tr.read(k * FRAME).lead.pvx, tr.read(k * FRAME).lead.pvy));
    });
    t.diagnostic(`glitch of ${jump} palm sizes: fastest wrist reading ${Math.round(worst)} px/s`);
    // The throw threshold is max(THROW.minSpeed, THROW.speed palm sizes / s); stay far below the floor.
    assert.ok(worst < 600, `glitch of ${jump} palm sizes reads ${Math.round(worst)} px/s`);
  }
});

test('tracker: twisting the hand or turning it over does not move the wrist', (t) => {
  for (const kind of ['roll', 'turn']) {
    let worst = 0;
    const angle = (tt) => Math.PI * Math.min(1, Math.max(0, (tt - 0.5) / 0.3));
    feed(40, (tt) => [{ x: 600, y: 600, size: SIZE, [kind]: angle(tt) }], (tr, k) => {
      worst = Math.max(worst, Math.abs(tr.read(k * FRAME).lead.pvx));
    });
    t.diagnostic(`${kind} 180 degrees in 0.3 s: fastest sideways wrist reading ${Math.round(worst)} px/s`);
    assert.ok(worst < 450, `${kind} reads ${Math.round(worst)} px/s`);
  }
});

// --- hand identity --------------------------------------------------------------------------------------------------

const near = (tr, x) => tr && Math.abs(tr.rawX - x) < 60;

test('tracker: a fast hand lost by the camera does not take the other hand\'s detection', () => {
  // Hand 0 at 460 flicks right toward hand 1 at 900 and is not detected for 3 frames at its fastest.
  const x0 = (t) => 460 + flick(t - 1, { peak: 2000 }).d;
  const lost = (k) => k >= 34 && k < 37;
  let ids = null;
  feed(70, (t, k) => [lost(k) ? null : { x: x0(t), y: 600, size: SIZE, side: -1 }, t > 0.3 ? { x: 900, y: 600, size: SIZE } : null], (tr, k, t) => {
    const { lead, tool } = tr.tracks();
    if (k === 20) ids = { lead, tool };
    if (k <= 20) return;
    assert.equal(lead, ids.lead, `lead is the same track at frame ${k}`);
    assert.equal(tool, ids.tool, `tool is the same track at frame ${k}`);
    assert.ok(near(tool, 900), `tool stays on hand 1 at frame ${k} (x ${Math.round(tool.rawX)})`);
    if (!lost(k)) assert.ok(near(lead, x0(t)), `lead is on hand 0 at frame ${k}`);
  });
});

test('tracker: a far detection next to a still hand is a second hand; after a flick it is the same hand', () => {
  // Still hand, then another hand shows up 700 px away: it becomes the tool.
  let tr = feed(30, (t, k) => [k < 20 ? null : { x: 1100, y: 600, size: SIZE }, { x: 400, y: 600, size: SIZE }]);
  assert.ok(near(tr.tracks().lead, 400) && near(tr.tracks().tool, 1100), 'second hand appears as the tool');
  // A lone hand flicked hard and lost for 4 frames reappears far ahead: re-acquired, no second hand.
  const x = (t) => 300 + flick(t - 1, { peak: 2600 }).d * 1.6;
  tr = feed(60, (t, k) => [k >= 33 && k < 37 ? null : { x: x(t), y: 600, size: SIZE }], (tk, k, t) => {
    const { lead, tool } = tk.tracks();
    assert.equal(tool, null, `no second hand at frame ${k}`);
    if (k < 33 || k >= 37) assert.ok(near(lead, x(t)), `lead on the hand at frame ${k}`);
  });
});

test('tracker: joined hands keep their identities while either one drops out', () => {
  // Palms 1.2 palm sizes apart; each hand misses a few frames in turn, sometimes both at once.
  const xs = [600, 840];
  const missing = (k, i) => (i === 0 ? k % 9 < 2 : k % 7 === 3) && k > 20;
  let ids = null;
  feed(120, (t, k) => xs.map((x, i) => (missing(k, i) ? null : { x, y: 600, size: SIZE, side: i ? 1 : -1 })), (tr, k) => {
    const { lead, tool } = tr.tracks();
    if (k === 20) ids = { lead, tool };
    if (k <= 20) return;
    assert.ok(lead === ids.lead && tool === ids.tool, `same tracks at frame ${k}`);
    assert.ok(near(lead, xs[0]) && near(tool, xs[1]), `lead on hand 0, tool on hand 1 at frame ${k}`);
  });
});

test('tracker: the tool takes over the figure only after the lead is gone for the grace period', () => {
  const lostFrom = 30;
  feed(60, (t, k) => [k >= lostFrom ? null : { x: 400, y: 600, size: SIZE }, { x: 1000, y: 600, size: SIZE }], (tr, k) => {
    const { lead, tool } = tr.read(k * FRAME);
    if ((k - lostFrom) * FRAME <= LEAD_GRACE_MS) {
      assert.ok(Math.abs(lead.x - 400) < 30 && Math.abs(tool.x - 1000) < 30, `roles kept at frame ${k}`);
    } else {
      assert.ok(Math.abs(lead.x - 1000) < 30 && tool === null, `remaining hand leads at frame ${k}`);
    }
  });
});
