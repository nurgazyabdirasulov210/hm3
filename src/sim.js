// Gesture-driven simulation of the figure: follow spring, modes, shape choice, spin, scale and throwing.
// Pure state machine, no DOM and no renderer: main.js feeds it hand snapshots and draws the result,
// tests feed it synthetic hands. Uses THREE only for vector / quaternion math.
import * as THREE from 'three';
import { SOLID_KEYS, MIDDLE } from './shapes.js';
import { clamp, smoothstep } from './filters.js';

export const CFG = {
  hover: 2.3, // figure hovers this many palm lengths above the palm centre
  radius: 0.8, // figure radius in palm lengths at scale 1
  followK: 180, // position spring: stiff enough to feel responsive...
  followC: 16, // ...underdamped enough to trail and overshoot a little
  gravity: 1400, // px/s^2, pulls the figure down once the lead hand is gone
  scaleMin: 0.35,
  scaleMax: 3.2,
  idleSpin: 0.9, // rad/s
  spinFriction: 0.7, // spin decay: a hard twist keeps the figure turning for a few revolutions
  spinGain: 0.84, // figure angular speed / hand angular speed while the hand turns
  maxBlur: 3.5,
  // Distances between the two palms, in palm sizes. The gap between the thresholds is hysteresis.
  joinAt: 2.0, // closer than this: hands joined
  portalAt: 2.8, // joined, then pulled further apart than this: portal
  leaveAt: 1.8, // portal, then brought closer than this: back to joined
};

// Throwing the figure: a fast sideways flick of the lead hand sends it flying.
// The flight is a chain of smooth legs (cubic Hermite curves): position and velocity stay continuous
// from launch to landing, and each leg ends at rest on its target, so the hand-off back to the
// follow spring is seamless too.
export const THROW = {
  speed: 9, // wrist speed that counts as a flick, in palm sizes per second...
  minSpeed: 900, // ...and never below this, px/s
  ratio: 1.6, // sideways speed must beat vertical speed by this factor
  launchMin: 900, // px/s
  launchMax: 1600,
  cruise: 0.75, // leg duration = distance / (cruise * launch speed)
  legMin: 0.32, // s
  legMax: 0.9,
  reach: 0.38, // with no hand to catch it, the figure flies this fraction of the screen width out
  lift: 0.35, // upward arc: initial vertical speed as a fraction of the horizontal one
  boost: 30000, // px/s^2, launch acceleration: reaches full speed in ~50 ms without a jump
  spin: 11, // rad/s while flying
  cooldown: 0.7, // s after a landing before the next throw
};

export const popcount = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);
// Only the middle finger up (the thumb is too unreliable to count).
const isMiddle = (m) => (m & 4) !== 0 && (m & 0b11010) === 0;

/**
 * Creates the simulation. `view` is { W, H } in CSS pixels (read live, so a resize applies at once);
 * `figure` needs setSides(n) and update(dt) (the prism figure, or a stub in tests).
 * step(input, dt, t) advances one substep; input is { lead, tool } hand snapshots from the tracker
 * (either may be null). After a catch it swaps input.lead / input.tool and calls sim.swapHands(),
 * which main.js wires to the tracker so the hands trade roles there too.
 */
