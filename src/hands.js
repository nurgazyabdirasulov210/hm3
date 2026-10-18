import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { createTracker, toScreen } from './tracker.js';

/**
 * Starts hand tracking on the video. Returns read(now) -> { lead, tool, hands } and swap().
 * The gesture measurements and the lead / tool bookkeeping live in tracker.js; this file only feeds it frames.
 */
export async function startTracking(video, view) {
  const base = import.meta.env.BASE_URL;
  const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  const tracker = createTracker(view, (lm) => toScreen(lm, view, video.videoWidth, video.videoHeight));

  const onFrame = () => {
    const now = performance.now();
    if (video.videoWidth) tracker.process(landmarker.detectForVideo(video, now), now);
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);

  return { read: tracker.read, swap: tracker.swap };
}
