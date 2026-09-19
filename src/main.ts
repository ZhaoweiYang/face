import "./style.css";
import { FaceModel, DEFAULT_PARAMS, type ExpressionParams, type Landmark } from "./faceModel";
import { detectFace, getLandmarker } from "./landmarker";
import { Viewer } from "./viewer";
import { Tweener, easeOut } from "./tween";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const stage = $("stage");
const stageEmpty = $("stage-empty");
const stageLoading = $("stage-loading");
const stageLoadingText = $("stage-loading-text");
const status = $("status");
const fileInput = $<HTMLInputElement>("file-input");
const dropzone = $("dropzone");
const actBlink = $<HTMLButtonElement>("act-blink");
const actMouth = $<HTMLButtonElement>("act-mouth");
const actLeft = $<HTMLButtonElement>("act-left");
const actRight = $<HTMLButtonElement>("act-right");
const actDemo = $<HTMLButtonElement>("act-demo");
const actReset = $<HTMLButtonElement>("act-reset");
const actSnapshot = $<HTMLButtonElement>("act-snapshot");
const slDepth = $<HTMLInputElement>("sl-depth");
const slMouth = $<HTMLInputElement>("sl-mouth");
const slBlink = $<HTMLInputElement>("sl-blink");
const slLook = $<HTMLInputElement>("sl-look");
const outDepth = $<HTMLOutputElement>("out-depth");
const outMouth = $<HTMLOutputElement>("out-mouth");
const outBlink = $<HTMLOutputElement>("out-blink");
const outLook = $<HTMLOutputElement>("out-look");
const ckWire = $<HTMLInputElement>("ck-wire");
const ckSway = $<HTMLInputElement>("ck-sway");

const viewer = new Viewer(stage);
const params: ExpressionParams = { ...DEFAULT_PARAMS };
const tween = new Tweener(params, () => {
  viewer.update(params);
  syncOutputs();
});

const controls = [actBlink, actMouth, actLeft, actRight, actDemo, actReset, actSnapshot, slDepth, slMouth, slBlink, slLook];

function setEnabled(on: boolean): void {
  for (const c of controls) (c as HTMLButtonElement | HTMLInputElement).disabled = !on;
}

function setStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

function syncOutputs(): void {
  outBlink.value = params.blink.toFixed(2);
  outLook.value = params.look.toFixed(2);
  outDepth.value = params.depth.toFixed(2);
  outMouth.value = params.mouthAmplitude.toFixed(2);
  slBlink.value = String(params.blink);
  slLook.value = String(params.look);
  actMouth.classList.toggle("active", params.mouth > 0.5);
  actLeft.classList.toggle("active", params.look < -0.5);
  actRight.classList.toggle("active", params.look > 0.5);
}

// ---- image loading ------------------------------------------------------------

const MAX_TEXTURE = 2048;
const MAX_DETECT = 1280;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片无法读取"));
    img.src = src;
  });
}

function downscale(img: HTMLImageElement, max: number): HTMLCanvasElement {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

let busy = false;
let lastLandmarks: Landmark[] | null = null;

async function processImage(src: string, label: string): Promise<void> {
  if (busy) return;
  busy = true;
  stageLoading.hidden = false;
  stageLoadingText.textContent = "正在识别人脸…";
  setStatus(`正在处理 ${label}…`);
  try {
    const img = await loadImage(src);
    const detectCanvas = downscale(img, MAX_DETECT);
    const landmarks: Landmark[] | null = await detectFace(detectCanvas);
    if (!landmarks) {
      setStatus("没有检测到人脸，请换一张正面、清晰的人像照片。", "err");
      return;
    }
    stageLoadingText.textContent = "正在构建 3D 网格…";
    const texture = downscale(img, MAX_TEXTURE);
    const model = new FaceModel(landmarks, texture.width / texture.height);
    lastLandmarks = landmarks;
    tween.set("blink", 0);
    tween.set("mouth", 0);
    tween.set("look", 0);
    viewer.setModel(model, texture, params);
    stageEmpty.hidden = true;
    setEnabled(true);
    syncOutputs();
    setStatus(`已生成 3D 人脸（${landmarks.length} 个特征点）。试试右边的快捷动作吧！`, "ok");
  } catch (err) {
    console.error(err);
    setStatus(`处理失败：${(err as Error).message ?? err}`, "err");
  } finally {
    stageLoading.hidden = true;
    busy = false;
  }
}

function handleFile(file: File | undefined | null): void {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("请选择图片文件。", "err");
    return;
  }
  const url = URL.createObjectURL(file);
  processImage(url, file.name).finally(() => URL.revokeObjectURL(url));
}

