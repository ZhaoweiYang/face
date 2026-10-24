// Shared UI pieces.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ComponentChildren; title?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.classList.add("no-scroll");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("no-scroll");
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-grip" aria-hidden="true" />
        {title && <h2 class="sheet-title">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export function Avatar({ name, src, size = 36 }: { name: string; src?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` };
  if (src && !broken) return <img class="avatar" src={src} alt="" style={style} referrerpolicy="no-referrer" onError={() => setBroken(true)} />;
  return (
    <span class="avatar" style={style} aria-hidden="true">
      {[...(name || "?")][0]}
    </span>
  );
}

export function Spinner({ label = "加载中…" }: { label?: string }) {
  return (
    <div class="center muted" role="status">
      <span class="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function PlanBadge({ plan }: { plan: "standard" | "family" }) {
  return <span class={`badge ${plan === "family" ? "badge-family" : ""}`}>{plan === "family" ? "家庭版" : "标准版"}</span>;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds || 0));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDay(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function Icon({ name }: { name: "mic" | "play" | "pause" | "wave" | "back" | "plus" | "share" | "more" }) {
  const paths: Record<string, string> = {
    mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3",
    play: "M8 5v14l11-7z",
    pause: "M7 5h4v14H7zM13 5h4v14h-4z",
    wave: "M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4",
    back: "M15 5l-7 7 7 7",
    plus: "M12 5v14M5 12h14",
    share: "M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5",
    more: "M5 12h.01M12 12h.01M19 12h.01",
  };
  const filled = name === "play" || name === "pause";
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d={paths[name]} />
    </svg>
  );
}
