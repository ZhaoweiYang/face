"""Keyframe definitions for every pre-rendered clip.

A clip is a list of ``(time_seconds, params)`` keyframes. ``params`` is a
partial dict of :data:`NEUTRAL`; missing keys keep the neutral value. Frames are
produced by ease-in-out interpolation between consecutive keyframes, so every
clip starts and ends at the neutral pose and clips can be chained seamlessly.

Parameter meanings (LivePortrait image-retargeting controls):
  eye        target eyes-open ratio (None = keep the source ratio, 0 = closed)
  lip        target lip-open ratio  (None = keep the source ratio, ~0.5 = open)
  yaw/pitch/roll   relative head rotation in degrees
  gaze_x/gaze_y    eyeball direction (-30..30 / -63..63)
  smile, eyebrow   expression tweaks
  pout, purse, grin, lip_open   lip variations 0..3 from the LivePortrait UI
  mov_x, mov_y, mov_z           translation / zoom
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

Params = Dict[str, Optional[float]]
Keyframe = Tuple[float, Params]

NEUTRAL: Params = {
    "eye": None,
    "lip": None,
    "yaw": 0.0,
    "pitch": 0.0,
    "roll": 0.0,
    "gaze_x": 0.0,
    "gaze_y": 0.0,
    "smile": 0.0,
    "eyebrow": 0.0,
    "pout": 0.0,
    "purse": 0.0,
    "grin": 0.0,
    "lip_open": 0.0,
    "mov_x": 0.0,
    "mov_y": 0.0,
    "mov_z": 1.0,
}

# Sign conventions. "Left" and "right" are from the character's own point of
# view: the character's left is the viewer's right. If a generated clip turns
# the wrong way on your setup, flip these two constants.
YAW_CHARACTER_LEFT = 18.0
GAZE_CHARACTER_LEFT = 22.0

FPS = 25


def _look(direction: float) -> List[Keyframe]:
    yaw = YAW_CHARACTER_LEFT * direction
    gaze = GAZE_CHARACTER_LEFT * direction
    return [
        (0.0, {}),
        (0.45, {"yaw": yaw, "gaze_x": gaze}),
        (1.35, {"yaw": yaw, "gaze_x": gaze}),
        (1.85, {}),
    ]


ACTIONS: Dict[str, List[Keyframe]] = {
    "blink": [
        (0.0, {}),
        (0.12, {"eye": 0.0}),
        (0.2, {"eye": 0.0}),
        (0.36, {}),
        (0.6, {}),
    ],
    "mouth": [
        (0.0, {}),
        (0.35, {"lip": 0.5, "lip_open": 40.0}),
        (1.3, {"lip": 0.5, "lip_open": 40.0}),
        (1.75, {}),
    ],
    "left": _look(1.0),
    "right": _look(-1.0),
}


def _viseme(open_: float, shape: float) -> Params:
    """Maps a (mouth open 0..1, lip shape -1 rounded..+1 spread) pair to params."""
    p: Params = {"lip": 0.06 + 0.5 * open_, "lip_open": 60.0 * open_}
    if shape > 0:
        p["grin"] = 10.0 * shape
        p["smile"] = 0.25 * shape
    elif shape < 0:
        p["purse"] = -14.0 * -shape
        p["pout"] = 0.06 * -shape
    return p


def _digit(seq: List[Tuple[float, float, float]]) -> List[Keyframe]:
    """seq: list of (open, shape, seconds) visemes, played back to back."""
    frames: List[Keyframe] = [(0.0, {})]
    t = 0.08
    for open_, shape, dur in seq:
        frames.append((t, _viseme(open_, shape)))
        t += dur
        frames.append((t, _viseme(open_, shape)))
    frames.append((t + 0.16, {}))
    return frames


# Mandarin digit pronunciations as mouth-shape sequences.
DIGITS: Dict[str, List[Keyframe]] = {
    "0": _digit([(0.3, 0.4, 0.11), (0.35, 0.85, 0.18), (0.12, 0.2, 0.15)]),  # líng
    "1": _digit([(0.22, 1.0, 0.13), (0.28, 1.0, 0.26)]),  # yī
    "2": _digit([(0.6, 0.0, 0.17), (0.4, -0.35, 0.23)]),  # èr
    "3": _digit([(0.18, 0.6, 0.1), (0.8, 0.1, 0.21), (0.15, 0.0, 0.13)]),  # sān
    "4": _digit([(0.18, 0.9, 0.13), (0.3, 0.85, 0.25)]),  # sì
    "5": _digit([(0.3, -1.0, 0.15), (0.36, -0.85, 0.26)]),  # wǔ
    "6": _digit([(0.3, 0.3, 0.1), (0.3, 0.8, 0.13), (0.36, -0.9, 0.22)]),  # liù
    "7": _digit([(0.24, 0.9, 0.14), (0.3, 0.95, 0.25)]),  # qī
    "8": _digit([(0.0, 0.0, 0.09), (0.85, 0.1, 0.3)]),  # bā
    "9": _digit([(0.2, 0.7, 0.1), (0.3, 0.9, 0.13), (0.36, -0.9, 0.22)]),  # jiǔ
}

ALL_CLIPS: Dict[str, List[Keyframe]] = {**ACTIONS, **{f"digit_{d}": kf for d, kf in DIGITS.items()}}


def _ease(t: float) -> float:
    return t * t * (3 - 2 * t)


def expand(keyframes: List[Keyframe], fps: int = FPS) -> List[Params]:
    """Expands keyframes into per-frame parameter dicts."""
    full = [(t, {**NEUTRAL, **p}) for t, p in keyframes]
    end = full[-1][0]
    n = max(1, int(round(end * fps)) + 1)
    frames: List[Params] = []
    k = 0
    for i in range(n):
        t = min(i / fps, end)
        while k + 1 < len(full) - 1 and full[k + 1][0] <= t:
            k += 1
        t0, p0 = full[k]
        t1, p1 = full[min(k + 1, len(full) - 1)]
        u = 0.0 if t1 <= t0 else _ease(max(0.0, min(1.0, (t - t0) / (t1 - t0))))
        frame: Params = {}
        for key in NEUTRAL:
            a, b = p0[key], p1[key]
            if a is None and b is None:
                frame[key] = None
            else:
                # None means "source ratio"; the engine substitutes it, so we
                # carry a sentinel by interpolating against the engine later.
                frame[key] = (a, b, u) if (a is None or b is None) else a + (b - a) * u
        frames.append(frame)
    return frames
