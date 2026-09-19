import "./style.css";
import { FaceModel, DEFAULT_PARAMS, type ExpressionParams, type Landmark } from "./faceModel";
import { detectFace, getLandmarker } from "./landmarker";
import { Viewer } from "./viewer";
import { Tweener, easeOut } from "./tween";
import { DIGIT_NAMES, DIGIT_VISEMES } from "./visemes";

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
const actSpeak = $<HTMLButtonElement>("act-speak");
const digitsForm = $<HTMLFormElement>("digits-form");
const digitsInput = $<HTMLInputElement>("digits-input");
const slDepth = $<HTMLInputElement>("sl-depth");
const slMouth = $<HTMLInputElement>("sl-mouth");
const slBlink = $<HTMLInputElement>("sl-blink");
const slLook = $<HTMLInputElement>("sl-look");
const slShape = $<HTMLInputElement>("sl-shape");
const outDepth = $<HTMLOutputElement>("out-depth");
const outMouth = $<HTMLOutputElement>("out-mouth");
const outBlink = $<HTMLOutputElement>("out-blink");
const outLook = $<HTMLOutputElement>("out-look");
const outShape = $<HTMLOutputElement>("out-shape");
const ckWire = $<HTMLInputElement>("ck-wire");
const ckSway = $<HTMLInputElement>("ck-sway");
const ckVoice = $<HTMLInputElement>("ck-voice");
const toolbar = $("toolbar");
const btnFullscreen = $<HTMLButtonElement>("btn-fullscreen");
const digitOverlay = $("digit-overlay");

const viewer = new Viewer(stage);
const params: ExpressionParams = { ...DEFAULT_PARAMS };
const tween = new Tweener(params, () => {
  viewer.update(params);
  syncOutputs();
});

const controls = [
  actBlink, actMouth, actLeft, actRight, actDemo, actReset, actSnapshot, actSpeak,
  digitsInput, slDepth, slMouth, slBlink, slLook, slShape,
];

function setEnabled(on: boolean): void {
  for (const c of controls) (c as HTMLButtonElement | HTMLInputElement).disabled = !on;
  toolbar.hidden = !on;
}

function setStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  status.textContent = text;
  status.className = `status ${kind}`.trim();
}

// "Left"/"right" are from the character's own point of view: the character's
// left is the viewer's right, i.e. positive `look` (toward the photo's right).
const LOOK_LEFT = 1;
const LOOK_RIGHT = -1;

function syncOutputs(): void {
  outBlink.value = params.blink.toFixed(2);
  outLook.value = params.look.toFixed(2);
  outDepth.value = params.depth.toFixed(2);
  outMouth.value = params.mouthAmplitude.toFixed(2);
  outShape.value = params.mouthShape.toFixed(2);
  slBlink.value = String(params.blink);
  slLook.value = String(params.look);
  slShape.value = String(params.mouthShape);
  const mouthOn = params.mouth > 0.5 && !speaking;
  const leftOn = params.look * LOOK_LEFT > 0.5;
  const rightOn = params.look * LOOK_RIGHT > 0.5;
  actMouth.classList.toggle("active", mouthOn);
  actLeft.classList.toggle("active", leftOn);
  actRight.classList.toggle("active", rightOn);
  toolbarButton("mouth").classList.toggle("active", mouthOn);
  toolbarButton("left").classList.toggle("active", leftOn);
  toolbarButton("right").classList.toggle("active", rightOn);
}

function toolbarButton(action: string): HTMLButtonElement {
  return toolbar.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
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
    stopSpeaking();
    tween.set("blink", 0);
    tween.set("mouth", 0);
    tween.set("look", 0);
    tween.set("mouthShape", 0);
    viewer.setModel(model, texture, params);
    stageEmpty.hidden = true;
    setEnabled(true);
    syncOutputs();
    setStatus(`已生成 3D 人脸（${landmarks.length} 个特征点）。试试快捷动作，或按数字键让它读数字。`, "ok");
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
  if (e.target instanceof HTMLInputElement) return;
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
  stopSpeaking();
  return tween.to("mouth", params.mouth > 0.5 ? 0 : 1, 260);
}

function look(dir: number): Promise<void> {
  const target = Math.abs(params.look - dir) < 0.05 ? 0 : dir;
  return tween.to("look", target, 380);
}

function reset(): void {
  stopSpeaking();
  tween.to("blink", 0, 200);
  tween.to("mouth", 0, 200);
  tween.to("mouthShape", 0, 200);
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
    await tween.to("look", LOOK_LEFT, 400);
    await wait(500);
    await tween.to("look", LOOK_RIGHT, 600);
    await wait(500);
    await blink();
    await tween.to("look", 0, 400);
    await wait(200);
    await speakDigits("2024");
  } finally {
    demoRunning = false;
    actDemo.textContent = "自动演示";
  }
}

// ---- reading digits aloud ------------------------------------------------------

let speaking = false;
let speakQueue: string[] = [];
let speakToken = 0;

function stopSpeaking(): void {
  speakQueue = [];
  speakToken++;
  speaking = false;
  digitOverlay.hidden = true;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

function speakVoice(text: string): void {
  if (!ckVoice.checked) return;
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 0.95;
    const voice = synth.getVoices().find((v) => /^zh(-|_)?(CN|Hans)?/i.test(v.lang));
    if (voice) u.voice = voice;
    synth.speak(u);
  } catch {
    /* speech is optional */
  }
}

