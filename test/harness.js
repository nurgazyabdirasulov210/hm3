// Runs the real tracker + simulation on synthetic hands with the same clocks as the browser:
// the camera delivers frames at 30 fps, the page renders at 60 fps and steps the simulation in 120 Hz substeps
// (the loop in main.js).
import { createTracker } from '../src/tracker.js';
import { createSim } from '../src/sim.js';
import { VIEW, CAM, makeRng, detect } from './synth.js';
import { toScreen } from '../src/tracker.js';

/**
 * scene: {
 *   duration: seconds,
 *   hands(t): [pose | null, pose | null] — the hands in front of the camera at time t (see synth.hand),
 *     index 0 / 1 are fixed physical hands (not tracker roles),
 *   drop(t, i): true when hand i is not detected in the camera frame captured at t (motion blur, occlusion),
 *   seed, fps (render, 60), camFps (30), noise ({ imageNoise, worldNoise }),
 *   resize(t): optional { W, H } of the window at time t (a resize moves the hands on screen, not in the camera).
 * }
 * Returns { log, frames, sim, tracker, sides }: log has one entry per substep, frames one per camera frame.
 */
export function run(scene) {
  const { duration, hands, drop = () => false, seed = 1, fps = 60, camFps = 30, noise, resize } = scene;
  const rng = makeRng(seed);
  const view = { ...VIEW }; // live, like the page's: main.js updates it on resize
  const tracker = createTracker(view, (lm) => toScreen(lm, view, CAM.W, CAM.H));
  const sides = [];
  const figure = { setSides: (n) => sides.push(n), update: () => {} };
  const sim = createSim({ view, figure });
  sim.swapHands = tracker.swap;

  const log = [];
  const frames = [];
  let camK = 0;
  let last = 0;
  let simTime = 0;
  for (let k = 1; k * (1000 / fps) <= duration * 1000; k++) {
    const now = k * (1000 / fps);
    if (resize) Object.assign(view, resize(now / 1000));
    // Camera frames captured up to now, processed in order (MediaPipe runs on each one).
    while (camK * (1000 / camFps) <= now) {
      const tc = (camK * (1000 / camFps)) / 1000;
      const poses = hands(tc).map((p, i) => (p && !drop(tc, i) ? p : null));
      tracker.process(detect(poses, rng, noise), camK * (1000 / camFps));
      const tr = tracker.tracks();
      frames.push({ t: tc, poses, lead: tr.lead, tool: tr.tool, leadX: tr.lead?.rawX, toolX: tr.tool?.rawX });
      camK++;
    }
    const rawDt = (now - last) / 1000;
    last = now;
    const input = tracker.read(now);
    const dt = Math.min(rawDt, 0.05);
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < n; i++) {
      simTime += dt / n;
      const s = sim.state;
      const before = { x: s.pos.x, y: s.pos.y, vx: s.vel.x, vy: s.vel.y, flying: !!s.flight };
      sim.step(input, dt / n, simTime);
      log.push({
        t: now / 1000,
        dt: dt / n,
        before,
        x: s.pos.x,
        y: s.pos.y,
        vx: s.vel.x,
        vy: s.vel.y,
        flight: s.flight && { phase: s.flight.phase, dir: s.flight.dir, boost: !!s.flight.boost },
        mode: s.mode,
        shapeKey: s.shapeKey,
        omega: s.omega.length(),
        omegaV: s.omega.clone(),
        cooldown: s.cooldown,
        visibility: s.visibility,
        lead: input.lead && {
          x: input.lead.x,
          y: input.lead.y,
          size: input.lead.size,
          pvx: input.lead.pvx,
          pvy: input.lead.pvy,
          fingers: input.lead.fingers,
        },
        tool: input.tool && { x: input.tool.x, y: input.tool.y, size: input.tool.size },
      });
    }
  }
  return { log, frames, sim, tracker, sides };
}

/** Flights in a log as [{ start, end, phases, dir }]: log indices, end is the first substep after landing or null. */
export function flights(log) {
  const out = [];
  let cur = null;
  log.forEach((e, i) => {
    if (e.flight && !cur) cur = { start: i, end: null, phases: [], dir: e.flight.dir };
    if (cur && e.flight && cur.phases.at(-1) !== e.flight.phase) cur.phases.push(e.flight.phase);
    if (cur && !e.flight) {
      cur.end = i;
      out.push(cur);
      cur = null;
    }
  });
  if (cur) out.push(cur);
  return out;
}

/** Distance of the figure from where it rests above a hand snapshot ({ x, y, size }). */
export const offRest = (e, h, hover) => Math.hypot(e.x - h.x, e.y - (h.y - h.size * hover));
