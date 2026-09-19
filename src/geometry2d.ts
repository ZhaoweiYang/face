// Small 2D helpers used when building and deforming the face mesh.

export interface Pt {
  x: number;
  y: number;
}

/** Ray/segment intersection parameter t along ray (o + t*d), or null. */
function raySegment(o: Pt, d: Pt, a: Pt, b: Pt): number | null {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const den = d.x * ey - d.y * ex;
  if (Math.abs(den) < 1e-12) return null;
  const ox = a.x - o.x;
  const oy = a.y - o.y;
  const t = (ox * ey - oy * ex) / den;
  const s = (ox * d.y - oy * d.x) / den;
  if (t >= 0 && s >= 0 && s <= 1) return t;
  return null;
}

/** Nearest intersection distance of a ray with a closed polygon, or null. */
export function rayPolygon(o: Pt, d: Pt, poly: Pt[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const t = raySegment(o, d, poly[i], poly[(i + 1) % poly.length]);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** Even-odd point-in-polygon. */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const crosses = a.y > p.y !== b.y > p.y;
    if (crosses && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Triangulates the band between two closed loops that both surround `center`
 * (both must be star-shaped w.r.t. `center`). Returns index triples.
 */
export function stitchRings(
  inner: number[],
  outer: number[],
  pos: (i: number) => Pt,
  center: Pt,
): number[] {
  const ang = (i: number) => Math.atan2(pos(i).y - center.y, pos(i).x - center.x);
  const sortByAngle = (ids: number[]) => [...ids].sort((a, b) => ang(a) - ang(b));
  const A = sortByAngle(inner);
  const B = sortByAngle(outer);
  const angA = A.map(ang);
  const angB = B.map(ang);
  // Start both loops at the smallest angle; walk around, always advancing the
  // loop whose next vertex has the smaller angle (unwrapped).
  const tris: number[] = [];
  let i = 0;
  let j = 0;
  const nextAngle = (angles: number[], k: number) =>
    k + 1 < angles.length ? angles[k + 1] : angles[0] + Math.PI * 2;
  while (i < A.length || j < B.length) {
    const na = i < A.length ? nextAngle(angA, i) : Infinity;
    const nb = j < B.length ? nextAngle(angB, j) : Infinity;
    const ai = A[i % A.length];
    const bj = B[j % B.length];
    if (na <= nb) {
      tris.push(ai, A[(i + 1) % A.length], bj);
      i++;
    } else {
      tris.push(ai, B[(j + 1) % B.length], bj);
      j++;
    }
  }
  return tris;
}

/** Piecewise-linear function y(x) through points sorted by x, clamped at the ends. */
export class Polyline {
  private xs: number[];
  private ys: number[];
  constructor(points: Pt[]) {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    this.xs = sorted.map((p) => p.x);
    this.ys = sorted.map((p) => p.y);
  }
  get minX() {
    return this.xs[0];
  }
  get maxX() {
    return this.xs[this.xs.length - 1];
  }
  at(x: number): number {
    const xs = this.xs;
    const ys = this.ys;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
