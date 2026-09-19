// Builds a textured 3D face mesh from MediaPipe landmarks and deforms it for
// expressions (blink, mouth open, look left/right) plus head yaw.
//
// Coordinates:
//  - "image units": x in [0, W], y in [0, 1] with y pointing DOWN (W = aspect).
//  - "face frame":  (u, v) = face-aligned 2D coords; u = face right, v = face down.
//  - "world":       Three.js units, X right, Y up, Z toward the camera.

import { TRIANGULATION } from "./triangulation";
import {
  CHIN_BOTTOM,
  EYES,
  FACE_OVAL,
  FOREHEAD_TOP,
  LIPS_INNER,
  LIPS_OUTER,
  MOUTH_LEFT,
  MOUTH_RIGHT,
  NUM_LANDMARKS,
  type EyeIndices,
} from "./landmarks";
import {
  centroid,
  clamp,
  lerp,
  pointInPolygon,
  Polyline,
  rayPolygon,
  smoothstep,
  stitchRings,
  type Pt,
} from "./geometry2d";

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface ExpressionParams {
  /** 0 = eyes open, 1 = eyes closed. */
  blink: number;
  /** 0 = mouth closed, 1 = mouth fully open. */
  mouth: number;
  /** -1 = look to the photo's left, +1 = look right. */
  look: number;
  /** Relief exaggeration multiplier. */
  depth: number;
  /** Max mouth opening as a fraction of face height. */
  mouthAmplitude: number;
  /** How much the head turns along with the gaze (0 = eyes only, 1 = full). */
  headTurn: number;
}

export const DEFAULT_PARAMS: ExpressionParams = {
  blink: 0,
  mouth: 0,
  look: 0,
  depth: 1.4,
  mouthAmplitude: 0.14,
  headTurn: 1,
};

interface EyeRig {
  idx: EyeIndices;
  polygon: Pt[]; // eye contour in face frame
  upper: Polyline;
  lower: Polyline;
  width: number;
  /** Full-blink delta v for vertices above the upper lid (index -> delta). */
  aboveDelta: Map<number, number>;
  irisVerts: number[];
}

interface MouthRig {
  /** Full-open delta v per vertex (index -> delta in face-size units). */
  delta: Map<number, number>;
}

const YAW_MAX = (16 * Math.PI) / 180;
/** Upper inner lip, from the subject's left corner (308) to the right corner (78). */
const UPPER_INNER = [415, 310, 311, 312, 13, 82, 81, 80, 191];
/** Lower inner lip, matched one-to-one with UPPER_INNER. */
const LOWER_INNER = [324, 318, 402, 317, 14, 87, 178, 88, 95];
const CORNER_L = 308;
const CORNER_R = 78;
const IRIS_SHIFT = 0.26; // fraction of eye width at look = ±1
const BORDER_EXTRA_DEPTH = 0.06; // normalized z pushed behind the face oval

export class FaceModel {
  readonly vertexCount: number;
  readonly aspect: number;
  /** Base vertex coords in image units (x, y) and normalized depth z, N*3. */
  readonly base: Float32Array;
  readonly uv: Float32Array;
  readonly faceIndex: number[];
  readonly mouthIndex: number[];
  /** Face-frame basis (in image units). */
  readonly center: Pt;
  readonly right: Pt;
  readonly down: Pt;
  readonly faceSize: number;
  /** Vertices [0, deformCount) move with expressions; the rest is the static border. */
  readonly deformCount: number;
  /** Indices of the "teeth band" bottom vertices (copies of the lower inner lip). */
  readonly teethVerts: number[];

  private eyes: EyeRig[] = [];
  private mouth: MouthRig;
  private work: Float32Array;

