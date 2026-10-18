// Throwing scenarios: realistic flicks seen through the tracker at 30 fps (the key ones also at 15 and 60 fps),
// simulated like the browser loop.
// Known-failing scenarios are marked `todo` with the reason, so `npm test` stays green until they are fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, flights } from './harness.js';
import { ease } from './synth.js';
import { SIZE, Y, twoHands, throwMotion, dropAround, flickReport } from './scenes.js';
import { CFG, THROW, createSim } from '../src/sim.js';

const T0 = 1.5; // first throw
const T1 = 4.0; // throw back, well after the landing cooldown
const PEAK_AT = 0.15; // the wrist is fastest this long after the flick starts

// Realistic throw: hands 520 px apart (2.6 palm sizes), a 1700 px/s flick, 2 camera frames lost to motion blur.
const REAL = { sep: 520, peak: 1700, drops: 2 };
// Hard throw with the hands far apart: what currently gets through the detector.
const HARD = { sep: 1000, peak: 2600, drops: 0 };

function throwScene({ sep, peak, drops }, { back = false, alone = false, camFps = 30 } = {}) {
  const motions = [throwMotion({ t0: T0, peak, dir: 1 }), back ? throwMotion({ t0: T1, peak, dir: -1 }) : null];
  let drop = dropAround(0, T0 + PEAK_AT, drops);
  if (back) {
    const d1 = dropAround(1, T1 + PEAK_AT, drops);
    const d0 = drop;
    drop = (t, i) => d0(t, i) || d1(t, i);
  }
  return run({ duration: back ? 6.5 : 4, seed: 11, camFps, hands: twoHands({ sep, alone, motions }), drop });
}

// Where hand i rests (no motion), as the figure should hover above it.
const restOf = (sep, i) => ({ x: 720 + (i ? sep / 2 : -sep / 2), y: Y - SIZE * CFG.hover });
const entryAt = (log, t) => log.find((e) => e.t >= t);

/** Asserts a throw from hand `from` that is caught by hand `to` (both still) during [t0, t0 + 1.5]. */
function assertCatch(t, r, { sep, t0, from, to }) {
  const report = flickReport(r.log, t0, t0 + 0.6);
  t.diagnostic(`detector: ${JSON.stringify(report)}`);
  const fl = flights(r.log).filter((f) => r.log[f.start].t >= t0 && r.log[f.start].t < t0 + 0.6);
  t.diagnostic(`flights: ${JSON.stringify(fl.map((f) => ({ phases: f.phases, t: r.log[f.start].t })))}`);
  assert.equal(fl.length, 1, 'one flight starts during the flick');
  const f = fl[0];
  assert.equal(f.dir, Math.sign(to - from), 'flies toward the other hand');
  assert.deepEqual(f.phases, ['home'], 'heads straight for the other hand');
  assert.ok(f.end !== null, 'lands');
  const shapeBefore = r.log[f.start].shapeKey;
  const settled = entryAt(r.log, r.log[f.end].t + 0.5);
  const rest = restOf(sep, to);
  const off = Math.hypot(settled.x - rest.x, settled.y - rest.y);
  t.diagnostic(`0.5 s after landing: ${Math.round(off)} px from the rest point above hand ${to}`);
  assert.ok(off < 0.4 * SIZE, `figure rests above hand ${to} (${Math.round(off)} px off)`);
  // Roles swap: the tracker's lead is the catching hand now.
  const frame = r.frames.find((fr) => fr.t >= settled.t);
  const leadX = frame.leadX;
  assert.ok(Math.abs(leadX - restOf(sep, to).x) < 80, `tracker lead is hand ${to} (lead x ${Math.round(leadX)})`);
  assert.equal(settled.shapeKey, shapeBefore, 'shape is kept after the catch');
}

test('a. throw to the other hand (realistic: 520 px apart, 1700 px/s flick, 2 dropped frames)', (t) => {
  const r = throwScene(REAL);
  assertCatch(t, r, { sep: REAL.sep, t0: T0, from: 0, to: 1 });
});

test('a1. throw to the other hand (realistic, no dropped frames)', (t) => {
  const r = throwScene({ ...REAL, drops: 0 });
  assertCatch(t, r, { sep: REAL.sep, t0: T0, from: 0, to: 1 });
});

