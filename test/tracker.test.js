// Tracker unit tests: the wrist speed the throw detector sees, and hand identity through detection dropouts.
// Synthetic hands go straight into the tracker at 30 fps (wrist speed also at 15 and 60 fps), no simulation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEW, CAM, toPx, makeRng, detect, flick } from './synth.js';
import { createTracker, toScreen, LEAD_GRACE_MS } from '../src/tracker.js';

const FRAME = 1000 / 30; // ms
const SIZE = 200;

/**
 * Feeds `frames` camera frames to a fresh tracker. poses(t, k) -> [pose | null, ...] for the frame at t seconds
 * (k is the frame index); each(tracker, k, t) runs after every frame. Returns the tracker.
 * `fps` is the camera rate (frames are then 1000 / fps ms apart; `frames` still counts 30 fps frames, so a scene
 * lasts as long at any rate); `map` maps landmarks to the screen (see toScreen).
 */
function feed(frames, poses, each = () => {}, seed = 1, { fps = 30, map = toPx } = {}) {
  const rng = makeRng(seed);
  const tracker = createTracker(VIEW, map);
  const step = 1000 / fps;
  for (let k = 0; k < (frames * fps) / 30; k++) {
    const t = (k * step) / 1000;
    tracker.process(detect(poses(t, k), rng), k * step);
    each(tracker, k, t, k * step);
  }
  return tracker;
}

// --- wrist speed ----------------------------------------------------------------------------------------------------

const RATES = [15, 30, 60]; // camera frame rates the wrist speed must work at

/** Fastest |pvx| the lead reports for a 150 ms / 200 ms flick to `peak` px/s, starting at t0 (s). */
function seenPeak(peak, t0, seed, fps = 30) {
  let best = 0;
  feed(
    60,
    (t) => [{ x: 400 + flick(t - t0, { peak }).d, y: 600, size: SIZE }],
    (tr, k, t, ms) => (best = Math.max(best, Math.abs(tr.read(ms).lead.pvx))),
    seed,
    { fps },
  );
  return best;
}

// At 30 fps the fit spans 100 ms; at 60 fps too (7 samples); at 15 fps it needs 4 samples = 200 ms, which
// averages a short flick down a little more.
const PEAK_RANGE = { 15: [0.8, 1.1, 0.75, 1.15], 30: [0.9, 1.1, 0.85, 1.15], 60: [0.9, 1.1, 0.85, 1.15] };

