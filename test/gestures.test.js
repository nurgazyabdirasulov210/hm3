// Gesture scenarios without throwing: no false throws, rotating the figure by turning a hand, and the two-hand modes.
// The camera runs at 30 fps; the key scenarios also run at 15 and 60 fps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, flights } from './harness.js';
import { ease } from './synth.js';
import { twoHands, flickReport, spinReport, omegaAt } from './scenes.js';
import { createSim } from '../src/sim.js';

const T0 = 1.5; // the gesture starts here, after both hands are tracked and the figure has appeared

function assertNoThrow(t, r, t0 = 1, t1 = r.log.at(-1).t) {
  t.diagnostic(`fastest lead wrist: ${JSON.stringify(flickReport(r.log, t0, t1))}`);
  const fl = flights(r.log);
  const got = fl.map((f) => `${f.phases.join('>')} at ${r.log[f.start].t.toFixed(2)} s`);
  assert.equal(fl.length, 0, `no flight (got ${got})`);
}

// --- d. no false throws -------------------------------------------------------------------------------------------

test('d1. no false throw: moving the hand around at ~500 px/s', (t) => {
  // Side to side, 160 px each way, 500 px/s at the centre; up and down a little.
  const motion = (tt) => 160 * Math.sin(3.125 * Math.max(0, tt - 1));
  const r = run({
    duration: 6,
    hands: twoHands({ sep: 0, alone: true, motions: [motion], extra: [(tt) => ({ y: 640 + 40 * Math.sin(2 * tt) })] }),
  });
  assertNoThrow(t, r);
});

test('d1b. no false throw: moving the lead at ~500 px/s with the other hand in view', (t) => {
  const motion = (tt) => 140 * Math.sin(3.5 * Math.max(0, tt - 1));
  const r = run({ duration: 6, hands: twoHands({ sep: 900, motions: [motion] }) });
  assertNoThrow(t, r);
});

test('d2. no false throw: twisting the wrist 180 degrees in the screen plane in 0.3 s', (t) => {
  const roll = (tt) => ({ roll: Math.PI * ease(tt, T0, T0 + 0.3) - Math.PI * ease(tt, T0 + 1.5, T0 + 1.8) });
  const r = run({ duration: 5, hands: twoHands({ sep: 0, alone: true, extra: [roll] }) });
  assertNoThrow(t, r);
});

test('d3. no false throw: turning the hand over (palm <-> back) in 0.3 s', (t) => {
  const turn = (tt) => ({ turn: Math.PI * ease(tt, T0, T0 + 0.3) - Math.PI * ease(tt, T0 + 1.5, T0 + 1.8) });
  const r = run({ duration: 5, hands: twoHands({ sep: 0, alone: true, extra: [turn] }) });
  assertNoThrow(t, r);
});

test('d4. no false throw: slowly bringing the two hands together', (t) => {
  // 800 px apart -> 200 px apart over 2.5 s (each hand ~150 px/s at most).
  const r = run({
    duration: 5,
    hands: twoHands({
      sep: 800,
      motions: [(tt) => 300 * ease(tt, T0, T0 + 2.5), (tt) => -300 * ease(tt, T0, T0 + 2.5)],
    }),
  });
  assertNoThrow(t, r);
});

for (const camFps of [15, 60]) {
  test(`d1@${camFps}. no false throw: moving the hand around at ~500 px/s (camera ${camFps} fps)`, (t) => {
    const motion = (tt) => 160 * Math.sin(3.125 * Math.max(0, tt - 1));
    const extra = [(tt) => ({ y: 640 + 40 * Math.sin(2 * tt) })];
    const r = run({ duration: 6, camFps, hands: twoHands({ sep: 0, alone: true, motions: [motion], extra }) });
    assertNoThrow(t, r);
  });

  test(`d2@${camFps}. no false throw: twisting the wrist / turning the hand over in 0.3 s (camera ${camFps} fps)`, (t) => {
    for (const kind of ['roll', 'turn']) {
      const turn = (tt) => ({ [kind]: Math.PI * ease(tt, T0, T0 + 0.3) - Math.PI * ease(tt, T0 + 1.5, T0 + 1.8) });
      const r = run({ duration: 5, camFps, hands: twoHands({ sep: 0, alone: true, extra: [turn] }) });
      assertNoThrow(t, r);
    }
  });
}

