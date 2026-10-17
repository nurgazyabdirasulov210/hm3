// Copies the MediaPipe wasm runtime and downloads the hand model into public/,
// so the page runs fully locally after `npm install`.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

cpSync(resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm'), resolve(root, 'public/wasm'), {
  recursive: true,
});

const modelPath = resolve(root, 'public/models/hand_landmarker.task');
if (!existsSync(modelPath)) {
  mkdirSync(dirname(modelPath), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
}
console.log('assets ready: public/wasm, public/models');
