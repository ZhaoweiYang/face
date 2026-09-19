"""Rendering engines that turn one portrait into pre-rendered expression clips.

Two engines:

* :class:`LivePortraitEngine` – real neural re-animation using KwaiVGI/LivePortrait
  (needs a CUDA GPU and the LivePortrait checkout + weights).
* :class:`MockEngine` – a trivial CPU stand-in that just nudges the photo. It
  exists so the web service and the front-end can be exercised without a GPU.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol

import imageio.v2 as imageio
import numpy as np
from PIL import Image

from motions import FPS, NEUTRAL, Params, expand


@dataclass
class Source:
    """Everything an engine needs to render frames of one portrait."""

    data: Any
    width: int
    height: int


class Engine(Protocol):
    name: str

    def prepare(self, image_path: Path) -> Source: ...

    def render(self, source: Source, params: Params) -> np.ndarray:
        """Returns an RGB uint8 frame at the source image size."""
        ...


def _resolve(params: Params, source_eye: float, source_lip: float) -> Dict[str, float]:
    """Replaces the None / (a, b, u) sentinels with concrete numbers."""
    out: Dict[str, float] = {}
    for key, value in params.items():
        default = source_eye if key == "eye" else source_lip if key == "lip" else NEUTRAL[key] or 0.0
        if value is None:
            out[key] = default
        elif isinstance(value, tuple):
            a, b, u = value
            a = default if a is None else a
            b = default if b is None else b
            out[key] = a + (b - a) * u
        else:
            out[key] = float(value)
    return out


# --------------------------------------------------------------------------- #
# Mock engine                                                                 #
# --------------------------------------------------------------------------- #


class MockEngine:
    """Fakes animation with simple 2D image nudges. Development only."""

    name = "mock"

    def prepare(self, image_path: Path) -> Source:
        img = Image.open(image_path).convert("RGB")
        img.thumbnail((1024, 1024))
        return Source(data=np.asarray(img), width=img.width, height=img.height)

    def render(self, source: Source, params: Params) -> np.ndarray:
        p = _resolve(params, source_eye=0.3, source_lip=0.05)
        img: np.ndarray = source.data
        h, w = img.shape[:2]
        # Head turn -> horizontal shift, mouth open -> slight vertical stretch,
        # blink -> darken. Enough to see that clips differ.
        dx = int(round(-p["yaw"] * w * 0.004))
        out = np.roll(img, dx, axis=1)
        eye_closed = 1.0 - min(1.0, p["eye"] / 0.3)
        if eye_closed > 0:
            out = (out * (1.0 - 0.35 * eye_closed)).astype(np.uint8)
        mouth = max(0.0, (p["lip"] - 0.05) / 0.5)
        if mouth > 0:
            pil = Image.fromarray(out)
            nh = int(h * (1 + 0.06 * mouth))
            pil = pil.resize((w, nh)).crop((0, 0, w, h))
            out = np.asarray(pil)
        return out


# --------------------------------------------------------------------------- #
# LivePortrait engine                                                         #
# --------------------------------------------------------------------------- #


class LivePortraitEngine:
    """Programmatic image retargeting with LivePortrait.

    Mirrors ``GradioPipeline.execute_image_retargeting`` but prepares the
    source once and then renders many frames, which is what a clip needs.
    """

    name = "liveportrait"

    def __init__(self, repo_dir: str, device_id: int = 0, half_precision: bool = True, scale: float = 2.3):
        repo = Path(repo_dir).resolve()
        if not (repo / "src" / "gradio_pipeline.py").exists():
            raise RuntimeError(f"LivePortrait checkout not found at {repo}")
        os.chdir(repo)  # LivePortrait resolves its pretrained weights relative to the cwd
        sys.path.insert(0, str(repo))
        import torch  # noqa: F401  (import check)
        from src.config.argument_config import ArgumentConfig
        from src.config.crop_config import CropConfig
        from src.config.inference_config import InferenceConfig
        from src.gradio_pipeline import GradioPipeline
        from src.utils.camera import get_rotation_matrix
        from src.utils.crop import paste_back
        from src.utils.retargeting_utils import calc_eye_close_ratio, calc_lip_close_ratio

        def partial_fields(target_class, kwargs):
            return target_class(**{k: v for k, v in kwargs.items() if hasattr(target_class, k)})

        args = ArgumentConfig(device_id=device_id, flag_use_half_precision=half_precision, scale=scale)
        self.args = args
        self.pipeline = GradioPipeline(
            inference_cfg=partial_fields(InferenceConfig, args.__dict__),
            crop_cfg=partial_fields(CropConfig, args.__dict__),
            args=args,
        )
        self._torch = torch
        self._get_rotation_matrix = get_rotation_matrix
        self._paste_back = paste_back
        self._calc_eye = calc_eye_close_ratio
        self._calc_lip = calc_lip_close_ratio

    def prepare(self, image_path: Path) -> Source:
        (f_s, x_s, R_s, _R_d, x_s_info, lmk, crop_M_c2o, mask_ori, img_rgb) = self.pipeline.prepare_retargeting_image(
            str(image_path), 0.0, 0.0, 0.0, self.args.scale, flag_do_crop=True
        )
        source_eye = float(self._calc_eye(lmk[None]).mean())
        source_lip = float(self._calc_lip(lmk[None])[0][0])
        data = {
            "f_s": f_s,
            "x_s": x_s,
            "R_s": R_s,
            "x_s_info": x_s_info,
            "lmk": lmk,
            "crop_M_c2o": crop_M_c2o,
            "mask_ori": mask_ori,
            "img_rgb": img_rgb,
            "source_eye": source_eye,
            "source_lip": source_lip,
        }
        return Source(data=data, width=img_rgb.shape[1], height=img_rgb.shape[0])

    def render(self, source: Source, params: Params) -> np.ndarray:
        torch = self._torch
        pipe = self.pipeline
        wrapper = pipe.live_portrait_wrapper
        device = wrapper.device
        d = source.data
        p = _resolve(params, d["source_eye"], d["source_lip"])
        with torch.no_grad():
            x_s_info = d["x_s_info"]
            x_s = d["x_s"].to(device)
            f_s = d["f_s"].to(device)
            R_s = d["R_s"].to(device)
            R_d = self._get_rotation_matrix(
                x_s_info["pitch"] + p["pitch"], x_s_info["yaw"] + p["yaw"], x_s_info["roll"] + p["roll"]
            ).to(device)
            x_c_s = x_s_info["kp"].to(device)
            delta_new = x_s_info["exp"].clone().to(device)
            scale_new = x_s_info["scale"].to(device)
            t_new = x_s_info["t"].to(device)
            R_d_new = (R_d @ R_s.permute(0, 2, 1)) @ R_s

            t = lambda v: torch.tensor(v).to(device)  # noqa: E731
            if p["gaze_x"] != 0 or p["gaze_y"] != 0:
                delta_new = pipe.update_delta_new_eyeball_direction(t(p["gaze_x"]), t(p["gaze_y"]), delta_new)
            if p["smile"] != 0:
                delta_new = pipe.update_delta_new_smile(t(p["smile"]), delta_new)
            if p["eyebrow"] != 0:
                delta_new = pipe.update_delta_new_eyebrow(t(p["eyebrow"]), delta_new)
            if p["pout"] != 0:
                delta_new = pipe.update_delta_new_lip_variation_zero(t(p["pout"]), delta_new)
            if p["purse"] != 0:
                delta_new = pipe.update_delta_new_lip_variation_one(t(p["purse"]), delta_new)
            if p["grin"] != 0:
                delta_new = pipe.update_delta_new_lip_variation_two(t(p["grin"]), delta_new)
            if p["lip_open"] != 0:
                delta_new = pipe.update_delta_new_lip_variation_three(t(p["lip_open"]), delta_new)
            if p["mov_x"] != 0:
                delta_new = pipe.update_delta_new_mov_x(t(-p["mov_x"]), delta_new)
            if p["mov_y"] != 0:
                delta_new = pipe.update_delta_new_mov_y(t(p["mov_y"]), delta_new)

            x_d_new = t(p["mov_z"]) * scale_new * (x_c_s @ R_d_new + delta_new) + t_new
            if abs(p["eye"] - d["source_eye"]) > 1e-4:
                ratio = wrapper.calc_combined_eye_ratio([[float(p["eye"])]], d["lmk"])
                x_d_new = x_d_new + wrapper.retarget_eye(x_s, ratio)
            if abs(p["lip"] - d["source_lip"]) > 1e-4:
                ratio = wrapper.calc_combined_lip_ratio([[float(p["lip"])]], d["lmk"])
                x_d_new = x_d_new + wrapper.retarget_lip(x_s, ratio)
            x_d_new = wrapper.stitching(x_s, x_d_new)
            out = wrapper.warp_decode(f_s, x_s, x_d_new)
            out = wrapper.parse_output(out["out"])[0]
            return self._paste_back(out, d["crop_M_c2o"], d["img_rgb"], d["mask_ori"])


# --------------------------------------------------------------------------- #
# Clip rendering                                                              #
# --------------------------------------------------------------------------- #


def _even(img: np.ndarray) -> np.ndarray:
    """H.264 needs even dimensions."""
    h, w = img.shape[:2]
    return img[: h - (h % 2), : w - (w % 2)]


# Output container/codec. H.264 mp4 plays everywhere; VP9 webm is used by the
# tests because the open-source Chromium build has no H.264 decoder.
CODEC = os.environ.get("FACE3D_CODEC", "h264").lower()
CLIP_EXT = ".webm" if CODEC == "vp9" else ".mp4"


def render_clip(engine: Engine, source: Source, keyframes, out_path: Path, fps: int = FPS,
                progress: Optional[callable] = None) -> None:
    frames = expand(keyframes, fps)
    if CODEC == "vp9":
        writer = imageio.get_writer(str(out_path), fps=fps, codec="libvpx-vp9", quality=8, pixelformat="yuv420p",
                                    macro_block_size=1, output_params=["-b:v", "0", "-crf", "30", "-row-mt", "1"])
    else:
        writer = imageio.get_writer(
            str(out_path), fps=fps, codec="libx264", quality=8, pixelformat="yuv420p", macro_block_size=1
        )
    try:
        for i, params in enumerate(frames):
            writer.append_data(_even(engine.render(source, params)))
            if progress:
                progress(i + 1, len(frames))
    finally:
        writer.close()


def render_still(engine: Engine, source: Source, out_path: Path) -> None:
    frame = engine.render(source, {**NEUTRAL})
    Image.fromarray(_even(frame)).save(out_path, quality=92)


def make_engine(kind: str) -> Engine:
    if kind == "mock":
        return MockEngine()
    if kind == "liveportrait":
        return LivePortraitEngine(
            repo_dir=os.environ.get("LIVEPORTRAIT_DIR", "LivePortrait"),
            device_id=int(os.environ.get("FACE3D_GPU", "0")),
            half_precision=os.environ.get("FACE3D_HALF", "1") != "0",
            scale=float(os.environ.get("FACE3D_CROP_SCALE", "2.3")),
        )
    raise ValueError(f"unknown engine {kind!r} (expected 'liveportrait' or 'mock')")


__all__: List[str] = ["Engine", "Source", "MockEngine", "LivePortraitEngine", "render_clip", "render_still", "make_engine", "CLIP_EXT"]