test('d5. no false throw: resizing the window with a hand in view', (t) => {
  // The camera -> screen mapping changes at 2 s, so the still hand jumps on screen in one frame.
  for (const [W, H] of [[1000, 900], [1200, 900], [1440, 800], [1920, 1080], [1300, 900]]) {
    for (const alone of [true, false]) {
      const r = run({
        duration: 3.5,
        hands: twoHands({ sep: 800, alone }),
        resize: (tt) => (tt >= 2 ? { W, H } : { W: 1440, H: 900 }),
      });
      t.diagnostic(`${W}x${H}, ${alone ? 'one hand' : 'two hands'}: ${JSON.stringify(flickReport(r.log, 1.9, 3.5))}`);
      assertNoThrow(t, r);
      // The tracks survive the resize: the same lead (and tool) before and after.
      const before = r.frames.findLast((fr) => fr.t < 2);
      const after = r.frames.at(-1);
      assert.ok(after.lead === before.lead && after.tool === before.tool, `${W}x${H}: same tracks after the resize`);
    }
  }
});

for (const camFps of [15, 30, 60]) {
  test(`d6@${camFps}. no false throw: a one-frame landmark glitch of up to 1.2 palm sizes (camera ${camFps} fps)`, (t) => {
    for (const jump of [0.2, 0.25, 0.3, 0.5, 0.8, 1, 1.2]) {
      for (const moving of [false, true]) {
        for (let seed = 1; seed <= 4; seed++) {
          // A still hand, or one moving side to side at ~500 px/s, jumps by `jump` palm sizes for one camera frame.
          const t0 = 2 + seed * 0.0137;
          const base = (tt) => (moving ? 160 * Math.sin(3.125 * Math.max(0, tt - 1)) : 0);
          const motion = (tt) => base(tt) + (tt >= t0 && tt < t0 + 1 / camFps - 1e-9 ? jump * 200 : 0);
          const r = run({ duration: 2.8, seed, camFps, hands: twoHands({ sep: 0, alone: true, motions: [motion] }) });
          const fl = flights(r.log);
          assert.equal(fl.length, 0, `glitch ${jump} palm sizes (${moving ? 'moving' : 'still'}, seed ${seed}): `
            + `${JSON.stringify(flickReport(r.log, 1.9, 2.5))}`);
        }
      }
    }
  });
}

// --- e. turning a hand spins the figure ---------------------------------------------------------------------------

/** One gesture (`kind` = roll | turn, 180 degrees in 0.3 s) on the lead (alone) or on the tool hand. */
function assertSpin(t, { who, kind, camFps = 30, seed = 1 }) {
  const extra = [];
  extra[who] = (tt) => ({ [kind]: Math.PI * ease(tt, T0, T0 + 0.3) });
  const r = run({ duration: 5, seed, camFps, hands: twoHands({ sep: 800, alone: who === 0, extra }) });
  const idle = omegaAt(r.log, T0 - 0.01);
  const spin = spinReport(r.log, T0, T0 + 3);
  const after = omegaAt(r.log, T0 + 0.8);
  t.diagnostic(`|omega| idle ${idle.toFixed(2)}, peak ${spin.peak} rad/s, `
    + `0.5 s after the gesture ${after.toFixed(2)} rad/s, turned ${spin.deg} degrees in 3 s`);
  assert.ok(idle < 0.3, 'figure not spinning before the gesture');
  assert.ok(spin.peak > 3, `spins up (peak |omega| ${spin.peak} rad/s)`);
  assert.ok(after > 1, `keeps turning afterwards (|omega| ${after.toFixed(2)} rad/s 0.5 s later)`);
  assert.ok(spin.deg > 180, `turns at least half a revolution (${spin.deg} degrees)`);
  assertNoThrow(t, r);
}

test('e1. rotation: in-plane twist of the lead hand (alone)', (t) => assertSpin(t, { who: 0, kind: 'roll' }));
test('e2. rotation: turning the lead hand over (alone)', (t) => assertSpin(t, { who: 0, kind: 'turn' }));
test('e3. rotation: in-plane twist of the tool hand', (t) => assertSpin(t, { who: 1, kind: 'roll' }));
test('e4. rotation: turning the tool hand over', (t) => assertSpin(t, { who: 1, kind: 'turn' }));

