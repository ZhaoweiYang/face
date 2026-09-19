// Thin wrapper around MediaPipe Face Landmarker (runs fully in the browser).
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { Landmark } from "./faceModel";

const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");
const WASM_PATH = `${BASE}mediapipe/wasm`;
const MODEL_PATH = `${BASE}models/face_landmarker.task`;

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

async function create(delegate: "GPU" | "CPU"): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: "IMAGE",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

/** Loads (once) the landmarker, trying the GPU delegate first. */
export function getLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = create("GPU").catch((err) => {
      console.warn("GPU delegate failed, falling back to CPU", err);
      return create("CPU");
    });
    landmarkerPromise.catch(() => {
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

/** Returns the landmarks of the most prominent face, or null if none found. */
export async function detectFace(image: HTMLCanvasElement | HTMLImageElement): Promise<Landmark[] | null> {
  const lm = await getLandmarker();
  const result = lm.detect(image);
  const face = result.faceLandmarks?.[0];
  if (!face || face.length === 0) return null;
  return face.map((p) => ({ x: p.x, y: p.y, z: p.z }));
}
