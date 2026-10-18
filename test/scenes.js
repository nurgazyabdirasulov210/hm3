// Scripted hand motions for the scenario tests, plus measurements shared by them.
import { flick, ease } from './synth.js';
import { THROW } from '../src/sim.js';

export const SIZE = 200; // palm size in screen px: a hand ~50 cm from a 1280x720 webcam on a 1440x900 screen
export const Y = 640; // palm height: hands held in the lower part of the picture, the figure hovers above
export const ENTER = 0.6; // the second hand shows up after the first, so the first one is the lead

/** Camera frames of hand `i` dropped around time `t` (n frames centred on it), e.g. motion blur at peak speed. */
export const dropAround = (i, t, n) => (tc, j) => j === i && n > 0 && tc >= t - n / 60 && tc < t + n / 60;

/**
 * A sideways throw by hand `who` (0 left, 1 right) at time t0 toward +dir: the wrist speeds up to `peak` px/s
 * in 150 ms, slows down over 200 ms, and the hand drifts back to where it started over the next half second.
 * Returns x(t) offset in px for that hand.
 */
export function throwMotion({ t0, peak, dir, rise = 0.15, fall = 0.2 }) {
  return (t) => {
    const f = flick(t - t0, { peak, rise, fall });
    return dir * f.d * (1 - ease(t, t0 + rise + fall + 0.1, t0 + rise + fall + 0.6));
  };
}

/**
 * Two hands at the same height `sep` px apart, centred on the screen. `motions[i](t)` adds an x offset to hand i.
 * Hand 0 (left of the picture, the user's left hand) enters first and leads; hand 1 enters at ENTER, unless alone.
 */
export function twoHands({ sep, size = SIZE, y = Y, motions = [], alone = false, extra = [] }) {
  const xs = [720 - sep / 2, 720 + sep / 2];
  return (t) =>
    [0, 1].map((i) => {
      if (i === 1 && (alone || t < ENTER)) return null;
      return { x: xs[i] + (motions[i] ? motions[i](t) : 0), y, size, side: i === 0 ? -1 : 1, ...(extra[i]?.(t) ?? {}) };
    });
}

/**
 * What the throw detector in sim.js saw during [t0, t1]: the substep with the fastest lead wrist, the flick
 * threshold for that hand, the distance to the other hand (px and palm sizes), the mode and the cooldown.
 */
export function flickReport(log, t0, t1) {
  let best = null;
  for (const e of log) {
    if (e.t < t0 || e.t > t1 || !e.lead) continue;
    if (!best || Math.abs(e.lead.pvx) > Math.abs(best.lead.pvx)) best = e;
  }
  if (!best) return null;
  const { lead, tool } = best;
  const threshold = Math.max(THROW.minSpeed, lead.size * THROW.speed);
  const dist = tool ? Math.hypot(lead.x - tool.x, lead.y - tool.y) : null;
  return {
    t: +best.t.toFixed(3),
    seenPvx: Math.round(lead.pvx),
    seenPvy: Math.round(lead.pvy),
    threshold: Math.round(threshold),
    flick: Math.abs(lead.pvx) > threshold && Math.abs(lead.pvx) > Math.abs(lead.pvy) * THROW.ratio,
    dist: dist && Math.round(dist),
    palms: dist && +(dist / ((lead.size + tool.size) / 2)).toFixed(2),
    mode: best.mode,
    cooldown: +best.cooldown.toFixed(2),
  };
}

/** Degrees the figure turned by the user spin (|omega| integrated) during [t0, t1], and its peak |omega|. */
export function spinReport(log, t0, t1) {
  let deg = 0;
  let peak = 0;
  for (const e of log) {
    if (e.t < t0 || e.t > t1) continue;
    deg += (e.omega * e.dt * 180) / Math.PI;
    peak = Math.max(peak, e.omega);
  }
  return { deg: Math.round(deg), peak: +peak.toFixed(2) };
}

/** |omega| at time t (first substep at or after it). */
export const omegaAt = (log, t) => log.find((e) => e.t >= t)?.omega ?? 0;
