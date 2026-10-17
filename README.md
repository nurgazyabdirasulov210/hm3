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

## Tuning

- `CFG` in `src/main.js` — follow spring, hover height, scale range, spin, blur.
- Constants at the top of `src/hands.js` — gesture thresholds.
