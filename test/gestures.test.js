// Gesture scenarios without throwing: no false throws, rotating the figure by turning a hand, and the two-hand modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, flights } from './harness.js';
import { ease } from './synth.js';
import { twoHands, flickReport, spinReport, omegaAt } from './scenes.js';

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

// --- e. turning a hand spins the figure ---------------------------------------------------------------------------

/** One gesture (`kind` = roll | turn, 180 degrees in 0.3 s) on the lead (alone) or on the tool hand. */
function assertSpin(t, { who, kind }) {
  const extra = [];
  extra[who] = (tt) => ({ [kind]: Math.PI * ease(tt, T0, T0 + 0.3) });
  const r = run({ duration: 5, hands: twoHands({ sep: 800, alone: who === 0, extra }) });
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