test('a2. throw to the other hand (hard: 1000 px apart, 2600 px/s flick)', (t) => {
  const r = throwScene(HARD);
  assertCatch(t, r, { sep: HARD.sep, t0: T0, from: 0, to: 1 });
});

test('b. throw back right after the cooldown (realistic)', (t) => {
  const r = throwScene(REAL, { back: true });
  assertCatch(t, r, { sep: REAL.sep, t0: T0, from: 0, to: 1 });
  assertCatch(t, r, { sep: REAL.sep, t0: T1, from: 1, to: 0 });
});

test('b2. throw back right after the cooldown (hard)', (t) => {
  const r = throwScene(HARD, { back: true });
  assertCatch(t, r, { sep: HARD.sep, t0: T0, from: 0, to: 1 });
  assertCatch(t, r, { sep: HARD.sep, t0: T1, from: 1, to: 0 });
});

test('b3. throw back and forth 4 times in a row (realistic flicks, one every 1.6 s)', (t) => {
  const every = 1.6;
  const starts = [0, 1, 2, 3].map((k) => T0 + k * every);
  // Throw k comes from hand k % 2 toward the other one.
  const motions = [0, 1].map((i) => {
    const own = starts.filter((_, k) => k % 2 === i).map((t0) => throwMotion({ t0, peak: REAL.peak, dir: i ? -1 : 1 }));
    return (tt) => own.reduce((sum, m) => sum + m(tt), 0);
  });
  const r = run({ duration: T0 + 4 * every + 0.5, seed: 11, hands: twoHands({ sep: REAL.sep, motions }) });
  assert.equal(flights(r.log).length, 4, 'exactly one flight per flick');
  starts.forEach((t0, k) => assertCatch(t, r, { sep: REAL.sep, t0, from: k % 2, to: 1 - (k % 2) }));
  assertSmooth(t, r);
});

/** Asserts a boomerang throw: out, back, resting above the throwing hand again. */
function assertBoomerang(t, r) {
  const report = flickReport(r.log, T0, T0 + 0.6);
  t.diagnostic(`detector: ${JSON.stringify(report)}`);
  const fl = flights(r.log);
  t.diagnostic(`flights: ${JSON.stringify(fl.map((f) => ({ phases: f.phases, t: r.log[f.start].t })))}`);
  assert.equal(fl.length, 1, 'one flight');
  assert.deepEqual(fl[0].phases, ['out', 'back'], 'flies out and comes back');
  assert.ok(fl[0].end !== null, 'lands');
  const maxX = Math.max(...r.log.slice(fl[0].start, fl[0].end).map((e) => e.x));
  t.diagnostic(`flew out to x = ${Math.round(maxX)} (thrown from x = 720)`);
  assert.ok(maxX > 720 + 0.25 * 1440, 'flies well out toward the screen edge');
  const settled = entryAt(r.log, r.log[fl[0].end].t + 0.5);
  const off = Math.hypot(settled.x - 720, settled.y - (Y - SIZE * CFG.hover));
  t.diagnostic(`0.5 s after landing: ${Math.round(off)} px from the rest point`);
  assert.ok(off < 0.4 * SIZE, `rests above the throwing hand (${Math.round(off)} px off)`);
}

test('c. throw with no second hand (realistic: 1700 px/s flick)', (t) => {
  assertBoomerang(t, throwScene({ sep: 0, peak: 1700, drops: 0 }, { alone: true }));
});

test('c2. throw with no second hand (hard: 2600 px/s flick, 2 dropped frames)', (t) => {
  assertBoomerang(t, throwScene({ sep: 0, peak: 2600, drops: 2 }, { alone: true }));
});

/**
 * Smoothness of every flight in a run: per-substep displacement within the speed bound (1 px slack for
 * landmark noise near rest) and velocity changes within the launch acceleration (THROW.boost).
 */
