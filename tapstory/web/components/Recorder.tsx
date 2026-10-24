// Records a message with the phone's microphone (no file upload, by design).

import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, fmtClock } from "../ui";

type Phase = "idle" | "recording" | "recorded" | "sending";

function pickMimeType(): string {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  // AAC/mp4 plays everywhere (iOS records it; recent Chrome can too); else Opus/webm.
  return ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function extFor(type: string): string {
  return type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
}

export function Recorder({ maxSeconds, maxBytes, onSend }: { maxSeconds: number; maxBytes: number; onSend: (blob: Blob, filename: string, seconds: number) => Promise<void> }) {
  const supported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && !!window.MediaRecorder;
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const blob = useRef<Blob | null>(null);
  const timer = useRef(0);
  const startedAt = useRef(0);

  useEffect(
    () => () => {
      clearInterval(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
      if (preview) URL.revokeObjectURL(preview);
    },
    [],
  );

  async function start() {
    setError(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("无法使用麦克风。请在浏览器设置里允许访问麦克风后再试。");
      return;
    }
    const mimeType = pickMimeType();
    const r = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      blob.current = new Blob(chunks, { type: r.mimeType || mimeType || "audio/webm" });
      setPreview(URL.createObjectURL(blob.current));
      setPhase("recorded");
    };
    r.start(1000);
    rec.current = r;
    startedAt.current = performance.now();
    setSeconds(0);
    setPhase("recording");
    timer.current = window.setInterval(() => {
      const s = (performance.now() - startedAt.current) / 1000;
      setSeconds(s);
      if (s >= maxSeconds) stop();
    }, 200);
  }

  function stop() {
    clearInterval(timer.current);
    setSeconds((performance.now() - startedAt.current) / 1000);
    if (rec.current && rec.current.state !== "inactive") rec.current.stop();
  }

  function reset() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    blob.current = null;
    setSeconds(0);
    setPhase("idle");
  }

  async function send() {
    const b = blob.current;
    if (!b) return;
    if (b.size > maxBytes) {
      setError("录音太长了，请录短一点");
      return;
    }
    setPhase("sending");
    try {
      await onSend(b, `voice.${extFor(b.type)}`, Math.round(seconds * 10) / 10);
    } catch (err) {
      setError((err as Error).message);
      setPhase("recorded");
    }
  }

  if (!supported) {
    return (
      <p class="notice">
        {window.isSecureContext ? "这个浏览器不能录音。请用手机自带的 Safari（iPhone）或 Chrome（安卓）打开这张卡片。" : "录音需要 HTTPS 安全连接，请通过卡片上的网址打开。"}
      </p>
    );
  }

  return (
    <div class="recorder" data-phase={phase}>
      <div class="rec-clock" aria-live="polite">
        {fmtClock(seconds)}
        <span class="muted"> / {fmtClock(maxSeconds)}</span>
      </div>
      {phase === "idle" || phase === "recording" ? (
        <>
          <button type="button" class="rec-btn" onClick={phase === "recording" ? stop : start} aria-label={phase === "recording" ? "停止录音" : "开始录音"}>
            {phase === "recording" ? <span class="rec-stop" /> : <Icon name="mic" />}
          </button>
          <p class="muted center">{phase === "recording" ? "正在录音，点一下结束" : "点一下开始录音"}</p>
        </>
      ) : (
        <>
          <audio class="rec-preview" controls src={preview ?? undefined} />
          <div class="row">
            <button type="button" class="btn" onClick={reset} disabled={phase === "sending"}>
              重录
            </button>
            <button type="button" class="btn btn-primary" onClick={send} disabled={phase === "sending"}>
              {phase === "sending" ? "发送中…" : "发送留言"}
            </button>
          </div>
        </>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}
