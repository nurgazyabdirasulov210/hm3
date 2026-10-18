# hands-detect-figer-motion

Browser demo: a wireframe figure hovers above your hand and is controlled with gestures.
Runs fully locally — MediaPipe Hand Landmarker + Three.js, no backend.

## Run

```bash
npm install   # also copies the MediaPipe wasm runtime and downloads the hand model into public/
npm run dev
```

Open the printed URL and allow camera access. `/?demo` drives the figure with a synthetic hand (no camera needed).

## Controls

- **First hand in frame** is the lead: the figure hovers above it and follows it with a springy lag.
- **Number of raised fingers** sets the shape: 0 — cylinder, 1 — line, 2 — flat frame, 3 — triangular prism, 4 — cube, 5 — pentagonal prism.
- **Second hand** is the tool:
  - pinch or close the hand — shrink, open — grow;
  - fast index-finger flick — spin the figure (it keeps spinning by inertia);
  - twist the wrist — roll in the screen plane.
- **Turning either hand turns the figure** (one hand or joined hands): twist it in the screen plane to roll the figure, turn it over (palm ↔ back) to spin the figure around the hand's axis. The figure keeps spinning afterwards and slows down, so a hard turn gives several revolutions.

## Modes

- **Middle finger only** (lead hand): the figure turns into a blocky wireframe fist with one raised finger.
- **Both hands brought together** (and held there for a moment, so a throw toward the other hand is not a join): a different set of solids, chosen by the number of raised fingers on the lead hand — 0 sphere, 1 tetrahedron, 2 octahedron, 3 icosahedron, 4 dodecahedron, 5 torus.
- **Joined, then pulled slightly apart**: a flat portal frame (a wide rectangle, since the hands are apart). Its corners are the thumb and index fingertips of each hand (two corners per hand). The other raised fingers (middle, ring, pinky, both hands summed, 0–6) add layers to the Doctor Strange style mandala: rings, rune ticks, hexagram, octagram, rotating outer arcs.
- Bring the hands back together to return to the solids; drop a hand to return to the single-hand mode.

## Throwing

Flick the lead hand fast sideways and the figure flies off in that direction, spinning. The flight is a smooth curve with no jumps in position or speed, from launch to landing, and it continues even if the camera briefly loses the hand mid-flick. A hand that has just come into view needs to be tracked for a moment (`THROW.minAge`, 0.2 s) before it can throw, so sweeping a hand into the picture is not a flick.
- If your other hand is on that side, the figure flies to it and settles above it. That hand becomes the lead, the thrower becomes the tool (scale), and you can throw it back. The figure keeps its shape until the new lead hand changes gesture.
- If there is no hand to catch it, it flies out about `THROW.reach` (38%) of the screen width, or to the screen edge if that is closer, turns around and comes back to the hand it was thrown from.

## Tuning

- `CFG` in `src/sim.js` — follow spring, hover height, scale range, spin, blur, the join / portal distances, and `THROW` (flick sensitivity, flight and catch springs).
- Constants at the top of `src/tracker.js` — gesture thresholds, the wrist-speed fit and the smoothing of the gesture rates. They are in milliseconds, not camera frames, so the gestures feel the same with a 15, 30 or 60 fps camera.

## Tests

```bash
npm test
```

Runs the gesture / physics logic in Node (`node:test`, no camera, no browser): `test/synth.js` generates MediaPipe-shaped
hand landmarks, `src/tracker.js` turns them into hands, `src/sim.js` moves the figure. Scenarios cover throws, rotation,
modes and tracking identity, plus regressions (window resize, landmark glitches, frames lost to motion blur, hands
lost and found again); the key ones also run with the camera at 15 and 60 fps. Known-failing scenarios are marked `todo`.