export function createSim({ view, figure }) {
  const pos = { x: view.W / 2, y: view.H / 2 };
  const vel = { x: 0, y: 0 };
  let radius = 90;
  let scale = 1;
  let scaleV = 0;
  let scaleTarget = 1;
  let pop = 1; // extra scale spring used for appear / morph "pop"
  let popV = 0;
  let visibility = 0;
  let pulse = 0; // decaying kick after the shape changes
  let shapeKey = '';
  let shapeLock = null;
  let mode = 'single'; // 'single' | 'joined' | 'portal'
  let vPrism = 0;
  let solidKey = null;
  let flight = null; // { dir, speed, phase: 'out' | 'home' | 'back', leg, outX, outY }
  let cooldown = 0;
  let middle = false;
  let lastAnchor = null; // where the figure would rest, kept while the hand is briefly lost mid-flight
  let scaleHeld = 1; // after a catch the scale eases from this value to what the new tool hand says
  let scaleEase = 1;
  const bank = { x: 0, z: 0 };
  let portalPts = null;
  let portalLevel = 0;
  let spinY = 0;
  const omega = new THREE.Vector3();
  const qUser = new THREE.Quaternion();
  const qSpin = new THREE.Quaternion();
  const qBank = new THREE.Quaternion();
  const dq = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const euler = new THREE.Euler();
  const Y = new THREE.Vector3(0, 1, 0);

  function nextMode(lead, tool) {
    // A tool that is briefly missing (inside its grace period) keeps the mode, so it does not flicker.
    if (!lead || !tool) return 'single';
    const d = Math.hypot(lead.x - tool.x, lead.y - tool.y) / ((lead.size + tool.size) / 2);
    if (mode === 'single') return d < CFG.joinAt ? 'joined' : 'single';
    if (mode === 'joined') return d > CFG.portalAt ? 'portal' : 'joined';
    return d < CFG.leaveAt ? 'joined' : 'portal';
  }

  // Four corners in loop order: two fingertips (thumb, index) of each hand.
  function portalCorners(lead, tool) {
    const [lt, li, tt, ti] = [lead.pts[4], lead.pts[8], tool.pts[4], tool.pts[8]];
    const parallel = (li.x - lt.x) * (ti.x - tt.x) + (li.y - lt.y) * (ti.y - tt.y) >= 0;
    return parallel ? [lt, li, ti, tt] : [lt, li, tt, ti];
  }

  // Starts a flight leg from the current position and velocity, so velocity never jumps between legs.
  // A fast approach gets a shorter leg, so the curve does not overshoot its target.
  function startLeg(vx, vy, ex, ey) {
    const d = Math.hypot(ex - pos.x, ey - pos.y);
    let T = clamp(d / (THROW.cruise * flight.speed), THROW.legMin, THROW.legMax);
    const along = d > 1 ? (vx * (ex - pos.x) + vy * (ey - pos.y)) / d : 0;
    if (along > 0) T = Math.max(0.15, Math.min(T, (1.4 * d) / along));
    flight.leg = { x0: pos.x, y0: pos.y, vx, vy, T, t: 0 };
  }

  // Advances the leg towards a (possibly moving) end point; sets pos and vel. Returns true at the end.
  function legStep(L, ex, ey, dt) {
    L.t = Math.min(L.t + dt, L.T);
    const s = L.t / L.T;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = (s3 - 2 * s2 + s) * L.T;
    const h01 = 3 * s2 - 2 * s3;
    const d00 = (6 * s2 - 6 * s) / L.T;
    const d10 = 3 * s2 - 4 * s + 1;
    const d01 = (6 * s - 6 * s2) / L.T;
    pos.x = h00 * L.x0 + h10 * L.vx + h01 * ex;
    pos.y = h00 * L.y0 + h10 * L.vy + h01 * ey;
    vel.x = d00 * L.x0 + d10 * L.vx + d01 * ex;
    vel.y = d00 * L.y0 + d10 * L.vy + d01 * ey;
    return s >= 1;
  }

  const restOver = (h) => ({ x: h.x, y: h.y - h.size * CFG.hover });

  function launch(lead, tool) {
    const dir = Math.sign(lead.pvx);
    const speed = clamp(Math.abs(lead.pvx) * 0.9, THROW.launchMin, THROW.launchMax);
    const m = radius * scale * 1.2;
    flight = {
      dir,
      speed,
      phase: tool && (tool.x - pos.x) * dir > 0 ? 'home' : 'out',
      outX: clamp(pos.x + dir * view.W * THROW.reach, m, view.W - m),
      outY: pos.y,
      // Launch: speed up to the throw velocity with a bounded acceleration, then follow the curve.
      boost: { x: dir * speed, y: -speed * THROW.lift },
      leg: null,
    };
  }

  // One flight step. Returns 'caught' when the other hand has taken the figure.
  function fly(tool, rest, dt) {
    const f = flight;
    // A hand showing up on the far side catches the figure; a catcher that disappears sends it back.
    if (f.phase === 'out' && tool && (tool.x - pos.x) * f.dir > 0) {
      f.phase = 'home';
      if (f.leg) startLeg(vel.x, vel.y, restOver(tool).x, restOver(tool).y);
    } else if (f.phase === 'home' && !tool) {
      f.phase = 'back';
      if (f.leg) startLeg(vel.x, vel.y, rest.x, rest.y);
    }
    omega.y += (f.dir * THROW.spin - omega.y) * (1 - Math.exp(-5 * dt));
    const end = f.phase === 'home' ? restOver(tool) : f.phase === 'out' ? { x: f.outX, y: f.outY } : rest;

    if (f.boost) {
      const dvx = f.boost.x - vel.x;
      const dvy = f.boost.y - vel.y;
      const dv = Math.hypot(dvx, dvy);
      const k = Math.min(1, (THROW.boost * dt) / (dv || 1));
      vel.x += dvx * k;
      vel.y += dvy * k;
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;
      if (k === 1) {
        f.boost = null;
        startLeg(vel.x, vel.y, end.x, end.y);
      }
      return null;
    }

    if (!legStep(f.leg, end.x, end.y, dt)) return null;
    if (f.phase === 'out') {
      // Reached the far point: boomerang back to the hand that threw it.
      f.phase = 'back';
      startLeg(0, 0, rest.x, rest.y);
      return null;
    }
    flight = null;
    cooldown = THROW.cooldown;
    return f.phase === 'home' ? 'caught' : 'back';
  }

  // Turning a hand turns the figure: twisting in the screen plane rolls it around the view axis,
  // turning the hand over spins it around the hand's own up axis. It keeps spinning afterwards and slows down.
  const handAxis = new THREE.Vector3();
  function handSpin(h, dt) {
    if (!h?.fresh) return;
    // Ignored while the hand is opening/closing so scaling does not spin the figure.
    const steady = 1 - smoothstep(1, 2.5, Math.abs(h.openRate));
    const kTwist = 1 - Math.exp(-14 * smoothstep(1, 5, Math.abs(h.twist)) * h.twistW * steady * dt);
    omega.z += (-h.twist * CFG.spinGain - omega.z) * kTwist;
    const kFlip = 1 - Math.exp(-14 * smoothstep(1, 5, Math.abs(h.flip)) * h.flipW * steady * dt);
    handAxis.set(h.up.x, h.up.y, h.up.z);
    omega.addScaledVector(handAxis, (h.flip * CFG.spinGain - omega.dot(handAxis)) * kFlip);
  }

  function step(input, dt, t) {
    let { lead, tool } = input;
    cooldown = Math.max(0, cooldown - dt);
    // While the figure is in the air nothing else changes: no mode switches, no morphs.
    if (!flight) {
      mode = nextMode(lead, tool);
      // After a catch the figure keeps its shape until the catching hand changes its gesture.
      if (shapeLock && (!lead || lead.mask !== shapeLock.mask || mode !== 'single')) shapeLock = null;
      if (!shapeLock) {
        middle = mode === 'single' && !!lead && isMiddle(lead.mask);
        if (lead) solidKey = mode === 'joined' ? SOLID_KEYS[Math.min(lead.fingers, 5)] : middle ? MIDDLE : null;
      }
    }
    const joined = mode === 'joined';
    portalPts = mode === 'portal' ? portalCorners(lead, tool) : null;
    portalLevel = mode === 'portal' ? popcount(lead.mask & 0b11100) + popcount(tool.mask & 0b11100) : 0;
    vPrism += ((mode === 'single' && !middle ? 1 : 0) - vPrism) * (1 - Math.exp(-10 * dt));

    // Joined hands act as one: the figure hangs above the point between them.
    if (lead) {
      lastAnchor = joined
        ? { x: (lead.x + tool.x) / 2, y: (lead.y + tool.y) / 2, size: (lead.size + tool.size) / 2 }
        : { x: lead.x, y: lead.y, size: lead.size };
    }
    const a = lead || flight ? lastAnchor : null;

    if (a) {
      radius += (a.size * CFG.radius - radius) * (1 - Math.exp(-10 * dt));
      // Target: above the hand, with a small orbit and bob so it never sits dead still.
      const rest = {
        x: a.x + Math.cos(t * 1.7) * a.size * 0.12,
        y: a.y - a.size * CFG.hover + Math.sin(t * 2.3) * a.size * 0.08,
      };
      if (visibility < 0.05 && !flight) {
        pos.x = rest.x;
        pos.y = rest.y;
        vel.x = vel.y = 0;
        pop = 0.3;
      }
      visibility += (1 - visibility) * (1 - Math.exp(-8 * dt));

      if (flight) {
        if (fly(tool, rest, dt) === 'caught' && tool) {
          // The receiving hand leads now, the thrower becomes the tool.
          sim.swapHands();
          [lead, tool] = [tool, lead];
          [input.lead, input.tool] = [lead, tool];
          // Keep the shape and the size: they only change once the new hands actually ask for it.
          if (lead) shapeLock = { key: shapeKey, mask: lead.mask };
          scaleHeld = scale;
          scaleEase = 0;
          pulse = Math.max(pulse, 0.35);
          popV += 2.5;
        }
      } else {
        vel.x += (CFG.followK * (rest.x - pos.x) - CFG.followC * vel.x) * dt;
        vel.y += (CFG.followK * (rest.y - pos.y) - CFG.followC * vel.y) * dt;
        pos.x += vel.x * dt;
        pos.y += vel.y * dt;
        const flick =
          lead.fresh &&
          Math.abs(lead.pvx) > Math.max(THROW.minSpeed, lead.size * THROW.speed) &&
          Math.abs(lead.pvx) > Math.abs(lead.pvy) * THROW.ratio;
        // Bringing the hands together fast is joining them, not a throw.
        const close =
          tool && Math.hypot(lead.x - tool.x, lead.y - tool.y) < CFG.portalAt * (lead.size + tool.size) * 0.5;
        if (mode === 'single' && !cooldown && visibility > 0.5 && flick && !close) {
          launch(lead, tool);
        }
      }

      if (lead && !flight) {
        const key = shapeLock
          ? shapeLock.key
          : mode === 'portal'
            ? 'portal'
            : joined
              ? `j${lead.fingers}`
              : middle
                ? 'm'
                : `s${lead.fingers}`;
        if (key !== shapeKey) {
          const first = shapeKey === '';
          shapeKey = key;
          if (mode === 'single' && !middle && !shapeLock) figure.setSides(lead.fingers);
          if (!first && mode !== 'portal') {
            pulse = 1;
            popV += 5;
            omega.y += 5;
          }
        }
      }
    } else {
      vel.y += CFG.gravity * dt;
      pos.x += vel.x * dt;
      pos.y += vel.y * dt;
      visibility *= Math.exp(-4 * dt);
    }

    if (!flight && mode !== 'portal') {
      handSpin(lead, dt);
      handSpin(tool, dt);
    }
    if (mode === 'single' && tool?.fresh && !flight) {
      const goal = CFG.scaleMin + (CFG.scaleMax - CFG.scaleMin) * tool.open;
      scaleEase = Math.min(1, scaleEase + dt / 0.8);
      scaleTarget = scaleHeld + (goal - scaleHeld) * smoothstep(0, 1, scaleEase);
      // Trackball: fast finger flicks drag the surface, slow return strokes barely touch it.
      const steady = 1 - smoothstep(1, 2.5, Math.abs(tool.openRate));
      const r = Math.max(40, radius * scale);
      // Not right after a landing: the hand that just threw is still moving and must not spin the figure.
      const wSwipe = cooldown ? 0 : smoothstep(150, 900, Math.hypot(tool.vx, tool.vy)) * steady;
      const kSwipe = 1 - Math.exp(-14 * wSwipe * dt);
      omega.x += ((tool.vy / r) * CFG.spinGain - omega.x) * kSwipe;
      omega.y += ((tool.vx / r) * CFG.spinGain - omega.y) * kSwipe;
    }
    if (mode !== 'single') scaleTarget = 1;
    scaleV += (320 * (scaleTarget - scale) - 20 * scaleV) * dt;
    scale += scaleV * dt;
    popV += (260 * (1 - pop) - 14 * popV) * dt;
    pop += popV * dt;

    omega.clampLength(0, 21).multiplyScalar(Math.exp(-CFG.spinFriction * dt));
    const angle = omega.length() * dt;
    if (angle > 1e-6) qUser.premultiply(dq.setFromAxisAngle(axis.copy(omega).normalize(), angle)).normalize();
    spinY += CFG.idleSpin * dt;
    qSpin.setFromAxisAngle(Y, spinY);
    // Lean into the motion, like something light being dragged through the air. Smoothed, so a throw
    // (a sudden change of velocity) tilts the figure over a few frames instead of snapping it.
    const kBank = 1 - Math.exp(-10 * dt);
    bank.x += (clamp(vel.y * 0.00045, -0.5, 0.5) - bank.x) * kBank;
    bank.z += (clamp(vel.x * 0.00045, -0.5, 0.5) - bank.z) * kBank;
    qBank.setFromEuler(euler.set(bank.x, 0, bank.z));

    figure.update(dt);
    pulse *= Math.exp(-5 * dt);
  }

  // Read-only view of the state for rendering, the HUD and tests (objects are live references).
  const state = {
    get pos() { return pos; },
    get vel() { return vel; },
    get radius() { return radius; },
    get scale() { return scale; },
    get scaleV() { return scaleV; },
    get scaleTarget() { return scaleTarget; },
    get pop() { return pop; },
    get visibility() { return visibility; },
    get pulse() { return pulse; },
    get shapeKey() { return shapeKey; },
    get shapeLock() { return shapeLock; },
    get mode() { return mode; },
    get vPrism() { return vPrism; },
    get solidKey() { return solidKey; },
    get flight() { return flight; },
    get cooldown() { return cooldown; },
    get middle() { return middle; },
    get lastAnchor() { return lastAnchor; },
    get portalPts() { return portalPts; },
    get portalLevel() { return portalLevel; },
    get spinY() { return spinY; },
    get omega() { return omega; },
    get bank() { return bank; },
    get qUser() { return qUser; },
    get qSpin() { return qSpin; },
    get qBank() { return qBank; },
  };

  const sim = { step, state, swapHands: () => {} };
  return sim;
}