for (const fps of RATES) {
  test(`tracker: flick speed reads close to the true wrist peak (camera ${fps} fps)`, (t) => {
    const [meanLo, meanHi, lo0, hi0] = PEAK_RANGE[fps];
    for (const peak of [1200, 1600, 2000, 2600]) {
      // The peak falls anywhere between two camera frames: ten phases over one frame interval.
      const ratios = [];
      for (let i = 0; i < 10; i++) ratios.push(seenPeak(peak, 1 + i / fps / 10, i + 1, fps) / peak);
      const mean = ratios.reduce((a, b) => a + b) / ratios.length;
      const lo = Math.min(...ratios);
      const hi = Math.max(...ratios);
      t.diagnostic(`peak ${peak} px/s: seen/true mean ${mean.toFixed(3)}, range ${lo.toFixed(3)}..${hi.toFixed(3)}`);
      assert.ok(mean > meanLo && mean < meanHi, `mean ratio ${mean.toFixed(3)} for ${peak} px/s`);
      assert.ok(lo > lo0 && hi < hi0, `every phase in range (${lo.toFixed(3)}..${hi.toFixed(3)})`);
    }
  });

  test(`tracker: a resting hand reads as still, a single glitch frame does not fake a throw (camera ${fps} fps)`, (t) => {
    for (const jump of [0.15, 0.25, 0.3, 0.35, 0.6, 1, 1.5]) {
      // The whole hand jumps sideways by `jump` palm sizes for one frame (a landmark glitch), then is back.
      for (let seed = 1; seed <= 3; seed++) {
        let worst = 0;
        const at = Math.round(fps * (1 + seed * 0.1));
        feed(45, (tt, k) => [{ x: 600 + (k === at ? jump * SIZE : 0), y: 600, size: SIZE }], (tr, k, tt, ms) => {
          if (tt > 0.2) worst = Math.max(worst, Math.hypot(tr.read(ms).lead.pvx, tr.read(ms).lead.pvy));
        }, seed, { fps });
        if (seed === 1) t.diagnostic(`glitch of ${jump} palm sizes: fastest wrist reading ${Math.round(worst)} px/s`);
        // The throw threshold is max(THROW.minSpeed, THROW.speed palm sizes / s); stay far below the floor.
        assert.ok(worst < 600, `glitch of ${jump} palm sizes reads ${Math.round(worst)} px/s (seed ${seed})`);
      }
    }
  });

  test(`tracker: twisting the hand or turning it over does not move the wrist (camera ${fps} fps)`, (t) => {
    for (const kind of ['roll', 'turn']) {
      let worst = 0;
      const angle = (tt) => Math.PI * Math.min(1, Math.max(0, (tt - 0.5) / 0.3));
      feed(40, (tt) => [{ x: 600, y: 600, size: SIZE, [kind]: angle(tt) }], (tr, k, tt, ms) => {
        worst = Math.max(worst, Math.abs(tr.read(ms).lead.pvx));
      }, 1, { fps });
      t.diagnostic(`${kind} 180 degrees in 0.3 s: fastest sideways wrist reading ${Math.round(worst)} px/s`);
      assert.ok(worst < 450, `${kind} reads ${Math.round(worst)} px/s`);
    }
  });
}

test('tracker: a hand lost for a moment and found elsewhere does not read as a flick', (t) => {
  // A still or slowly moving hand is lost for 100..250 ms and detected again up to 1.5 palm sizes away
  // (another spot on the hand, or the hand moved): the speed across the gap only counts for a hand already
  // moving fast that way (a flick blurred out by the camera).
  for (const [drift, jump] of [[0, 1], [0, 1.5], [250, 1], [250, -1], [0, 0.5]]) {
    for (const lost of [100, 170, 250]) {
      let worst = 0;
      feed(60, (tt) => {
        const back = tt >= 1 + lost / 1000;
        if (tt >= 1 && !back) return [null];
        return [{ x: 500 + drift * tt + (back ? jump * SIZE : 0), y: 600, size: SIZE }];
      }, (tr, k, tt, ms) => {
        if (tt > 0.3) worst = Math.max(worst, Math.abs(tr.read(ms).lead.pvx));
      });
      assert.ok(worst < 900, `drift ${drift} px/s, lost ${lost} ms, back ${jump} palm sizes off: ${Math.round(worst)} px/s`);
    }
  }
});