function assertSmooth(t, r) {
  const fl = flights(r.log);
  assert.ok(fl.length > 0, 'there is a flight to check');
  let worstJump = { excess: 0 };
  let worstAcc = { a: 0 };
  for (const f of fl) {
    const end = Math.min(r.log.length - 1, (f.end ?? r.log.length - 1) + 1);
    for (let i = f.start + 1; i <= end; i++) {
      const e = r.log[i];
      const d = Math.hypot(e.x - e.before.x, e.y - e.before.y);
      const vmax = Math.max(Math.hypot(e.vx, e.vy), Math.hypot(e.before.vx, e.before.vy));
      const excess = d - (vmax * e.dt * 1.1 + 1);
      if (excess > worstJump.excess) worstJump = { excess, d, vmax, t: e.t, phase: e.flight?.phase };
      const a = Math.hypot(e.vx - e.before.vx, e.vy - e.before.vy) / e.dt;
      if (a > worstAcc.a) worstAcc = { a, t: e.t, phase: e.flight?.phase };
    }
  }
  t.diagnostic(`worst jump: ${JSON.stringify(worstJump)}`);
  const bound = THROW.boost * 1.05;
  const acc = Math.round(worstAcc.a);
  t.diagnostic(`peak acceleration: ${acc} px/s^2 (bound ${bound}) at ${JSON.stringify(worstAcc)}`);
  const jump = `${worstJump.d?.toFixed(1)} px in a substep at ${Math.round(worstJump.vmax)} px/s`;
  assert.ok(worstJump.excess <= 0, `no position jump (worst ${jump})`);
  assert.ok(worstAcc.a <= bound, `velocity continuous (peak acceleration ${acc} px/s^2)`);
}

test('g1. smooth flight: catch by the other hand (hard throw)', (t) => {
  assertSmooth(t, throwScene(HARD, { back: true }));
});

test('g2. smooth flight: catch with dropped frames (hard throw)', (t) => {
  assertSmooth(t, throwScene({ ...HARD, drops: 2 }));
});

test('g3. smooth flight: boomerang while the throwing hand moves back after the flick', (t) => {
  assertSmooth(t, throwScene({ sep: 0, peak: 2600, drops: 0 }, { alone: true }));
});

/**
 * From the flick on, each track keeps following its own hand: on every camera frame the thrower track sits on
 * the thrower and the other track on the other hand (where it was last detected while it is lost), and no track
 * was replaced by a new one.
 */
function assertIdentity(t, r) {
  const before = r.frames.findLast((fr) => fr.t < T0);
  const own = [before.lead, before.tool]; // track of hand 0 (the thrower) and of hand 1
  assert.ok(own[0] && own[1], 'both hands tracked before the flick');
  const last = [null, null]; // last detected pose of each hand
  const off = [0, 0];
  const worst = [0, 0];
  let replaced = 0;
  for (const fr of r.frames) {
    fr.poses.forEach((p, i) => p && (last[i] = p));
    if (fr.t < T0) continue;
    const tracks = [fr.lead, fr.tool];
    if (!tracks.includes(own[0]) || !tracks.includes(own[1])) replaced++;
    for (const i of [0, 1]) {
      const x = fr.lead === own[i] ? fr.leadX : fr.tool === own[i] ? fr.toolX : NaN;
      const d = Math.abs(x - last[i].x);
      if (!(d < 100)) off[i]++;
      if (d > worst[i]) worst[i] = d;
    }
  }
  t.diagnostic(`frames off: thrower track ${off[0]} (worst ${Math.round(worst[0])} px), `
    + `other track ${off[1]} (worst ${Math.round(worst[1])} px); frames with a replaced track: ${replaced}`);
  assert.equal(replaced, 0, 'the thrower is re-acquired as the same track, not as a new hand');
  assert.equal(off[0], 0, `the thrower track follows the thrower (worst ${Math.round(worst[0])} px off)`);
  assert.equal(off[1], 0, `the other track follows the other hand (worst ${Math.round(worst[1])} px off)`);
}

test('h. hand identity after a fast flick with 3 dropped frames (realistic, hands 520 px apart)', (t) => {
  assertIdentity(t, throwScene({ ...REAL, drops: 3 }));
});

test('h2. hand identity after a fast flick with 3 dropped frames (hands 1000 px apart)', (t) => {
  assertIdentity(t, throwScene({ ...HARD, drops: 3 }));
});

// --- other camera frame rates ---------------------------------------------------------------------------------------

