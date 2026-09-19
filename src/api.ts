// Client for the clip-rendering service (server/app.py).

export interface Health {
  ok: boolean;
  engine: string | null;
  error: string | null;
  clips: string[];
}

export interface Job {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  current?: string | null;
  error?: string;
  neutral?: string;
  clips?: Record<string, string>;
  width?: number;
  height?: number;
}

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export async function health(timeoutMs = 4000): Promise<Health | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

export async function submit(image: Blob, filename = "photo.jpg"): Promise<{ job_id: string; status: string }> {
  const form = new FormData();
  form.append("image", image, filename);
  const res = await fetch(`${BASE}/api/animate`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`提交失败 (${res.status}) ${await res.text()}`);
  return res.json();
}

export async function getJob(id: string): Promise<Job> {
  const res = await fetch(`${BASE}/api/jobs/${id}`);
  if (!res.ok) throw new Error(`查询任务失败 (${res.status})`);
  return res.json();
}

/** Polls a job until it finishes. `onProgress` receives each intermediate state. */
export async function waitForJob(
  id: string,
  onProgress: (job: Job) => void,
  signal?: AbortSignal,
  intervalMs = 1500,
): Promise<Job> {
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const job = await getJob(id);
    onProgress(job);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error ?? "生成失败");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function absolute(url: string): string {
  return url.startsWith("http") ? url : `${BASE}${url}`;
}
