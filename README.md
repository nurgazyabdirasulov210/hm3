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

## Modes

- **Middle finger only** (lead hand): the figure turns into a blocky wireframe fist with one raised finger.
- **Both hands brought together**: a different set of solids, chosen by the number of raised fingers on the lead hand — 0 sphere, 1 tetrahedron, 2 octahedron, 3 icosahedron, 4 dodecahedron, 5 torus.
- **Joined, then pulled slightly apart**: a flat square portal. Its corners are the thumb and index fingertips of each hand (two corners per hand). The other raised fingers (middle, ring, pinky, both hands summed, 0–6) add layers to the Doctor Strange style mandala: rings, rune ticks, hexagram, octagram, rotating outer arcs.
- Bring the hands back together to return to the solids; drop a hand to return to the single-hand mode.

## Throwing

Flick the lead hand fast sideways and the figure flies off in that direction, spinning.
- If your other hand is on that side, the figure flies to it and settles above it. That hand becomes the lead, the thrower becomes the tool (scale), and you can throw it back. The figure keeps its shape until the new lead hand changes gesture.
- If there is no hand to catch it, it flies out, bounces off the screen edge and comes back to the hand it was thrown from.

## Tuning

- `CFG` in `src/main.js` — follow spring, hover height, scale range, spin, blur, the join / portal distances, and `THROW` (flick sensitivity, flight and catch springs).
- Constants at the top of `src/hands.js` — gesture thresholds.
