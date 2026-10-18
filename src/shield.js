import { createLayer, createFrame, drawDesign, spellState, stepSpell, SHIELD_DESIGN } from './spells.js';
import { rimSparks, penSparks, crumbleSparks } from './sparks.js';

/**
 * The Shield of the Seraphim: a dense flat mandala disc facing the camera over the lead palm.
 * shield: null or { x, y, r, angle, vis } (screen px, angle in screen coords with y down, 0..1).
 * It draws itself in when it appears and crumbles into embers when it goes.
 */
export function createShield(scene, sparks) {
  const layer = createLayer(scene, 2200, { order: 12 });
  const f = createFrame();
  const st = spellState();
  const last = { x: 0, y: 0, r: 0, angle: 0 };
  const stats = { segs: 0 };

  function update(shield, dt, t) {
    const on = !!shield && shield.vis > 0.35 && (st.on || shield.vis > 0.5);
    if (shield) Object.assign(last, { x: shield.x, y: shield.y, r: shield.r, angle: shield.angle });
    stepSpell(st, on, 3, dt);
    layer.begin();
    stats.segs = 0;
    if (st.fade <= 0) {
      layer.end();
      return;
    }
    // Screen y points down, so a positive (clockwise on screen) angle turns the u axis toward +y.
    const c = Math.cos(last.angle);
    const s = Math.sin(last.angle);
    f.cx = last.x;
    f.cy = last.y;
    f.ax = c;
    f.ay = s;
    f.bx = -s;
    f.by = c;
    // Sweeps open from a slightly smaller disc.
    f.r = last.r * (0.85 + 0.15 * st.draw);
    f.pen.on = false;
    const gain = 0.75 + 0.25 * Math.min(1, shield?.vis ?? 0);
    drawDesign(layer, f, SHIELD_DESIGN, st, t, gain);
    if (sparks) {
      if (st.on) {
        rimSparks(sparks, f, 1.0, SHIELD_DESIGN.sparks * st.draw, dt, 1, SHIELD_DESIGN.spark);
        if (st.draw < 1) penSparks(sparks, f, 70, dt);
      } else crumbleSparks(sparks, layer, 0, layer.n, f.cx, f.cy, f.r * 1.3, 380 * st.fade, dt);
    }
    stats.segs = layer.n;
    layer.end(1);
  }

  return { update, resize: layer.resize, stats };
}