// The wrist speed and the gesture rates are measured in time, not frames: the same flicks throw at 15 and 60 fps.
for (const camFps of [15, 60]) {
  test(`a@${camFps}. throw to the other hand (realistic, camera ${camFps} fps)`, (t) => {
    const r = throwScene(REAL, { camFps });
    assertCatch(t, r, { sep: REAL.sep, t0: T0, from: 0, to: 1 });
  });

  test(`a2@${camFps}. throw to the other hand (hard, camera ${camFps} fps)`, (t) => {
    const r = throwScene(HARD, { camFps });
    assertCatch(t, r, { sep: HARD.sep, t0: T0, from: 0, to: 1 });
  });

  test(`b@${camFps}. throw back right after the cooldown (realistic, camera ${camFps} fps)`, (t) => {
    const r = throwScene(REAL, { back: true, camFps });
    assertCatch(t, r, { sep: REAL.sep, t0: T0, from: 0, to: 1 });
    assertCatch(t, r, { sep: REAL.sep, t0: T1, from: 1, to: 0 });
  });

  test(`c@${camFps}. throw with no second hand (realistic, camera ${camFps} fps)`, (t) => {
    assertBoomerang(t, throwScene({ sep: 0, peak: 1700, drops: 0 }, { alone: true, camFps }));
  });
}

// --- regressions ----------------------------------------------------------------------------------------------------

for (const camFps of [15, 30, 60]) {
  test(`c3@${camFps}. a lone flick blurred out for 4 camera frames at its peak still throws (camera ${camFps} fps)`, (t) => {
    // Motion blur at the peak: the hand is lost for 4 frames (at 30 fps; as long at other rates) and found far
    // ahead. The displacement across the gap is the speed, so the flick registers.
    for (const [peak, arc] of [[1500, 0], [1500, 0.6], [2600, 1]]) {
      const hands = (tt) => {
        const d = throwMotion({ t0: T0, peak, dir: 1 })(tt);
        return [{ x: 500 + d, y: Y - arc * d * (1 - d / 500), size: SIZE }, null];
      };
      const r = run({ duration: 4, seed: 5, camFps, hands, drop: dropAround(0, T0 + PEAK_AT, 4) });
      const fl = flights(r.log);
      t.diagnostic(`peak ${peak} arc ${arc}: flights ${JSON.stringify(fl.map((f) => f.phases))}, `
        + `detector ${JSON.stringify(flickReport(r.log, T0, T0 + 0.6))}`);
      assert.deepEqual(fl.map((f) => f.phases), [['out', 'back']], `peak ${peak} arc ${arc}: boomerang throw`);
    }
  });
}

test('i. the thrower lost for the lead grace period mid-flight: the catcher keeps the figure and the lead', (t) => {
  // Right after a hard flick the thrower drops out of view and comes back where it started 500..600 ms later.
  // Its track expires inside the tracker, the catcher is promoted to lead and the thrower comes back as a new
  // tool, all while the figure is in the air: the flight still lands on the catcher (it is aimed at the catcher's
  // track id, not at "the tool"), and the catch leaves the catcher as the lead.
  for (const [fps, camFps] of [[30, 30], [20, 30], [24, 30], [60, 60]]) {
    for (const away of [500, 520, 560, 600]) {
      const r = run({
        duration: 4, seed: 11, fps, camFps,
        hands: twoHands({ sep: HARD.sep, motions: [throwMotion({ t0: T0, peak: HARD.peak, dir: 1 })] }),
        drop: (tc, i) => i === 0 && tc >= 1.7 && tc < 1.7 + away / 1000,
      });
      const fl = flights(r.log);
      const end = r.log.at(-1);
      const { lead } = r.tracker.tracks();
      const catcher = restOf(HARD.sep, 1);
      const what = `render ${fps} / camera ${camFps} fps, away ${away} ms`;
      assert.deepEqual(fl.map((f) => f.phases), [['home']], `${what}: one flight, to the catcher`);
      assert.ok(Math.abs(end.x - catcher.x) < 0.4 * SIZE, `${what}: figure ends above the catcher (x ${Math.round(end.x)})`);
      assert.ok(Math.abs(lead.rawX - catcher.x) < 60, `${what}: tracker lead is the catcher (x ${Math.round(lead.rawX)})`);
    }
  }
});

