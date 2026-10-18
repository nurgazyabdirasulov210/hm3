// Shape selection (joined solids by the finger sum, single-hand special gestures, prisms by count),
// the sorcerer's shield and the portal design / level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, flights } from './harness.js';
import { ease } from './synth.js';
import { twoHands, throwMotion, SIZE, Y } from './scenes.js';
import { createSim, popcount, SHIELD, SPELL_HOLD } from '../src/sim.js';
import { SOLID_KEYS, SPECIAL_KEYS, MIDDLE, SHAPE_NAMES, SOLID_COLORS, segmentCounts, tesseractSegments } from '../src/shapes.js';

const at = (log, t) => log.find((e) => e.t >= t);
const DT = 1 / 120;

// A bare tracker snapshot (no landmarks to speak of), for driving the simulation directly.
function bare(x, mask, y = 650) {
  const pts = Array.from({ length: 21 }, () => ({ x, y }));
  return { id: x, x, y, size: 200, fingers: popcount(mask), mask, pts, open: 0.5, openRate: 0, vx: 0, vy: 0, pvx: 0, pvy: 0,
    twist: 0, twistW: 1, flip: 0, flipW: 1, up: { x: 0, y: 1, z: 0 }, fresh: true, age: 1e4 };
}
function bareSim() {
  const sides = [];
  const sim = createSim({ view: { W: 1440, H: 900 }, figure: { setSides: (n) => sides.push(n), update() {} } });
  let tt = 0;
  const step = (input, n = 1) => {
    for (let i = 0; i < n; i++) sim.step(input, DT, (tt += DT));
  };
  return { sim, sides, step };
}
const first = (n) => (1 << n) - 1; // mask with the first n fingers raised (thumb first)

// --- shapes --------------------------------------------------------------------------------------------------------

test('s1. shapes: 11 distinct joined solids incl. the original six, names and colours for every key, light geometry', () => {
  assert.equal(SOLID_KEYS.length, 11);
  assert.equal(new Set(SOLID_KEYS).size, 11);
  for (const k of ['sphere', 'tetra', 'octa', 'icosa', 'dodeca', 'torus', 'tesseract', 'merkaba', 'knot', 'geo', 'helix']) {
    assert.ok(SOLID_KEYS.includes(k), k);
  }
  const counts = segmentCounts();
  const all = [...SOLID_KEYS, ...Object.values(SPECIAL_KEYS), MIDDLE];
  assert.equal(new Set(all).size, all.length, 'special keys differ from the joined ones');
  for (const k of all) {
    assert.ok(SHAPE_NAMES[k], `name for ${k}`);
    assert.ok(counts[k] > 0 && counts[k] <= 400, `${k}: ${counts[k]} segments`);
    if (k !== MIDDLE) assert.equal(typeof SOLID_COLORS[k], 'number', `colour for ${k}`);
  }
  for (let n = 0; n <= 5; n++) assert.ok(SHAPE_NAMES[`prism${n}`], `prism${n}`);
});

test('s2. shapes: the tesseract really rotates in 4D (its projected edges change length) and stays in bounds', () => {
  const len = (a, i) => Math.hypot(a[i * 6] - a[i * 6 + 3], a[i * 6 + 1] - a[i * 6 + 4], a[i * 6 + 2] - a[i * 6 + 5]);
  const a = tesseractSegments(0, 0);
  const b = tesseractSegments(0.8, 0.5);
  assert.equal(a.length, 32 * 6);
  let changed = 0;
  for (let i = 0; i < 32; i++) if (Math.abs(len(a, i) - len(b, i)) > 0.05) changed++;
  assert.ok(changed > 8, `${changed} edges change length`);
  for (const v of b) assert.ok(Math.abs(v) < 1.4);
});

test('s3. joined: the solid is chosen by the raised fingers of both hands, 0..10', () => {
  const { sim, step } = bareSim();
  step({ lead: bare(620, 31), tool: bare(820, 31) }, 60);
  assert.equal(sim.state.mode, 'joined');
  for (let n = 0; n <= 10; n++) {
    const a = Math.min(n, 5);
    for (const [la, lb] of [[a, n - a], [n - a, a]]) {
      step({ lead: bare(620, first(la)), tool: bare(820, first(lb)) }, 12);
      assert.equal(sim.state.mode, 'joined');
      assert.equal(sim.state.solidKey, SOLID_KEYS[n], `${la} + ${lb} fingers`);
      assert.equal(sim.state.shapeKey, `j${n}`);
    }
  }
});