function showDigits(all: string, index: number): void {
  digitOverlay.innerHTML = "";
  for (let i = 0; i < all.length; i++) {
    const el = document.createElement(i === index ? "b" : "span");
    el.textContent = all[i];
    digitOverlay.appendChild(el);
  }
  const name = DIGIT_NAMES[all[index]];
  if (name) digitOverlay.appendChild(document.createTextNode(`  ${name}`));
  digitOverlay.hidden = false;
}

/** Plays the mouth animation (and optional voice) for a string of digits. */
async function speakDigits(text: string): Promise<void> {
  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) return;
  if (speaking) {
    speakQueue.push(digits);
    return;
  }
  speaking = true;
  const token = ++speakToken;
  let all = digits;
  let batch = digits;
  let offset = 0;
  try {
    while (batch && token === speakToken) {
      for (let i = 0; i < batch.length && token === speakToken; i++) {
        const d = batch[i];
        showDigits(all + speakQueue.join(""), offset + i);
        speakVoice(d);
        for (const [open, shape, ms] of DIGIT_VISEMES[d] ?? []) {
          if (token !== speakToken) break;
          await Promise.all([tween.to("mouth", open, ms), tween.to("mouthShape", shape, ms)]);
        }
        if (token !== speakToken) break;
        await Promise.all([tween.to("mouth", 0.05, 120), tween.to("mouthShape", 0, 120)]);
        await new Promise((r) => setTimeout(r, 60));
      }
      offset += batch.length;
      batch = speakQueue.shift() ?? "";
      all += batch;
    }
  } finally {
    if (token === speakToken) {
      speaking = false;
      digitOverlay.hidden = true;
      await Promise.all([tween.to("mouth", 0, 150), tween.to("mouthShape", 0, 150)]);
    }
  }
}

// ---- fullscreen -----------------------------------------------------------------

function isFullscreen(): boolean {
  return document.fullscreenElement === stage || stage.classList.contains("fs-fallback");
}

async function toggleFullscreen(): Promise<void> {
  if (isFullscreen()) {
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }
    stage.classList.remove("fs-fallback");
  } else {
    let ok = false;
    if (stage.requestFullscreen) {
      ok = await stage
        .requestFullscreen()
        .then(() => true)
        .catch(() => false);
    }
    if (!ok) stage.classList.add("fs-fallback");
  }
  updateFullscreenButton();
  viewer.resize();
}

function updateFullscreenButton(): void {
  const on = isFullscreen();
  btnFullscreen.textContent = on ? "✕" : "⛶";
  btnFullscreen.title = on ? "退出全屏 (Esc)" : "全屏 (F)";
}

document.addEventListener("fullscreenchange", () => {
  updateFullscreenButton();
  viewer.resize();
});
btnFullscreen.addEventListener("click", () => void toggleFullscreen());

// ---- wiring -------------------------------------------------------------------------

actBlink.addEventListener("click", () => void blink());
actMouth.addEventListener("click", () => void toggleMouth());
actLeft.addEventListener("click", () => void look(LOOK_LEFT));
actRight.addEventListener("click", () => void look(LOOK_RIGHT));
actReset.addEventListener("click", reset);
actDemo.addEventListener("click", () => void demo());
actSnapshot.addEventListener("click", () => {
  const url = viewer.snapshot();
  const a = document.createElement("a");
  a.href = url;
  a.download = "face3d.png";
  a.click();
});
digitsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  void speakDigits(digitsInput.value);
  digitsInput.select();
});

toolbar.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
  if (!btn) return;
  switch (btn.dataset.action) {
    case "blink":
      void blink();
      break;
    case "mouth":
      void toggleMouth();
      break;
    case "left":
      void look(LOOK_LEFT);
      break;
    case "right":
      void look(LOOK_RIGHT);
      break;
    case "digits": {
      const text = window.prompt("输入要读的数字（0–9）", digitsInput.value || "2024");
      if (text) {
        digitsInput.value = text;
        void speakDigits(text);
      }
      break;
    }
    case "reset":
      reset();
      break;
  }
});

document.addEventListener("keydown", (e) => {
  if (!viewer.hasModel) return;
  const target = e.target as HTMLElement | null;
  const typing = target instanceof HTMLInputElement && target.type === "text";
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape" && stage.classList.contains("fs-fallback")) {
    void toggleFullscreen();
    return;
  }
  if (typing) return;
  if (/^[0-9]$/.test(e.key)) {
    void speakDigits(e.key);
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case "ArrowUp":
      void blink();
      break;
    case "ArrowDown":
      void toggleMouth();
      break;
    case "ArrowLeft":
      void look(LOOK_LEFT);
      break;
    case "ArrowRight":
      void look(LOOK_RIGHT);
      break;
    case "r":
    case "R":
      reset();
      break;
    case "f":
    case "F":
      void toggleFullscreen();
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
slShape.addEventListener("input", () => tween.set("mouthShape", Number(slShape.value)));
ckWire.addEventListener("change", () => viewer.setWireframe(ckWire.checked));
ckSway.addEventListener("change", () => (viewer.autoSway = ckSway.checked));
try {
  // Some browsers load voices lazily; touching the list warms it up.
  window.speechSynthesis?.getVoices();
} catch {
  /* ignore */
}

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
      speakDigits: typeof speakDigits;
      landmarks: () => Landmark[] | null;
    };
  }
}
window.__face3d = { processImage, params, viewer, blink, speakDigits, landmarks: () => lastLandmarks };