test('tracker: a flick blurred out for 4+ frames still reads fast when the hand is found again', (t) => {
  // 1500 px/s flick, not detected for 4..6 frames around its peak (the gap is 167..233 ms).
  for (const n of [4, 5, 6]) {
    let best = 0;
    const x = (tt) => 400 + flick(tt - 1, { peak: 1500 }).d;
    const from = Math.round(34.5 - n / 2); // the wrist is fastest at frame 34.5 (1.15 s)
    feed(60, (tt, k) => [k >= from && k < from + n ? null : { x: x(tt), y: 600, size: SIZE }], (tr, k, tt, ms) => {
      best = Math.max(best, tr.read(ms).lead.pvx);
    });
    t.diagnostic(`${n} frames lost: fastest reading ${Math.round(best)} px/s`);
    // Above the throw threshold for a 200 px palm (THROW.speed palm sizes per second = 1000 px/s).
    assert.ok(best > 1000, `${n} frames lost: reads ${Math.round(best)} px/s`);
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

test('tracker: both hands lost past the grace period come back with the lead on the hand nearest to where it was', () => {
  // Left hand (x 400) leads, right hand (x 1000) is the tool. Both are lost for 600 ms (occluded, camera hiccup),
  // then both are detected again in the same frame, in random order: the lead goes back to the left hand.
  for (let seed = 1; seed <= 20; seed++) {
    const tr = feed(60, (t) => {
      if (t >= 1 && t < 1.6) return [null, null];
      return [{ x: 400, y: 640, size: SIZE, side: -1 }, t > 0.3 ? { x: 1000, y: 640, size: SIZE } : null];
    }, () => {}, seed);
    assert.ok(near(tr.tracks().lead, 400), `seed ${seed}: lead back on the left hand (x ${Math.round(tr.tracks().lead.rawX)})`);
    assert.ok(near(tr.tracks().tool, 1000), `seed ${seed}: tool on the right hand`);
  }
});

test('tracker: tracks have stable ids; swap(id) makes that track the lead and is idempotent', () => {
  const tr = feed(30, (t) => [{ x: 400, y: 600, size: SIZE }, t > 0.3 ? { x: 1000, y: 600, size: SIZE } : null]);
  const now = 29 * FRAME;
  const { lead, tool } = tr.read(now);
  assert.ok(Number.isInteger(lead.id) && Number.isInteger(tool.id) && lead.id !== tool.id, 'distinct ids');
  assert.ok(Math.abs(lead.age - now) < 1 && tool.age < lead.age, 'snapshot ages (ms since first tracked)');
  tr.swap(tool.id);
  assert.equal(tr.read(now).lead.id, tool.id, 'the named track leads');
  tr.swap(tool.id);
  assert.equal(tr.read(now).lead.id, tool.id, 'swapping to the lead again changes nothing');
  tr.swap(12345);
  assert.equal(tr.read(now).lead.id, tool.id, 'an unknown id changes nothing');
  tr.swap();
  assert.equal(tr.read(now).lead.id, lead.id, 'without an id the hands trade roles');
  // A track that comes back after expiring is a new track with a new id.
  const tr2 = feed(60, (t) => [t > 1 && t < 1.7 ? null : { x: 400, y: 600, size: SIZE }]);
  assert.ok(tr2.read(59 * FRAME).lead.id > tool.id, 'ids are never reused');
});

test('tracker: a window resize keeps the hands, moves them with the new mapping and reads no motion', (t) => {
  const view = { W: 1440, H: 900 };
  const map = (lm) => toScreen(lm, view, CAM.W, CAM.H);
  let ids = null;
  let worst = 0;
  feed(60, () => [{ x: 400, y: 640, size: SIZE }, { x: 1000, y: 640, size: SIZE }], (tr, k, tt, ms) => {
    if (k === 30) {
      ids = tr.tracks();
      Object.assign(view, { W: 1000, H: 900 }); // takes effect on the next frame
    }
    if (k <= 30) return;
    const s = tr.read(ms);
    worst = Math.max(worst, Math.abs(s.lead.pvx), Math.abs(s.tool.pvx), Math.abs(s.lead.vx), Math.abs(s.tool.vx));
    assert.ok(tr.tracks().lead === ids.lead && tr.tracks().tool === ids.tool, `same tracks at frame ${k}`);
    // 1440 -> 1000 wide at the same height: the picture is cropped, x' = 1000 / 2 + (x - 1440 / 2).
    assert.ok(Math.abs(s.lead.x - (400 - 220)) < 30, `lead moved with the mapping (x ${Math.round(s.lead.x)})`);
  }, 1, { map });
  t.diagnostic(`fastest wrist / fingertip reading after the resize: ${Math.round(worst)} px/s`);
  assert.ok(worst < 300, `resize reads as ${Math.round(worst)} px/s of motion`);
});