// The gesture rates are smoothed with a time constant, so a faster camera does not let more landmark noise
// spin the figure, and a slower one does not blunt the gestures.
for (const camFps of [15, 60]) {
  for (const seed of [1, 2, 3]) {
    const at = `camera ${camFps} fps, seed ${seed}`;
    test(`e1@${camFps}. rotation: in-plane twist of the lead hand (${at})`, (t) => assertSpin(t, { who: 0, kind: 'roll', camFps, seed }));
    test(`e2@${camFps}. rotation: turning the lead hand over (${at})`, (t) => assertSpin(t, { who: 0, kind: 'turn', camFps, seed }));
    test(`e3@${camFps}. rotation: in-plane twist of the tool hand (${at})`, (t) => assertSpin(t, { who: 1, kind: 'roll', camFps, seed }));
    test(`e4@${camFps}. rotation: turning the tool hand over (${at})`, (t) => assertSpin(t, { who: 1, kind: 'turn', camFps, seed }));
  }
}

test('e5. still hands barely spin the figure, at any camera frame rate', (t) => {
  // Landmark noise alone: the user spin (|omega|) of the figure over 6 s with one or two still hands in view.
  for (const camFps of [15, 30, 60]) {
    for (const alone of [true, false]) {
      let sum = 0;
      let n = 0;
      for (const seed of [1, 2, 3]) {
        const r = run({ duration: 8, seed, camFps, hands: twoHands({ sep: 800, alone }) });
        for (const e of r.log.filter((e) => e.t > 2)) {
          sum += e.omega;
          n++;
        }
      }
      const mean = sum / n;
      t.diagnostic(`camera ${camFps} fps, ${alone ? 'one still hand' : 'two still hands'}: mean |omega| ${mean.toFixed(3)} rad/s`);
      assert.ok(mean < 0.05, `camera ${camFps} fps: mean |omega| ${mean.toFixed(3)} rad/s`);
    }
  }
});

// --- f. two-hand modes --------------------------------------------------------------------------------------------

// 600 px apart (3 palm sizes) -> together to 240 px (1.2) by 3 s, hold, -> apart to 700 px (3.5) over 4.5..5.5 s.
const together = (dir) => (tt) => dir * (180 * ease(tt, T0, 3) - 230 * ease(tt, 4.5, 5.5));
const modeScene = (drop) =>
  run({ duration: 7.5, hands: twoHands({ sep: 600, motions: [together(1), together(-1)] }), drop });
const modesIn = (r, t0, t1) => [...new Set(r.log.filter((e) => e.t >= t0 && e.t <= t1).map((e) => e.mode))];
const gap = (i, t0) => (tc, j) => j === i && tc >= t0 && tc < t0 + 0.25; // 250 ms without hand i

test('f1. modes: hands brought together -> joined, then pulled apart -> portal', (t) => {
  const r = modeScene();
  t.diagnostic(`modes: before ${modesIn(r, 1, T0)}, together ${modesIn(r, 3.2, 4.5)}, apart ${modesIn(r, 5.8, 7.5)}`);
  assert.deepEqual(modesIn(r, 1, T0), ['single'], 'single while the hands are apart');
  assert.deepEqual(modesIn(r, 3.2, 4.5), ['joined'], 'joined once together');
  assert.deepEqual(modesIn(r, 5.8, 7.5), ['portal'], 'portal once pulled apart');
  assertNoThrow(t, r);
});

test('f2. modes: a 250 ms dropout of either hand keeps joined', (t) => {
  const g1 = gap(1, 3.3);
  const g0 = gap(0, 3.9);
  const r = modeScene((tc, j) => g1(tc, j) || g0(tc, j));
  t.diagnostic(`modes while joined: ${modesIn(r, 3.2, 4.5)}`);
  assert.deepEqual(modesIn(r, 3.2, 4.5), ['joined']);
});

test('f3. modes: a 250 ms dropout of either hand keeps the portal', (t) => {
  const g1 = gap(1, 6.0);
  const g0 = gap(0, 6.8);
  const r = modeScene((tc, j) => g1(tc, j) || g0(tc, j));
  t.diagnostic(`modes in the portal: ${modesIn(r, 5.8, 7.5)}`);
  assert.deepEqual(modesIn(r, 5.8, 7.5), ['portal']);
});

