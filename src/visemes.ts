// Mouth-shape keyframes for reading Mandarin digits aloud.
// Each keyframe: [mouth open 0..1, lip shape -1 (rounded) .. +1 (spread), duration ms].

export type Viseme = [open: number, shape: number, ms: number];

export const DIGIT_NAMES: Record<string, string> = {
  "0": "零",
  "1": "一",
  "2": "二",
  "3": "三",
  "4": "四",
  "5": "五",
  "6": "六",
  "7": "七",
  "8": "八",
  "9": "九",
};

export const DIGIT_VISEMES: Record<string, Viseme[]> = {
  // líng: l → i → ng
  "0": [
    [0.3, 0.4, 110],
    [0.35, 0.85, 180],
    [0.12, 0.2, 150],
  ],
  // yī: wide spread, small opening
  "1": [
    [0.22, 1.0, 130],
    [0.28, 1.0, 260],
  ],
  // èr: open, then slight rounding for the retroflex "r"
  "2": [
    [0.6, 0.0, 170],
    [0.4, -0.35, 230],
  ],
  // sān: s → a → n
  "3": [
    [0.18, 0.6, 100],
    [0.8, 0.1, 210],
    [0.15, 0.0, 130],
  ],
  // sì: spread, narrow opening
  "4": [
    [0.18, 0.9, 130],
    [0.3, 0.85, 250],
  ],
  // wǔ: fully rounded
  "5": [
    [0.3, -1.0, 150],
    [0.36, -0.85, 260],
  ],
  // liù: l → i → u
  "6": [
    [0.3, 0.3, 100],
    [0.3, 0.8, 130],
    [0.36, -0.9, 220],
  ],
  // qī: spread
  "7": [
    [0.24, 0.9, 140],
    [0.3, 0.95, 250],
  ],
  // bā: closed lips burst into a wide open "a"
  "8": [
    [0.0, 0.0, 90],
    [0.85, 0.1, 300],
  ],
  // jiǔ: j → i → u
  "9": [
    [0.2, 0.7, 100],
    [0.3, 0.9, 130],
    [0.36, -0.9, 220],
  ],
};

/** Total duration of a digit's mouth animation in ms. */
export function visemeDuration(digit: string): number {
  return (DIGIT_VISEMES[digit] ?? []).reduce((a, k) => a + k[2], 0);
}
