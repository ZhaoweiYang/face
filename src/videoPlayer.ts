// Plays pre-rendered expression clips over a neutral still image.
// Every clip starts and ends at the neutral pose, so a clip can simply be
// faded in over the still and hidden again when it ends.

import { absolute, type Job } from "./api";

export class VideoPlayer {
  private still: HTMLImageElement;
  private videos = new Map<string, HTMLVideoElement>();
  private current: HTMLVideoElement | null = null;
  private queue: string[] = [];
  private token = 0;
  onIdle: (() => void) | null = null;
  onClipStart: ((name: string) => void) | null = null;

  constructor(private container: HTMLElement) {
    this.still = document.createElement("img");
    this.still.className = "media-still";
    this.still.alt = "";
    container.appendChild(this.still);
  }

  get ready(): boolean {
    return this.videos.size > 0;
  }

  /** Loads the still and preloads every clip. Resolves when metadata is in. */
  async load(job: Job): Promise<void> {
    this.clear();
    const stillUrl = absolute(job.neutral ?? "");
    await new Promise<void>((resolve, reject) => {
      this.still.onload = () => resolve();
      this.still.onerror = () => reject(new Error("无法加载中性帧"));
      this.still.src = stillUrl;
    });
    const loads: Promise<void>[] = [];
    for (const [name, url] of Object.entries(job.clips ?? {})) {
      const v = document.createElement("video");
      v.className = "media-clip";
      v.muted = true;
      v.playsInline = true;
      v.preload = "auto";
      v.src = absolute(url);
      v.dataset.name = name;
      this.container.appendChild(v);
      this.videos.set(name, v);
      loads.push(
        new Promise<void>((resolve) => {
          const done = () => resolve();
          v.addEventListener("loadeddata", done, { once: true });
          v.addEventListener("error", done, { once: true });
          setTimeout(done, 8000);
        }),
      );
    }
    await Promise.all(loads);
  }

  has(name: string): boolean {
    return this.videos.has(name);
  }

  /** Plays one clip (interrupting whatever is playing). */
  play(name: string): Promise<void> {
    this.queue = [];
    return this.playSequence([name]);
  }

  /** Plays clips back to back. Resolves when the last one ends. */
  async playSequence(names: string[]): Promise<void> {
    const token = ++this.token;
    this.stopCurrent();
    this.queue = names.filter((n) => this.videos.has(n));
    while (this.queue.length && token === this.token) {
      const name = this.queue.shift()!;
      await this.playOne(name, token);
    }
    if (token === this.token) this.onIdle?.();
  }

  /** Appends clips to the running sequence (or starts one). */
  enqueue(names: string[]): Promise<void> {
    if (this.current) {
      this.queue.push(...names.filter((n) => this.videos.has(n)));
      return Promise.resolve();
    }
    return this.playSequence(names);
  }

  private playOne(name: string, token: number): Promise<void> {
    const v = this.videos.get(name);
    if (!v) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        v.removeEventListener("ended", finish);
        v.removeEventListener("error", finish);
        if (this.current === v) {
          v.classList.remove("playing");
          v.pause();
          v.currentTime = 0;
          this.current = null;
        }
        resolve();
      };
      if (token !== this.token) return resolve();
      this.current = v;
      v.currentTime = 0;
      v.classList.add("playing");
      v.addEventListener("ended", finish);
      v.addEventListener("error", finish);
      this.onClipStart?.(name);
      v.play().catch(() => finish());
    });
  }

  stop(): void {
    this.token++;
    this.queue = [];
    this.stopCurrent();
    this.onIdle?.();
  }

  private stopCurrent(): void {
    if (this.current) {
      this.current.pause();
      this.current.currentTime = 0;
      this.current.classList.remove("playing");
      this.current = null;
    }
  }

  clear(): void {
    this.stop();
    for (const v of this.videos.values()) {
      v.removeAttribute("src");
      v.load();
      v.remove();
    }
    this.videos.clear();
  }
}