  constructor(landmarks: Landmark[], aspect: number) {
    if (landmarks.length < NUM_LANDMARKS) {
      throw new Error(`expected ${NUM_LANDMARKS} landmarks, got ${landmarks.length}`);
    }
    this.aspect = aspect;
    const W = aspect;
    const H = 1;

    // --- landmark vertices ---------------------------------------------------
    const pts: Pt[] = landmarks.map((l) => ({ x: l.x * W, y: l.y * H }));
    const zs: number[] = landmarks.map((l) => l.z);

    // --- face frame -----------------------------------------------------------
    const top = pts[FOREHEAD_TOP];
    const chin = pts[CHIN_BOTTOM];
    const dx = chin.x - top.x;
    const dy = chin.y - top.y;
    this.faceSize = Math.hypot(dx, dy) || 1;
    this.down = { x: dx / this.faceSize, y: dy / this.faceSize };
    this.right = { x: this.down.y, y: -this.down.x };
    this.center = centroid(FACE_OVAL.map((i) => pts[i]));

    // --- eyes: keep iris points inside the eye opening -----------------------
    for (const eye of EYES) {
      const poly = eye.contour.map((i) => pts[i]);
      let c = pts[eye.irisCenter];
      if (!pointInPolygon(c, poly)) c = centroid(poly);
      pts[eye.irisCenter] = c;
      for (const ri of eye.irisRing) {
        const p = pts[ri];
        const d = { x: p.x - c.x, y: p.y - c.y };
        const len = Math.hypot(d.x, d.y) || 1e-6;
        const dir = { x: d.x / len, y: d.y / len };
        const t = rayPolygon(c, dir, poly);
        if (t !== null && (len > t * 0.9 || !pointInPolygon(p, poly))) {
          pts[ri] = { x: c.x + dir.x * t * 0.9, y: c.y + dir.y * t * 0.9 };
        }
      }
    }

    // --- border ring: rays from the face centre out to the image edge ----------
    const borderPts: Pt[] = [];
    for (const i of FACE_OVAL) {
      const p = pts[i];
      const d = { x: p.x - this.center.x, y: p.y - this.center.y };
      const len = Math.hypot(d.x, d.y) || 1e-6;
      const dir = { x: d.x / len, y: d.y / len };
      const rect = [
        { x: 0, y: 0 },
        { x: W, y: 0 },
        { x: W, y: H },
        { x: 0, y: H },
      ];
      const t = rayPolygon(this.center, dir, rect) ?? len;
      borderPts.push({ x: this.center.x + dir.x * t, y: this.center.y + dir.y * t });
    }
    borderPts.push({ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H });
    const borderZ = Math.max(...FACE_OVAL.map((i) => zs[i])) + BORDER_EXTRA_DEPTH;

    // Teeth band: copies of the lower inner lip that stay attached to the upper
    // lip, so opening the mouth reveals a dark cavity below the (photo) teeth.
    const teethPts = LOWER_INNER.map((i) => ({ ...pts[i] }));
    const teethZ = LOWER_INNER.map((i) => zs[i]);
    this.teethVerts = LOWER_INNER.map((_, k) => NUM_LANDMARKS + k);
    this.deformCount = NUM_LANDMARKS + teethPts.length;

    const all: Pt[] = [...pts, ...teethPts, ...borderPts];
    const allZ: number[] = [...zs, ...teethZ, ...borderPts.map(() => borderZ)];
    this.vertexCount = all.length;
    this.base = new Float32Array(this.vertexCount * 3);
    this.uv = new Float32Array(this.vertexCount * 2);
    for (let i = 0; i < this.vertexCount; i++) {
      this.base[i * 3] = all[i].x;
      this.base[i * 3 + 1] = all[i].y;
      this.base[i * 3 + 2] = allZ[i];
      this.uv[i * 2] = all[i].x / W;
      this.uv[i * 2 + 1] = 1 - all[i].y / H;
    }
    this.work = new Float32Array(this.base);

    // --- topology --------------------------------------------------------------
    const faceIndex: number[] = [];
    const mouthIndex: number[] = [];
    const eyeSets = EYES.map((e) => new Set(e.contour));
    const eyePolys = EYES.map((e) => e.contour.map((i) => pts[i]));
    const triCentroid = (a: number, b: number, c: number): Pt => ({
      x: (pts[a].x + pts[b].x + pts[c].x) / 3,
      y: (pts[a].y + pts[b].y + pts[c].y) / 3,
    });
    for (let t = 0; t < TRIANGULATION.length; t += 3) {
      const a = TRIANGULATION[t];
      const b = TRIANGULATION[t + 1];
      const c = TRIANGULATION[t + 2];
      let skip = false;
      for (let e = 0; e < EYES.length; e++) {
        const s = eyeSets[e];
        if (s.has(a) && s.has(b) && s.has(c) && pointInPolygon(triCentroid(a, b, c), eyePolys[e])) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      faceIndex.push(a, b, c);
    }
    const posOf = (i: number): Pt => all[i];
    // Eye interiors: iris fan + band between iris ring and eye contour.
    for (const eye of EYES) {
      const c = pts[eye.irisCenter];
      const ring = eye.irisRing;
      for (let k = 0; k < ring.length; k++) {
        faceIndex.push(eye.irisCenter, ring[k], ring[(k + 1) % ring.length]);
      }
      faceIndex.push(...stitchRings(ring, eye.contour, posOf, c));
    }
    // Mouth: textured teeth band (upper lip -> teeth bottom) on the face mesh,
    // dark cavity band (teeth bottom -> lower lip) on the mouth mesh.
    const T = this.teethVerts;
    for (let k = 0; k + 1 < UPPER_INNER.length; k++) {
      const u0 = UPPER_INNER[k];
      const u1 = UPPER_INNER[k + 1];
      const l0 = LOWER_INNER[k];
      const l1 = LOWER_INNER[k + 1];
      faceIndex.push(u0, T[k], u1, u1, T[k], T[k + 1]);
      mouthIndex.push(T[k], l0, T[k + 1], T[k + 1], l0, l1);
    }
    const last = UPPER_INNER.length - 1;
    faceIndex.push(CORNER_L, UPPER_INNER[0], T[0], CORNER_R, T[last], UPPER_INNER[last]);
    mouthIndex.push(CORNER_L, T[0], LOWER_INNER[0], CORNER_R, LOWER_INNER[last], T[last]);

    // Band between the face oval and the image border.
    const borderIds = borderPts.map((_, k) => this.deformCount + k);
    faceIndex.push(...stitchRings(FACE_OVAL, borderIds, posOf, this.center));

    this.faceIndex = faceIndex;
    this.mouthIndex = mouthIndex;

    // --- expression rigs ----------------------------------------------------------
    this.eyes = EYES.map((e) => this.buildEyeRig(e));
    this.mouth = this.buildMouthRig();
  }

  // ---- face frame helpers ------------------------------------------------------

  toFrame(p: Pt): Pt {
    const x = p.x - this.center.x;
    const y = p.y - this.center.y;
    return { x: x * this.right.x + y * this.right.y, y: x * this.down.x + y * this.down.y };
  }

  private baseFrame(i: number): Pt {
    return this.toFrame({ x: this.base[i * 3], y: this.base[i * 3 + 1] });
  }

  private buildEyeRig(idx: EyeIndices): EyeRig {
    const polygon = idx.contour.map((i) => this.baseFrame(i));
    const upperPts = [...idx.upper, idx.contour[0], idx.contour[8]].map((i) => this.baseFrame(i));
    const lowerPts = [...idx.lower, idx.contour[0], idx.contour[8]].map((i) => this.baseFrame(i));
    const upper = new Polyline(upperPts);
    const lower = new Polyline(lowerPts);
    const width = upper.maxX - upper.minX;
    let height = 0;
    for (const i of idx.upper) {
      const p = this.baseFrame(i);
      height = Math.max(height, lower.at(p.x) - p.y);
    }
    const falloff = Math.max(height * 1.6, width * 0.35);
    const aboveDelta = new Map<number, number>();
    const interior = new Set([...idx.contour, idx.irisCenter, ...idx.irisRing]);
    const margin = width * 0.1;
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      if (interior.has(i)) continue;
      const p = this.baseFrame(i);
      if (p.x < upper.minX - margin || p.x > upper.maxX + margin) continue;
      const up = upper.at(p.x);
      const lo = lower.at(p.x);
      const gap = lo - up;
      if (gap <= 1e-6) continue;
      const d = up - p.y; // distance above the upper lid
      if (d < -1e-6) continue; // inside or below the eye opening
      const w = 1 - smoothstep(0, falloff, d);
      if (w <= 1e-3) continue;
      aboveDelta.set(i, w * gap);
    }
    // Upper lid points themselves land exactly on the lower lid.
    for (let k = 0; k < idx.upper.length; k++) {
      const u = this.baseFrame(idx.upper[k]);
      const l = this.baseFrame(idx.lower[k]);
      aboveDelta.set(idx.upper[k], l.y - u.y);
    }
    return {
      idx,
      polygon,
      upper,
      lower,
      width,
      aboveDelta,
      irisVerts: [idx.irisCenter, ...idx.irisRing],
    };
  }

