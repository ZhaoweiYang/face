"""Face3D clip service.

POST /api/animate       upload a portrait -> job id (cached by image hash)
GET  /api/jobs/{id}     job status, progress, and clip URLs when ready
GET  /api/clips/{id}/…  the rendered mp4 clips and neutral still
GET  /api/health        engine name

Run:  FACE3D_ENGINE=liveportrait LIVEPORTRAIT_DIR=/opt/LivePortrait uvicorn app:app --host 0.0.0.0 --port 8000
Dev:  FACE3D_ENGINE=mock uvicorn app:app --reload
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import threading
import time
import traceback
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from animator import CLIP_EXT, Engine, make_engine, render_clip, render_still
from motions import ALL_CLIPS

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FACE3D_DATA_DIR", ROOT / "data")).resolve()
ENGINE_KIND = os.environ.get("FACE3D_ENGINE", "mock")
FRONTEND_DIR = Path(os.environ.get("FACE3D_FRONTEND_DIR", ROOT.parent / "dist")).resolve()
MAX_UPLOAD = 20 * 1024 * 1024

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Face3D clip service")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_engine: Optional[Engine] = None
_engine_error: Optional[str] = None
_jobs: Dict[str, dict] = {}
_jobs_lock = threading.Lock()
_queue: "queue.Queue[str]" = queue.Queue()


def _job_dir(job_id: str) -> Path:
    return DATA_DIR / job_id


def _manifest_path(job_id: str) -> Path:
    return _job_dir(job_id) / "manifest.json"


def _public(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


def _save(job: dict) -> None:
    _manifest_path(job["id"]).write_text(json.dumps(_public(job), ensure_ascii=False, indent=2))


def _load_cached(job_id: str) -> Optional[dict]:
    path = _manifest_path(job_id)
    if path.exists():
        try:
            job = json.loads(path.read_text())
            if job.get("status") == "done":
                return job
        except json.JSONDecodeError:
            pass
    return None


def _worker() -> None:
    global _engine, _engine_error
    try:
        _engine = make_engine(ENGINE_KIND)
    except Exception as exc:  # noqa: BLE001
        _engine_error = f"{type(exc).__name__}: {exc}"
        traceback.print_exc()
        return
    while True:
        job_id = _queue.get()
        with _jobs_lock:
            job = _jobs.get(job_id)
        if not job:
            continue
        try:
            _run_job(job)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="error", error=f"{type(exc).__name__}: {exc}")
            _save(job)


def _run_job(job: dict) -> None:
    assert _engine is not None
    job_dir = _job_dir(job["id"])
    job.update(status="running", progress=0.0, current="prepare")
    source = _engine.prepare(job_dir / "source.jpg")
    render_still(_engine, source, job_dir / "neutral.jpg")
    names = list(ALL_CLIPS)
    total = len(names)
    clips: Dict[str, str] = {}
    for n, name in enumerate(names):
        job.update(current=name)

        def progress(i: int, count: int, n=n) -> None:
            job["progress"] = round((n + i / count) / total, 3)

        out = job_dir / f"{name}{CLIP_EXT}"
        render_clip(_engine, source, ALL_CLIPS[name], out, progress=progress)
        clips[name] = f"/api/clips/{job['id']}/{name}{CLIP_EXT}"
    job.update(
        status="done",
        progress=1.0,
        current=None,
        neutral=f"/api/clips/{job['id']}/neutral.jpg",
        clips=clips,
        width=source.width,
        height=source.height,
        finished_at=time.time(),
    )
    _save(job)


threading.Thread(target=_worker, name="face3d-worker", daemon=True).start()


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": _engine is not None,
        "engine": _engine.name if _engine else None,
        "error": _engine_error,
        "clips": list(ALL_CLIPS),
    }


@app.post("/api/animate")
async def animate(image: UploadFile = File(...)) -> dict:
    raw = await image.read()
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "图片超过 20 MB")
    job_id = hashlib.sha256(raw + f"{ENGINE_KIND}:{CLIP_EXT}".encode()).hexdigest()[:24]
    cached = _load_cached(job_id)
    if cached:
        with _jobs_lock:
            _jobs[job_id] = cached
        return {"job_id": job_id, "status": "done", "cached": True}
    with _jobs_lock:
        existing = _jobs.get(job_id)
        if existing and existing["status"] in ("queued", "running"):
            return {"job_id": job_id, "status": existing["status"]}
        job_dir = _job_dir(job_id)
        job_dir.mkdir(parents=True, exist_ok=True)
        try:
            img = Image.open(__import__("io").BytesIO(raw)).convert("RGB")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"无法读取图片：{exc}") from exc
        img.thumbnail((1600, 1600))
        img.save(job_dir / "source.jpg", quality=95)
        job = {"id": job_id, "status": "queued", "progress": 0.0, "engine": ENGINE_KIND, "created_at": time.time()}
        _jobs[job_id] = job
        _save(job)
    _queue.put(job_id)
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    with _jobs_lock:
        job = _jobs.get(job_id)
    if not job:
        job = _load_cached(job_id)
        if not job:
            raise HTTPException(404, "job not found")
    out = _public(job)
    if _engine_error and job.get("status") == "queued":
        out["status"] = "error"
        out["error"] = f"渲染引擎不可用：{_engine_error}"
    return out


@app.get("/api/clips/{job_id}/{name}")
def clip(job_id: str, name: str) -> FileResponse:
    if "/" in job_id or ".." in job_id or "/" in name or ".." in name:
        raise HTTPException(400, "bad path")
    path = _job_dir(job_id) / name
    if not path.exists() or not name.endswith((".mp4", ".webm", ".jpg")):
        raise HTTPException(404, "not found")
    return FileResponse(path)


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
