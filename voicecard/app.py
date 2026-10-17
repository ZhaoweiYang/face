"""VoiceCard: voice messages behind an NFC tag on the back of a photo.

Each NFC tag holds a URL  https://<host>/c/<token>  with a 128-bit random token.
The first signed-in user who opens an unclaimed card becomes its owner and is the
only one who can record or delete messages; everyone else who taps can only listen.

GET    /c/{token}                                  the card page (same HTML for every token)
GET    /api/cards/{token}                          card info + message list
POST   /api/cards/{token}/claim                    first signed-in user claims the card
PATCH  /api/cards/{token}                          owner: set title
POST   /api/cards/{token}/messages                 owner: upload audio (multipart `audio`, `duration`)
DELETE /api/cards/{token}/messages/{id}            owner: delete
GET    /api/cards/{token}/messages/{id}/audio      stream audio (supports Range)
POST   /api/auth/register | /api/auth/login | /api/auth/logout,  GET /api/auth/me

Run:  uvicorn app:app --host 0.0.0.0 --port 8100 --proxy-headers --forwarded-allow-ips=<proxy ip>
Mint cards:  python cli.py mint -n 20 --base-url https://voice.example.com
"""

from __future__ import annotations

import math
import os
import secrets
import shutil
import sqlite3
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Tuple

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel

from db import Database
from security import (
    DUMMY_PASSWORD_HASH,
    MIN_PASSWORD,
    TOKEN_RE,
    USERNAME_RE,
    RateLimiter,
    Rule,
    hash_password,
    hash_token,
    new_token,
    verify_password,
)

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
SESSION_COOKIE = "vc_session"
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "voicecard"

# Unknown or malformed card tokens per IP: a scanner gets ~20 guesses per 10 min
# against a 2^128 space, i.e. nothing.
MISS_RULE = Rule(20, 600)
API_RULE = Rule(300, 60)
LOGIN_FAIL_RULE = Rule(10, 600)
REGISTER_RULE = Rule(10, 3600)
UPLOAD_RULE = Rule(60, 3600)

SECURITY_HEADERS = {
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    ),
}

ROBOTS_TXT = "User-agent: *\nDisallow: /\n"


@dataclass
class Config:
    data_dir: Path = field(default_factory=lambda: ROOT / "data")
    secure_cookie: bool = True
    session_days: int = 30
    max_audio_bytes: int = 10 * 1024 * 1024
    max_seconds: int = 180
    max_messages: int = 50
    # "auto": convert webm/ogg recordings to AAC (.m4a) when ffmpeg is installed so
    # older iPhones can play recordings made on Android.
    transcode: str = "auto"

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        return cls(
            data_dir=Path(env("VOICECARD_DATA_DIR", str(ROOT / "data"))).resolve(),
            secure_cookie=env("VOICECARD_SECURE_COOKIE", "1") != "0",
            session_days=int(env("VOICECARD_SESSION_DAYS", "30")),
            max_audio_bytes=int(env("VOICECARD_MAX_AUDIO_MB", "10")) * 1024 * 1024,
            max_seconds=int(env("VOICECARD_MAX_SECONDS", "180")),
            max_messages=int(env("VOICECARD_MAX_MESSAGES", "50")),
            transcode=env("VOICECARD_TRANSCODE", "auto"),
        )


def sniff_audio(head: bytes) -> Optional[Tuple[str, str]]:
    """(mime, extension) from the file's magic bytes; the client's content type is not trusted."""
    if head[:4] == b"\x1aE\xdf\xa3":
        return "audio/webm", "webm"
    if head[:4] == b"OggS":
        return "audio/ogg", "ogg"
    if head[4:8] == b"ftyp":
        return "audio/mp4", "m4a"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav", "wav"
    if head[:3] == b"ID3":
        return "audio/mpeg", "mp3"
    if len(head) > 1 and head[0] == 0xFF:
        if head[1] & 0xF6 == 0xF0:
            return "audio/aac", "aac"
        if head[1] & 0xE0 == 0xE0:
            return "audio/mpeg", "mp3"
    return None


def transcode_to_m4a(src: Path) -> Optional[Path]:
    dst = src.with_suffix(".m4a")
    try:
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
             "-vn", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dst)],
            check=True, timeout=120,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        dst.unlink(missing_ok=True)
        return None
    return dst


class Credentials(BaseModel):
    username: str
    password: str


class TitleUpdate(BaseModel):
    title: str