  private buildMouthRig(): MouthRig {
    const S = this.faceSize;
    const m13 = this.baseFrame(13);
    const m14 = this.baseFrame(14);
    const mid: Pt = { x: (m13.x + m14.x) / 2, y: (m13.y + m14.y) / 2 };
    const halfWidth = Math.abs(this.baseFrame(MOUTH_LEFT).x - this.baseFrame(MOUTH_RIGHT).x) / 2 || S * 0.2;
    const lowerOuter = [146, 91, 181, 84, 17, 314, 405, 321, 375];
    const upperOuter = [409, 270, 269, 267, 0, 37, 39, 40, 185];
    const corners = [CORNER_R, CORNER_L, MOUTH_RIGHT, MOUTH_LEFT];
    const lowerSet = new Set([...LOWER_INNER, ...lowerOuter]);
    const upperSet = new Set([...UPPER_INNER, ...upperOuter, ...this.teethVerts]);
    const cornerSet = new Set(corners);
    const lipSet = new Set([...LIPS_INNER, ...LIPS_OUTER]);
    const delta = new Map<number, number>();
    for (let i = 0; i < this.deformCount; i++) {
      const p = this.baseFrame(i);
      const wh = 1 - smoothstep(1.0, 2.1, Math.abs(p.x - mid.x) / halfWidth);
      if (wh <= 1e-3) continue;
      let wv: number;
      if (lowerSet.has(i)) wv = 1;
      else if (upperSet.has(i)) wv = -0.1; // slight upper-lip lift
      else if (cornerSet.has(i)) wv = 0.45;
      else if (lipSet.has(i)) wv = 0;
      else wv = smoothstep(mid.y - 0.01 * S, mid.y + 0.07 * S, p.y);
      const d = wv * wh;
      if (Math.abs(d) > 1e-4) delta.set(i, d);
    }
    return { delta };
  }