fileInput.addEventListener("change", () => {
  handleFile(fileInput.files?.[0]);
  fileInput.value = "";
});
for (const ev of ["dragenter", "dragover"]) {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  });
}
for (const ev of ["dragleave", "drop"]) {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag");
  });
}
dropzone.addEventListener("drop", (e) => handleFile((e as DragEvent).dataTransfer?.files?.[0]));
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer?.files?.[0]);
});
document.addEventListener("paste", (e) => {
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
  if (item) handleFile(item.getAsFile());
});

// ---- expression actions ------------------------------------------------------

async function blink(): Promise<void> {
  await tween.to("blink", 1, 110, easeOut);
  await new Promise((r) => setTimeout(r, 70));
  await tween.to("blink", 0, 170);
}

function toggleMouth(): Promise<void> {
  return tween.to("mouth", params.mouth > 0.5 ? 0 : 1, 260);
}

function look(dir: -1 | 1): Promise<void> {
  const target = Math.abs(params.look - dir) < 0.05 ? 0 : dir;
  return tween.to("look", target, 380);
}

function reset(): void {
  tween.to("blink", 0, 200);
  tween.to("mouth", 0, 200);
  tween.to("look", 0, 300);
}

let demoRunning = false;
async function demo(): Promise<void> {
  if (demoRunning) return;
  demoRunning = true;
  actDemo.textContent = "演示中…";
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    reset();
    await wait(350);
    await blink();
    await wait(300);
    await tween.to("mouth", 1, 300);
    await wait(500);
    await tween.to("mouth", 0, 300);
    await wait(300);
    await tween.to("look", -1, 400);
    await wait(500);
    await tween.to("look", 1, 600);
    await wait(500);
    await blink();
    await tween.to("look", 0, 400);
  } finally {
    demoRunning = false;
    actDemo.textContent = "自动演示";
  }
}

actBlink.addEventListener("click", () => void blink());
actMouth.addEventListener("click", () => void toggleMouth());
actLeft.addEventListener("click", () => void look(-1));
actRight.addEventListener("click", () => void look(1));
actReset.addEventListener("click", reset);
actDemo.addEventListener("click", () => void demo());
actSnapshot.addEventListener("click", () => {
  const url = viewer.snapshot();
  const a = document.createElement("a");
  a.href = url;
  a.download = "face3d.png";
  a.click();
});

document.addEventListener("keydown", (e) => {
  if (!viewer.hasModel || e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case "1":
      void blink();
      break;
    case "2":
      void toggleMouth();
      break;
    case "ArrowLeft":
      void look(-1);
      break;
    case "ArrowRight":
      void look(1);
      break;
    case "0":
    case "r":
    case "R":
      reset();
      break;
    default:
      return;
  }
  e.preventDefault();
});

// ---- sliders / toggles -------------------------------------------------------

slDepth.addEventListener("input", () => tween.set("depth", Number(slDepth.value)));
slMouth.addEventListener("input", () => tween.set("mouthAmplitude", Number(slMouth.value)));
slBlink.addEventListener("input", () => tween.set("blink", Number(slBlink.value)));
slLook.addEventListener("input", () => tween.set("look", Number(slLook.value)));
ckWire.addEventListener("change", () => viewer.setWireframe(ckWire.checked));
ckSway.addEventListener("change", () => (viewer.autoSway = ckSway.checked));

// ---- boot --------------------------------------------------------------------

getLandmarker()
  .then(() => setStatus("人脸模型已就绪，请上传照片。", "ok"))
  .catch((err) => {
    console.error(err);
    setStatus("人脸模型加载失败，请刷新重试。", "err");
  });

// Expose for automated testing.
declare global {
  interface Window {
    __face3d?: {
      processImage: typeof processImage;
      params: ExpressionParams;
      viewer: Viewer;
      blink: typeof blink;
      landmarks: () => Landmark[] | null;
    };
  }
}
window.__face3d = { processImage, params, viewer, blink, landmarks: () => lastLandmarks };