test('s4. joined (through the tracker): two fists, five fingers, two open hands', () => {
  for (const [ma, mb, key] of [[0, 0, 'sphere'], [31, 0, 'icosa'], [0b01110, 31, 'merkaba'], [31, 31, 'tesseract']]) {
    const r = run({ duration: 2.5, hands: twoHands({ sep: 240, extra: [() => ({ mask: ma }), () => ({ mask: mb })] }) });
    const e = r.log.at(-1);
    assert.equal(e.mode, 'joined', `${ma}/${mb}`);
    assert.equal(e.solidKey, key, `${ma}/${mb}`);
  }
});

test('s5. single hand: special gestures pick their own solids, the prism figure fades out', () => {
  for (const [mask, key] of Object.entries(SPECIAL_KEYS)) {
    const r = run({ duration: 1.5, hands: twoHands({ sep: 0, alone: true, extra: [() => ({ mask: +mask })] }) });
    const e = r.log.at(-1);
    assert.equal(e.mode, 'single');
    assert.equal(e.solidKey, key, `mask ${(+mask).toString(2)}`);
    assert.ok(e.vPrism < 0.05, `prism hidden (${e.vPrism.toFixed(2)})`);
    assert.ok(e.visibility > 0.9);
  }
  // Middle finger only is still the fist.
  const r = run({ duration: 1.5, hands: twoHands({ sep: 0, alone: true, extra: [() => ({ mask: 0b00100 })] }) });
  assert.equal(r.log.at(-1).solidKey, MIDDLE);
});

test('s6. single hand: every other mask keeps the prism by finger count', () => {
  for (const mask of [0, 0b00010, 0b00011, 0b00110, 0b01000, 0b00111, 0b01110, 0b01111, 0b11110, 0b11111, 0b11100]) {
    const r = run({ duration: 1.5, hands: twoHands({ sep: 0, alone: true, extra: [() => ({ mask })] }) });
    const e = r.log.at(-1);
    assert.equal(e.solidKey, null, `mask ${mask.toString(2)}`);
    assert.equal(e.shapeKey, `s${popcount(mask)}`);
    assert.equal(r.sides.at(-1), popcount(mask));
    assert.ok(e.vPrism > 0.95);
  }
});

test('s7. single hand: switching into a special gesture pops the figure, switching back restores the prism', () => {
  const mask = (tt) => (tt < 1.5 ? 31 : tt < 2.5 ? 0b10010 : 0b00110);
  const r = run({ duration: 3.5, hands: twoHands({ sep: 0, alone: true, extra: [(tt) => ({ mask: mask(tt) })] }) });
  assert.equal(at(r.log, 1.4).shapeKey, 's5');
  const e = at(r.log, 2.4);
  assert.equal(e.solidKey, 'crystal');
  assert.equal(e.shapeKey, 'crystal');
  const pulse = Math.max(...r.log.filter((x) => x.t > 1.5 && x.t < 1.8).map((x) => x.omega));
  assert.ok(pulse > 2, `shape-change kick (|omega| ${pulse.toFixed(2)})`);
  const end = r.log.at(-1);
  assert.equal(end.solidKey, null);
  assert.equal(end.shapeKey, 's2');
  assert.ok(end.vPrism > 0.9);
});

test('s8. a caught special shape is kept until the catching hand changes its gesture', () => {
  const motions = [throwMotion({ t0: 1.5, peak: 1700, dir: 1 })];
  const extra = [() => ({ mask: 0b00001 }), () => ({ mask: 31 })];
  const r = run({ duration: 3.5, seed: 11, hands: twoHands({ sep: 520, motions, extra }) });
  const fl = flights(r.log);
  assert.equal(fl.length, 1);
  assert.ok(fl[0].end);
  const after = at(r.log, r.log[fl[0].end].t + 0.5);
  assert.equal(after.solidKey, 'star', 'the star stays with the catching (open) hand');
});

// --- shield --------------------------------------------------------------------------------------------------------