  // ---- deformation ---------------------------------------------------------------

  /**
   * Writes deformed world-space positions (N*3) into `out`.
   */
  computePositions(params: ExpressionParams, out: Float32Array): void {
    const N = this.vertexCount;
    const W = this.aspect;
    const H = 1;
    const S = this.faceSize;
    const work = this.work;
    work.set(this.base);

    // Work in the face frame for the 2D expression deformations.
    const D = this.deformCount;
    const frame = new Float32Array(D * 2);
    for (let i = 0; i < D; i++) {
      const p = this.toFrame({ x: work[i * 3], y: work[i * 3 + 1] });
      frame[i * 2] = p.x;
      frame[i * 2 + 1] = p.y;
    }

    const blink = clamp(params.blink, 0, 1);
    const look = clamp(params.look, -1, 1);
    const mouth = clamp(params.mouth, 0, 1);

    for (const eye of this.eyes) {
      // Iris shift (gaze), kept inside the eye opening.
      if (look !== 0) {
        const shift = look * IRIS_SHIFT * eye.width;
        const c = { x: frame[eye.idx.irisCenter * 2] + shift, y: frame[eye.idx.irisCenter * 2 + 1] };
        if (!pointInPolygon(c, eye.polygon)) {
          // slide the centre back until it is inside
          const dir = { x: -Math.sign(shift), y: 0 };
          const t = rayPolygon(c, dir, eye.polygon);
          if (t !== null) c.x += dir.x * (t + eye.width * 0.02);
        }
        frame[eye.idx.irisCenter * 2] = c.x;
        for (const ri of eye.idx.irisRing) {
          const px = frame[ri * 2] + shift;
          const py = frame[ri * 2 + 1];
          const d = { x: px - c.x, y: py - c.y };
          const len = Math.hypot(d.x, d.y) || 1e-6;
          const dir = { x: d.x / len, y: d.y / len };
          const t = rayPolygon(c, dir, eye.polygon);
          const keep = t !== null ? Math.min(len, t * 0.9) : len;
          frame[ri * 2] = c.x + dir.x * keep;
          frame[ri * 2 + 1] = c.y + dir.y * keep;
        }
      }
      // Blink: upper lid (and skin above it) drops onto the lower lid,
      // everything inside the opening collapses onto the lower lid line.
      if (blink > 0) {
        for (const [i, d] of eye.aboveDelta) frame[i * 2 + 1] += d * blink;
        for (const i of eye.irisVerts) {
          const x = frame[i * 2];
          const y = frame[i * 2 + 1];
          frame[i * 2 + 1] = lerp(y, eye.lower.at(x), blink);
        }
      }
    }

    if (mouth > 0) {
      const amount = mouth * params.mouthAmplitude * S;
      for (const [i, d] of this.mouth.delta) frame[i * 2 + 1] += d * amount;
    }

    // Back to image units.
    for (let i = 0; i < D; i++) {
      const u = frame[i * 2];
      const v = frame[i * 2 + 1];
      work[i * 3] = this.center.x + u * this.right.x + v * this.down.x;
      work[i * 3 + 1] = this.center.y + u * this.right.y + v * this.down.y;
    }

    // Image units -> world.
    const depth = params.depth;
    for (let i = 0; i < N; i++) {
      out[i * 3] = work[i * 3] - W / 2;
      out[i * 3 + 1] = H / 2 - work[i * 3 + 1];
      out[i * 3 + 2] = -work[i * 3 + 2] * W * depth;
    }

    // Head yaw about the face's vertical axis through a point behind the face.
    const theta = look * YAW_MAX * clamp(params.headTurn, 0, 1);
    if (theta !== 0) {
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const cx = this.center.x - W / 2;
      const cy = H / 2 - this.center.y;
      const cz = -0.45 * S;
      // Axis = face "up" direction in world space (x right, y up).
      const ax = -this.down.x;
      const ay = this.down.y;
      for (let i = 0; i < D; i++) {
        const px = out[i * 3] - cx;
        const py = out[i * 3 + 1] - cy;
        const pz = out[i * 3 + 2] - cz;
        // Decompose into the component along the axis and the rest.
        const along = px * ax + py * ay;
        const rx = px - along * ax;
        const ry = py - along * ay;
        // Rotate (r, z) about the axis: r' = cos*r + sin*z*side, z' = -sin*|r|*... use
        // the right vector as the in-plane direction.
        const sx = this.right.x;
        const sy = -this.right.y; // right vector in world (y flipped)
        const r = rx * sx + ry * sy; // signed distance along the face-right direction
        const nr = cos * r + sin * pz;
        const nz = -sin * r + cos * pz;
        out[i * 3] = cx + along * ax + nr * sx;
        out[i * 3 + 1] = cy + along * ay + nr * sy;
        out[i * 3 + 2] = cz + nz;
      }
    }
  }
}
