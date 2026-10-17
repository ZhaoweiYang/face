import os
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# `app.py` builds a module-level app on import; keep it out of the real data dir.
os.environ.setdefault("VOICECARD_DATA_DIR", tempfile.mkdtemp(prefix="voicecard-import-"))

from fastapi.testclient import TestClient  # noqa: E402

from app import Config, create_app  # noqa: E402
from security import hash_token, new_token  # noqa: E402

HEADERS = {"X-Requested-With": "voicecard"}

# Smallest byte strings the server's sniffer accepts as each format.
WEBM = b"\x1aE\xdf\xa3" + b"\x00" * 64
M4A = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 64


@pytest.fixture
def app(tmp_path):
    return create_app(Config(data_dir=tmp_path, secure_cookie=False, transcode="off", max_messages=3))


def make_client(app) -> TestClient:
    client = TestClient(app)
    client.headers.update(HEADERS)
    return client


@pytest.fixture
def client(app):
    return make_client(app)


@pytest.fixture
def other(app):
    return make_client(app)


@pytest.fixture
def card(app) -> str:
    token = new_token()
    app.state.db.create_card(hash_token(token), "test")
    return token


def register(client: TestClient, name: str, password: str = "password123") -> None:
    res = client.post("/api/auth/register", json={"username": name, "password": password})
    assert res.status_code == 200, res.text