test('h1. shield: the sorcerer gesture raises it over the palm, the figure hides, then it fades and is gone', () => {
  const mask = (tt) => (tt >= 1.5 && tt < 3 ? SHIELD.mask : 31);
  const r = run({ duration: 5, hands: twoHands({ sep: 0, alone: true, extra: [(tt) => ({ mask: mask(tt) })] }) });
  assert.equal(at(r.log, 1.4).shield, null, 'no shield before');
  const up = at(r.log, 2.5);
  assert.ok(up.shield, 'shield up');
  assert.ok(up.shield.vis > 0.95, `vis ${up.shield.vis}`);
  assert.ok(up.visibility < 0.05, `figure hidden (${up.visibility.toFixed(2)})`);
  const { x, y, r: rad, angle } = up.shield;
  t_near(x, 720, 30, 'centre x');
  assert.ok(y < Y && y > Y - SIZE * 0.6, `centre a bit above the palm (${Math.round(y)})`);
  t_near(rad, SIZE * SHIELD.size, SIZE * 0.25, 'radius');
  t_near(angle, 0, 0.15, 'upright hand: angle 0');
  // Fading out: still there, vis going down, then null.
  const fading = r.log.filter((e) => e.t > 3.15 && e.shield);
  assert.ok(fading.length > 0, 'fades instead of vanishing');
  for (let i = 1; i < fading.length; i++) assert.ok(fading[i].shield.vis <= fading[i - 1].shield.vis + 1e-9);
  const end = r.log.at(-1);
  assert.equal(end.shield, null, 'gone in the end');
  assert.ok(end.visibility > 0.9, 'the figure is back');
  assert.equal(end.shapeKey, 's5');
});

function t_near(v, want, tol, what) {
  assert.ok(Math.abs(v - want) < tol, `${what}: ${v.toFixed?.(2) ?? v}, want ${want} +- ${tol}`);
}

test('h2. shield: follows the hand roll (smoothly, without wrap-around jumps)', () => {
  // Roll the hand 60 degrees counter-clockwise on screen, then 60 degrees clockwise.
  const roll = (tt) => (Math.PI / 3) * (ease(tt, 2, 2.4) - 2 * ease(tt, 3, 3.6));
  const r = run({ duration: 4.5, hands: twoHands({ sep: 0, alone: true, extra: [(tt) => ({ mask: SHIELD.mask, roll: roll(tt) })] }) });
  for (const tt of [1.9, 2.8, 4.4]) {
    const e = at(r.log, tt);
    // Counter-clockwise on screen is a negative angle (screen y points down).
    t_near(e.shield.angle, -roll(tt), 0.12, `angle at ${tt} s`);
  }
  const e = at(r.log, 2.8);
  // The centre moves toward the fingers: to the left of the palm for a counter-clockwise roll.
  assert.ok(e.shield.x < 720 - SIZE * 0.1, `centre follows the fingers (x ${Math.round(e.shield.x)})`);
  const shields = r.log.filter((x) => x.shield && x.t > 1.5);
  for (let i = 1; i < shields.length; i++) {
    assert.ok(Math.abs(shields[i].shield.angle - shields[i - 1].shield.angle) < 0.1, 'no jumps');
  }
});

test('h3. shield: no throw while it is up (or still fading), the same flick throws without it', () => {
  const scene = (mask) =>
    run({
      duration: 3.5,
      seed: 11,
      hands: twoHands({ sep: 520, motions: [throwMotion({ t0: 1.5, peak: 1700, dir: 1 })], extra: [() => ({ mask })] }),
    });
  assert.equal(flights(scene(31).log).length, 1, 'open hand throws');
  const r = scene(SHIELD.mask);
  assert.equal(flights(r.log).length, 0, 'no flight with the shield up');
  assert.ok(at(r.log, 1.6).shield);
  // Right after the shield goes down it is still fading: a flick then does not throw either.
  const mask = (tt) => (tt < 1.4 ? SHIELD.mask : 31);
  const r2 = run({
    duration: 3,
    seed: 11,
    hands: twoHands({ sep: 520, motions: [throwMotion({ t0: 1.42, peak: 1700, dir: 1 })], extra: [(tt) => ({ mask: mask(tt) })] }),
  });
  const launch = flights(r2.log)[0];
  if (launch) assert.equal(r2.log[launch.start - 1].shield, null, 'a throw only launches once the shield is gone');
});

