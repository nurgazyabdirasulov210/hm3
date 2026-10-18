# hands-detect-figer-motion

Browser demo: a wireframe figure hovers above your hand and is controlled with gestures.
Runs fully locally — MediaPipe Hand Landmarker + Three.js, no backend.

## Run

```bash
npm install   # also copies the MediaPipe wasm runtime and downloads the hand model into public/
npm run dev
```

Open the printed URL and allow camera access. `/?demo` runs a ~62 s tour of every shape, spell and throw with synthetic hands (no camera needed).

## Controls

- **First hand in frame** is the lead: the figure hovers above it and follows it with a springy lag.
- **Number of raised fingers** sets the shape: 0 — cylinder, 1 — line, 2 — flat frame, 3 — triangular prism, 4 — cube, 5 — pentagonal prism.
- **Special gestures** override the count: 👍 thumb only — stellated dodecahedron (star), 🤙 thumb + pinky — Möbius strip, 🤘 index + pinky — horned crystal, pinky only — diamond.
- **Second hand** is the tool:
  - pinch or close the hand — shrink, open — grow;
  - fast index-finger flick — spin the figure (it keeps spinning by inertia);
  - twist the wrist — roll in the screen plane.
- **Turning either hand turns the figure** (one hand or joined hands): twist it in the screen plane to roll the figure, turn it over (palm ↔ back) to spin the figure around the hand's axis. The figure keeps spinning afterwards and slows down, so a hard turn gives several revolutions.

## Modes

- **Middle finger only** (lead hand): the figure turns into a blocky wireframe fist with one raised finger.
- **🤟 Sorcerer gesture** (thumb + index + pinky up, middle and ring folded): a Doctor Strange *Shield of the Seraphim* appears over the palm and turns with the wrist. The figure hides while it is up and comes back when you drop the gesture; no throws while the shield is up.
- **Both hands brought together** (and held there for a moment, so a throw toward the other hand is not a join): solids chosen by the total raised fingers of both hands (0–10) — 0 sphere, 1 tetrahedron, 2 torus, 3 octahedron, 4 torus knot, 5 icosahedron, 6 double helix, 7 dodecahedron, 8 merkaba, 9 geodesic sphere, 10 tesseract (a 4D hypercube rotating in 4D). Each solid has its own colour.
- **Joined, then pulled slightly apart**: a portal frame whose corners are the thumb and index fingertips of each hand, with a Doctor Strange mandala inside. Spells draw themselves in, cross-fade when the design changes and crumble into sparks when they close.
  - The lead hand's middle / ring / pinky pattern (8 combinations, held 0.15 s) picks the design: 0 sling-ring portal (ring of sparks), 1 Kamar-Taj mandala, 2 seal of squares, 3 hexagram seal, 4 Eye of Agamotto, 5 time loop, 6 Seraphim disc, 7 Vishanti star.
  - The number of raised middle / ring / pinky fingers on the other hand (0–3) sets the level: more layers, brightness and sparks.
- Bring the hands back together to return to the solids; drop a hand to return to the single-hand mode.

## Throwing

Flick the lead hand fast sideways and the figure flies off in that direction, spinning. The flight is a smooth curve with no jumps in position or speed, from launch to landing, and it continues even if the camera briefly loses the hand mid-flick. A hand that has just come into view needs to be tracked for a moment (`THROW.minAge`, 0.2 s) before it can throw, so sweeping a hand into the picture is not a flick.
- If your other hand is on that side, the figure flies to it and settles above it. That hand becomes the lead, the thrower becomes the tool (scale), and you can throw it back. The figure keeps its shape until the new lead hand changes gesture.
- If there is no hand to catch it, it flies out about `THROW.reach` (38%) of the screen width, or to the screen edge if that is closer, turns around and comes back to the hand it was thrown from.

## Tuning

- `CFG` in `src/sim.js` — follow spring, hover height, scale range, spin, blur, the join / portal distances, and `THROW` (flick sensitivity, flight and catch springs).
- `PORTAL_DESIGNS` and `SHIELD_DESIGN` in `src/spells.js` — the spell designs (rings, rune bands, stars, speeds, spark rates); `GRAVITY` / `DRAG` / `STREAK` in `src/sparks.js`.
- Constants at the top of `src/tracker.js` — gesture thresholds, the wrist-speed fit and the smoothing of the gesture rates. They are in milliseconds, not camera frames, so the gestures feel the same with a 15, 30 or 60 fps camera.

## Tests

```bash
npm test
```

Runs the gesture / physics logic in Node (`node:test`, no camera, no browser): `test/synth.js` generates MediaPipe-shaped
hand landmarks, `src/tracker.js` turns them into hands, `src/sim.js` moves the figure. Scenarios cover throws, rotation,
modes and tracking identity, plus regressions (window resize, landmark glitches, frames lost to motion blur, hands
lost and found again); the key ones also run with the camera at 15 and 60 fps. Known-failing scenarios are marked `todo`.
