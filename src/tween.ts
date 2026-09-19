// Minimal tween helper for expression parameters.

export type Easing = (t: number) => number;
export const easeInOut: Easing = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOut: Easing = (t) => 1 - Math.pow(1 - t, 3);

interface Active {
  key: string;
  from: number;
  to: number;
  start: number;
  duration: number;
  easing: Easing;
  resolve: () => void;
}

export class Tweener<T extends { [K in keyof T]: number }> {
  private active = new Map<string, Active>();
  constructor(
    public state: T,
    private onChange: () => void,
  ) {}

  /** Animates state[key] to `to` over `duration` ms; resolves when finished. */
  to(key: keyof T & string, to: number, duration: number, easing: Easing = easeInOut): Promise<void> {
    return new Promise((resolve) => {
      const prev = this.active.get(key);
      prev?.resolve();
      if (duration <= 0) {
        this.state[key] = to as T[typeof key];
        this.active.delete(key);
        this.onChange();
        resolve();
        return;
      }
      this.active.set(key, {
        key,
        from: this.state[key],
        to,
        start: performance.now(),
        duration,
        easing,
        resolve,
      });
      this.schedule();
    });
  }

  set(key: keyof T & string, value: number): void {
    this.active.get(key)?.resolve();
    this.active.delete(key);
    this.state[key] = value as T[typeof key];
    this.onChange();
  }

  private raf = 0;
  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.step();
    });
  }

  private step(): void {
    const now = performance.now();
    for (const [key, a] of this.active) {
      const t = Math.min(1, (now - a.start) / a.duration);
      this.state[key as keyof T] = (a.from + (a.to - a.from) * a.easing(t)) as T[keyof T];
      if (t >= 1) {
        this.active.delete(key);
        a.resolve();
      }
    }
    this.onChange();
    if (this.active.size > 0) this.schedule();
  }
}