def create_app(config: Optional[Config] = None) -> FastAPI:
    cfg = config or Config.from_env()
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    audio_dir = cfg.data_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    db = Database(cfg.data_dir / "voicecard.db")
    limiter = RateLimiter()
    can_transcode = cfg.transcode == "on" or (cfg.transcode == "auto" and shutil.which("ffmpeg") is not None)

    app = FastAPI(title="VoiceCard", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db = db
    app.state.config = cfg

    def client_ip(request: Request) -> str:
        # Behind a reverse proxy run uvicorn with --proxy-headers so this is the real client.
        return request.client.host if request.client else "unknown"

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/"):
            if not limiter.allow(f"api:{client_ip(request)}", API_RULE):
                return JSONResponse({"detail": "请求过于频繁，请稍后再试"}, status_code=429)
            # Cross-site pages cannot add a custom header without a CORS preflight,
            # which this server never approves, so this blocks CSRF.
            if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
                return JSONResponse({"detail": "缺少请求头"}, status_code=403)
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    # --- helpers ----------------------------------------------------------

    def current_user(request: Request) -> Optional[sqlite3.Row]:
        token = request.cookies.get(SESSION_COOKIE)
        if not token or len(token) > 64:
            return None
        return db.session_user(hash_token(token))

    def require_user(user: Optional[sqlite3.Row] = Depends(current_user)) -> sqlite3.Row:
        if user is None:
            raise HTTPException(401, "请先登录")
        return user

    def load_card(token: str, request: Request) -> sqlite3.Row:
        """Looks up a card; unknown and malformed tokens look identical and count against the IP."""
        key = f"miss:{client_ip(request)}"
        if limiter.blocked(key, MISS_RULE):
            raise HTTPException(429, "访问过于频繁，请稍后再试")
        card = db.card_by_token_hash(hash_token(token)) if TOKEN_RE.match(token) else None
        if card is None:
            limiter.record(key, MISS_RULE)
            raise HTTPException(404, "卡片不存在")
        return card

    def require_owner(card: sqlite3.Row, user: sqlite3.Row) -> None:
        if card["owner_id"] != user["id"]:
            raise HTTPException(403, "只有卡片主人可以留言")

    def message_out(token: str, row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "duration": row["duration"],
            "size": row["size"],
            "mime": row["mime"],
            "url": f"/api/cards/{token}/messages/{row['id']}/audio",
        }

    def start_session(response: Response, user_id: int) -> None:
        token = new_token()
        ttl = cfg.session_days * 86400
        db.create_session(hash_token(token), user_id, ttl)
        response.set_cookie(
            SESSION_COOKIE, token, max_age=ttl, httponly=True, secure=cfg.secure_cookie, samesite="lax", path="/"
        )

    # --- pages ------------------------------------------------------------

    def page() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", media_type="text/html")

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def index() -> FileResponse:
        return page()

    @app.api_route("/c/{token}", methods=["GET", "HEAD"], include_in_schema=False)
    def card_page(token: str) -> FileResponse:
        # Same response for valid and invalid tokens; validity is only revealed by the
        # rate-limited API, so the page itself is no oracle for scanners.
        return page()

    @app.get("/static/{name}", include_in_schema=False)
    def static(name: str) -> FileResponse:
        path = STATIC_DIR / name
        if "/" in name or name.startswith(".") or not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, headers={"Cache-Control": "public, max-age=3600"})

    @app.get("/robots.txt", include_in_schema=False)
    def robots() -> PlainTextResponse:
        return PlainTextResponse(ROBOTS_TXT, headers={"Cache-Control": "public, max-age=86400"})

    # --- auth -------------------------------------------------------------

    @app.post("/api/auth/register")
    def register(body: Credentials, request: Request, response: Response) -> dict:
        if not limiter.allow(f"register:{client_ip(request)}", REGISTER_RULE):
            raise HTTPException(429, "注册过于频繁，请稍后再试")
        username = body.username.strip()
        if not USERNAME_RE.match(username):
            raise HTTPException(400, "用户名为 2–32 位字母、数字、汉字或 . _ -")
        if len(body.password) < MIN_PASSWORD or len(body.password) > 256:
            raise HTTPException(400, f"密码至少 {MIN_PASSWORD} 位")
        user_id = db.create_user(username, hash_password(body.password))
        if user_id is None:
            raise HTTPException(409, "用户名已被使用")
        start_session(response, user_id)
        return {"username": username}

    @app.post("/api/auth/login")
    def login(body: Credentials, request: Request, response: Response) -> dict:
        key = f"login:{client_ip(request)}"
        if limiter.blocked(key, LOGIN_FAIL_RULE):
            raise HTTPException(429, "尝试次数过多，请 10 分钟后再试")
        user = db.user_by_name(body.username.strip())
        ok = verify_password(body.password, user["password_hash"] if user else DUMMY_PASSWORD_HASH)
        if not user or not ok:
            limiter.record(key, LOGIN_FAIL_RULE)
            raise HTTPException(401, "用户名或密码错误")
        start_session(response, user["id"])
        return {"username": user["username"]}

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response) -> dict:
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            db.delete_session(hash_token(token))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.get("/api/auth/me")
    def me(user: Optional[sqlite3.Row] = Depends(current_user)) -> dict:
        return {"username": user["username"] if user else None}

    # --- cards ------------------------------------------------------------

    @app.get("/api/cards/{token}")
    def get_card(token: str, request: Request, user: Optional[sqlite3.Row] = Depends(current_user)) -> dict:
        card = load_card(token, request)
        is_owner = user is not None and card["owner_id"] == user["id"]
        return {
            "title": card["title"],
            "claimed": card["owner_id"] is not None,
            "owner": card["owner_name"],
            "is_owner": is_owner,
            "me": user["username"] if user else None,
            "messages": [message_out(token, m) for m in db.list_messages(card["id"])],
            "limits": {
                "max_seconds": cfg.max_seconds,
                "max_bytes": cfg.max_audio_bytes,
                "max_messages": cfg.max_messages,
            },
        }

    @app.post("/api/cards/{token}/claim")
    def claim(token: str, request: Request, user: sqlite3.Row = Depends(require_user)) -> dict:
        card = load_card(token, request)
        if card["owner_id"] == user["id"]:
            return {"claimed": True, "already": True}
        if card["owner_id"] is not None or not db.claim_card(card["id"], user["id"]):
            raise HTTPException(409, "这张卡片已经被别人认领了")
        return {"claimed": True, "already": False}

    @app.patch("/api/cards/{token}")
    def update_card(
        token: str, body: TitleUpdate, request: Request, user: sqlite3.Row = Depends(require_user)
    ) -> dict:
        card = load_card(token, request)
        require_owner(card, user)
        title = body.title.strip()[:60]
        db.set_title(card["id"], title)
        return {"title": title}

    @app.post("/api/cards/{token}/messages")
    async def upload(
        token: str,
        request: Request,
        audio: UploadFile = File(...),
        duration: float = Form(0),
        user: sqlite3.Row = Depends(require_user),
    ) -> dict:
        card = load_card(token, request)
        require_owner(card, user)
        if not limiter.allow(f"upload:{user['id']}", UPLOAD_RULE):
            raise HTTPException(429, "上传过于频繁，请稍后再试")
        if db.count_messages(card["id"]) >= cfg.max_messages:
            raise HTTPException(409, f"每张卡片最多 {cfg.max_messages} 条留言，请先删除旧留言")
        raw = await audio.read(cfg.max_audio_bytes + 1)
        if len(raw) > cfg.max_audio_bytes:
            raise HTTPException(413, f"录音超过 {cfg.max_audio_bytes // (1024 * 1024)} MB")
        kind = sniff_audio(raw[:16])
        if kind is None:
            raise HTTPException(415, "不支持的音频格式")
        mime, ext = kind
        msg_id = secrets.token_urlsafe(12)
        path = audio_dir / f"{msg_id}.{ext}"
        path.write_bytes(raw)
        if can_transcode and ext in ("webm", "ogg"):
            converted = transcode_to_m4a(path)
            if converted is not None:
                path.unlink()
                path, mime = converted, "audio/mp4"
        seconds = min(max(duration, 0.0), float(cfg.max_seconds) + 5) if math.isfinite(duration) else 0.0
        db.add_message(msg_id, card["id"], user["id"], path.name, mime, path.stat().st_size, round(seconds, 1))
        row = db.get_message(card["id"], msg_id)
        return message_out(token, row)  # type: ignore[arg-type]

    @app.delete("/api/cards/{token}/messages/{msg_id}")
    def delete_message(token: str, msg_id: str, request: Request, user: sqlite3.Row = Depends(require_user)) -> dict:
        card = load_card(token, request)
        require_owner(card, user)
        row = db.get_message(card["id"], msg_id)
        if row is None:
            raise HTTPException(404, "留言不存在")
        db.delete_message(card["id"], msg_id)
        (audio_dir / row["filename"]).unlink(missing_ok=True)
        return {"ok": True}

    @app.get("/api/cards/{token}/messages/{msg_id}/audio")
    def audio_file(token: str, msg_id: str, request: Request) -> FileResponse:
        card = load_card(token, request)
        row = db.get_message(card["id"], msg_id)
        path = audio_dir / row["filename"] if row else None
        if row is None or path is None or not path.is_file():
            raise HTTPException(404, "留言不存在")
        # FileResponse answers Range requests, which iOS Safari needs to play audio.
        return FileResponse(path, media_type=row["mime"], headers={"Cache-Control": "private, max-age=86400"})

    return app


app = create_app()