test('j. a harder flick throws faster (the launch speed is the fastest reading during the launch)', (t) => {
  // The first over-threshold reading comes early in a flick; the flight speed follows the flick up to THROW.launchMax.
  for (const peak of [1300, 1700, 2200]) {
    const r = run({ duration: 3, seed: 11, hands: twoHands({ sep: 0, alone: true, motions: [throwMotion({ t0: T0, peak, dir: 1 })] }) });
    const top = Math.max(...r.log.filter((e) => e.flight).map((e) => e.vx));
    const want = 0.9 * Math.min(peak, THROW.launchMax);
    t.diagnostic(`flick ${peak} px/s: figure flies out at up to ${Math.round(top)} px/s`);
    assert.ok(top > want, `flick ${peak} px/s: flies at ${Math.round(top)} px/s (want > ${Math.round(want)})`);
  }
});

test('k. a hand swept into view fast does not throw the figure as it arrives', (t) => {
  // The only hand enters from the left at 1600 px/s and stops within 250 ms: a new track is not a flick.
  for (const camFps of [30, 60]) {
    for (let seed = 1; seed <= 5; seed++) {
      const t0 = 1 + seed * 0.003;
      const hands = (tt) => {
        if (tt < t0) return [null, null];
        const u = Math.min(tt - t0, 0.25);
        return [{ x: 100 + 1600 * (u - (u * u) / 0.5), y: Y, size: SIZE }, null];
      };
      const r = run({ duration: 2.5, seed, camFps, hands });
      assert.equal(flights(r.log).length, 0, `camera ${camFps} fps, seed ${seed}: no throw`);
    }
  }
});

test('l. the thrower twisting its hand on landing does not spin the caught figure (cooldown)', (t) => {
  // After a catch the thrower is the tool; its follow-through (a twist or a turn-over right at the landing) is
  // ignored during the landing cooldown, like the fingertip swipe.
  const motions = [throwMotion({ t0: T0, peak: REAL.peak, dir: 1 })];
  const base = run({ duration: 3.5, seed: 11, hands: twoHands({ sep: REAL.sep, motions }) });
  const land = base.log[flights(base.log)[0].end].t;
  for (const kind of ['roll', 'turn']) {
    const extra = [(tt) => ({ [kind]: Math.PI * ease(tt, land - 0.05, land + 0.25) })];
    const r = run({ duration: 3.5, seed: 11, hands: twoHands({ sep: REAL.sep, motions, extra }) });
    let worst = 0;
    r.log.forEach((e, i) => {
      if (e.t > land && e.t < land + THROW.cooldown) worst = Math.max(worst, e.omegaV.distanceTo(base.log[i].omegaV));
    });
    t.diagnostic(`${kind} at the landing: spin differs by up to ${worst.toFixed(2)} rad/s from no ${kind}`);
    assert.ok(worst < 0.5, `${kind} at the landing changes the spin by ${worst.toFixed(2)} rad/s`);
  }
});

test('m. hands without ids (the ?demo hands): the tool catches, and swapHands() is called without an id', () => {
  // Bare snapshots like the ones main.js builds for the demo: no id, no age. The tool catches the figure and
  // the sim asks for a plain role swap.
  const sim = createSim({ view: { W: 1440, H: 900 }, figure: { setSides() {}, update() {} } });
  const calls = [];
  sim.swapHands = (id) => calls.push(id);
  const bare = (x, pvx = 0) => ({ x, y: Y, size: SIZE, fingers: 5, mask: 31, pts: Array.from({ length: 21 }, () => ({ x, y: Y })),
    open: 1, openRate: 0, vx: 0, vy: 0, pvx, pvy: 0, twist: 0, twistW: 1, flip: 0, flipW: 1, up: { x: 0, y: 1, z: 0 }, fresh: true });
  let tt = 0;
  let input = null;
  for (let i = 0; i < 600; i++) {
    const flick = i >= 240 && i < 246;
    // After the catch the hands have traded roles: the right hand leads.
    input = calls.length ? { lead: bare(1000), tool: bare(500) } : { lead: bare(500, flick ? 1500 : 0), tool: bare(1000) };
    sim.step(input, 1 / 120, (tt += 1 / 120));
  }
  assert.deepEqual(calls, [undefined], 'one plain swap');
  assert.ok(Math.abs(sim.state.pos.x - 1000) < 0.4 * SIZE, `figure rests above the catching hand (x ${Math.round(sim.state.pos.x)})`);
});