// Portal corners from bare hand snapshots: thumb tip (4) and index tip (8) of each hand.
function portalHand(x, thumb, index) {
  const pts = Array.from({ length: 21 }, () => ({ x, y: 650 }));
  pts[4] = thumb;
  pts[8] = index;
  return { id: x, x, y: 650, size: 200, fingers: 2, mask: 3, pts, open: 0.5, openRate: 0, vx: 0, vy: 0, pvx: 0, pvy: 0,
    twist: 0, twistW: 1, flip: 0, flipW: 1, up: { x: 0, y: 1, z: 0 }, fresh: true, age: 1e4 };
}
/** Hands with the index fingers leaning in toward each other by `lean` degrees (thumbs at the bottom). */
function leaning(lean, lx, rx, L = 150) {
  const a = (lean * Math.PI) / 180;
  const lt = { x: lx + 60, y: 700 };
  const tt = { x: rx - 60, y: 700 };
  return {
    lead: portalHand(lx, lt, { x: lt.x + L * Math.sin(a), y: lt.y - L * Math.cos(a) }),
    tool: portalHand(rx, tt, { x: tt.x - L * Math.sin(a), y: tt.y - L * Math.cos(a) }),
  };
}
// Does the closed loop of four corners cross itself?
function bowTie(c) {
  const o = (a, b, p) => Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  const cross = (p, q, r, s) => o(p, q, r) * o(p, q, s) < 0 && o(r, s, p) * o(r, s, q) < 0;
  return cross(c[0], c[1], c[2], c[3]) || cross(c[1], c[2], c[3], c[0]);
}
function portalSim(hands) {
  const sim = createSim({ view: { W: 1440, H: 900 }, figure: { setSides() {}, update() {} } });
  let tt = 0;
  for (let i = 0; i < 120; i++) sim.step(hands(620, 820, i), 1 / 120, (tt += 1 / 120)); // together: joined
  for (let i = 0; i < 120; i++) sim.step(hands(350, 1090, i), 1 / 120, (tt += 1 / 120)); // apart: portal
  return { sim, step: (input) => sim.step(input, 1 / 120, (tt += 1 / 120)) };
}

test('f4. portal: the corners never cross into a bow-tie, whatever way the index fingers lean', (t) => {
  for (const lean of [0, 30, 44, 46, 60, 80, -30, -60]) {
    const { sim } = portalSim((lx, rx) => leaning(lean, lx, rx));
    assert.equal(sim.state.mode, 'portal');
    const c = sim.state.portalPts;
    t.diagnostic(`lean ${lean}: ${c.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(' ')}`);
    assert.ok(!bowTie(c), `lean ${lean} degrees: corners cross`);
  }
  // One hand turned upside down (its thumb on top): the loop still goes round.
  const { sim } = portalSim((lx, rx) => {
    const h = leaning(20, lx, rx);
    [h.tool.pts[4], h.tool.pts[8]] = [h.tool.pts[8], h.tool.pts[4]];
    return h;
  });
  assert.ok(!bowTie(sim.state.portalPts), 'one hand upside down: corners cross');
});

test('f5. portal: the corner order does not flip from frame to frame near a tie', () => {
  // The tool hand turns slowly through the point where both corner orders are equally long, with jitter.
  const { sim, step } = portalSim((lx, rx) => leaning(0, lx, rx));
  let flips = 0;
  let prev = null;
  for (let i = 0; i < 600; i++) {
    const h = leaning(0, 350, 1090);
    // Tool index tip swings from straight up (150 px) through level with its thumb to straight down.
    const a = Math.PI * (i / 600) + 0.05 * Math.sin(i * 1.7);
    const tt = h.tool.pts[4];
    h.tool.pts[8] = { x: tt.x - 150 * Math.sin(a) * 0.2, y: tt.y - 150 * Math.cos(a) };
    step(h);
    assert.equal(sim.state.mode, 'portal');
    const order = sim.state.portalPts[2] === h.tool.pts[8] ? 'straight' : 'crossed';
    if (prev && order !== prev) flips++;
    prev = order;
  }
  assert.ok(flips <= 1, `corner order flipped ${flips} times`);
});