test('h4. shield: index + pinky without the thumb is the rock crystal, not a shield; not in joined mode', () => {
  const r = run({ duration: 1.5, hands: twoHands({ sep: 0, alone: true, extra: [() => ({ mask: 0b10010 })] }) });
  assert.equal(r.log.at(-1).shield, null);
  const j = run({ duration: 2.5, hands: twoHands({ sep: 240, extra: [() => ({ mask: SHIELD.mask }), () => ({ mask: 31 })] }) });
  const e = j.log.at(-1);
  assert.equal(e.mode, 'joined');
  assert.equal(e.shield, null);
  assert.equal(e.solidKey, SOLID_KEYS[8]);
});

// --- portal design and level -----------------------------------------------------------------------------------------

function portal(leadMask, toolMask) {
  const { sim, step } = bareSim();
  step({ lead: bare(620, 31), tool: bare(820, 31) }, 120); // together: joined
  step({ lead: bare(350, leadMask), tool: bare(1090, toolMask) }, 6); // apart: portal
  assert.equal(sim.state.mode, 'portal');
  return { sim, go: (lm, tm, n) => step({ lead: bare(350, lm), tool: bare(1090, tm) }, n) };
}

test('p1. portal: the lead hand picks the design (middle/ring/pinky -> 0..7), the tool hand sets the level (0..3)', () => {
  for (let spell = 0; spell < 8; spell++) {
    const { sim } = portal(0b00011 | (spell << 2), 0b00011);
    assert.equal(sim.state.portalSpell, spell, `pattern ${spell.toString(2)} on entry`);
  }
  const { sim, go } = portal(0b00011, 0b00011);
  for (let spell = 0; spell < 8; spell++) {
    go(0b00011 | (spell << 2), 31, Math.ceil((SPELL_HOLD + 0.05) / DT));
    assert.equal(sim.state.portalSpell, spell);
  }
  for (const [toolMask, level] of [[0, 0], [0b00011, 0], [0b00100, 1], [0b10000, 1], [0b01100, 2], [0b11100, 3], [31, 3]]) {
    go(0b00011, toolMask, 3);
    assert.equal(sim.state.portalLevel, level, `tool mask ${toolMask.toString(2)}`);
  }
  // Fingers of the lead hand no longer raise the level.
  go(31, 0b00011, 3);
  assert.equal(sim.state.portalLevel, 0);
});

test('p2. portal: a design change must hold for SPELL_HOLD; brief blips do not flicker it', () => {
  const { sim, go } = portal(0b00011, 31);
  assert.equal(sim.state.portalSpell, 0);
  go(0b11111, 31, Math.floor((SPELL_HOLD - 0.03) / DT)); // 0.12 s of pattern 7
  assert.equal(sim.state.portalSpell, 0, 'not yet');
  go(0b00011, 31, 1);
  go(0b11111, 31, Math.floor((SPELL_HOLD - 0.03) / DT));
  assert.equal(sim.state.portalSpell, 0, 'the hold restarts after going back');
  // Alternating patterns never settle.
  for (let i = 0; i < 40; i++) go(i % 2 ? 0b00111 : 0b01011, 31, 6);
  assert.equal(sim.state.portalSpell, 0, 'alternating patterns');
  go(0b10111, 31, Math.ceil(SPELL_HOLD / DT) + 1);
  assert.equal(sim.state.portalSpell, 5, 'held long enough');
});

test('p3. portal (through the tracker): design and level from real masks, level 0 outside the portal', () => {
  // As in the mode test: together by 3 s, apart over 4.5..5.5 s.
  const together = (dir) => (tt) => dir * (180 * ease(tt, 1.5, 3) - 230 * ease(tt, 4.5, 5.5));
  const r = run({
    duration: 7,
    hands: twoHands({
      sep: 600,
      motions: [together(1), together(-1)],
      extra: [(tt) => ({ mask: tt < 4 ? 31 : 0b10111 }), (tt) => ({ mask: tt < 4 ? 31 : 0b01111 })],
    }),
  });
  assert.equal(at(r.log, 3.8).portalLevel, 0, 'no level while joined');
  const e = r.log.at(-1);
  assert.equal(e.mode, 'portal');
  assert.equal(e.portalSpell, 0b101);
  assert.equal(e.portalLevel, 2);
});
