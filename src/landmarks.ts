// MediaPipe Face Landmarker index constants (478 landmarks: 468 mesh + 10 iris).
// "LEFT"/"RIGHT" follow MediaPipe's convention (the subject's left/right),
// so the subject's left eye appears on the right side of the photo.

export const NUM_FACE_LANDMARKS = 468;
export const NUM_LANDMARKS = 478;

/** Face contour, in loop order. */
export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

export interface EyeIndices {
  /** Eye opening contour, in loop order (corner, lower lid..., corner, upper lid...). */
  contour: number[];
  /** Upper eyelid points ordered from outer corner to inner corner. */
  upper: number[];
  /** Lower eyelid points, matched one-to-one with `upper`. */
  lower: number[];
  /** Iris centre landmark. */
  irisCenter: number;
  /** Iris ring landmarks (4 points). */
  irisRing: number[];
}

/** Subject's right eye (left side of the photo). */
export const RIGHT_EYE: EyeIndices = {
  contour: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  upper: [246, 161, 160, 159, 158, 157, 173],
  lower: [7, 163, 144, 145, 153, 154, 155],
  irisCenter: 468,
  irisRing: [469, 470, 471, 472],
};

/** Subject's left eye (right side of the photo). */
export const LEFT_EYE: EyeIndices = {
  contour: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  upper: [466, 388, 387, 386, 385, 384, 398],
  lower: [249, 390, 373, 374, 380, 381, 382],
  irisCenter: 473,
  irisRing: [474, 475, 476, 477],
};

export const EYES = [RIGHT_EYE, LEFT_EYE];

/** Inner lip contour, in loop order. Triangles inside it form the mouth cavity. */
export const LIPS_INNER = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
];

/** Outer lip contour, in loop order. */
export const LIPS_OUTER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
];

/** Handy single points. */
export const FOREHEAD_TOP = 10;
export const CHIN_BOTTOM = 152;
export const NOSE_TIP = 1;
export const UPPER_LIP_INNER_MID = 13;
export const LOWER_LIP_INNER_MID = 14;
export const MOUTH_LEFT = 291; // subject's left corner (photo right)
export const MOUTH_RIGHT = 61; // subject's right corner (photo left)
export const JAW_LEFT = 454;
export const JAW_RIGHT = 234;
