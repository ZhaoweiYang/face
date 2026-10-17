from pathlib import Path

from fastapi.testclient import TestClient

from conftest import HEADERS, M4A, WEBM, make_client, register
from security import hash_token, new_token


def upload(client: TestClient, token: str, data: bytes = M4A, duration: str = "3.2"):
    return client.post(
        f"/api/cards/{token}/messages",
        files={"audio": ("voice.m4a", data, "audio/mp4")},
        data={"duration": duration},
    )


# --- anti-crawling ---------------------------------------------------------


def test_page_is_identical_for_valid_and_invalid_tokens(client, card):
    good = client.get(f"/c/{card}")
    bad = client.get(f"/c/{new_token()}")
    assert good.status_code == bad.status_code == 200
    assert good.content == bad.content
    for res in (good, bad):
        assert "noindex" in res.headers["x-robots-tag"]
        assert res.headers["referrer-policy"] == "no-referrer"
        assert res.headers["cache-control"] == "no-store"


def test_robots_disallows_everything(client):
    res = client.get("/robots.txt")
    assert "Disallow: /" in res.text


def test_api_docs_are_not_exposed(client):
    for path in ("/docs", "/openapi.json", "/redoc"):
        assert client.get(path).status_code == 404


def test_unknown_and_malformed_tokens_look_the_same(client):
    a = client.get(f"/api/cards/{new_token()}")
    b = client.get("/api/cards/1")
    assert a.status_code == b.status_code == 404
    assert a.json() == b.json()


def test_token_guessing_is_rate_limited(client, card):
    for _ in range(20):
        assert client.get(f"/api/cards/{new_token()}").status_code == 404
    assert client.get(f"/api/cards/{new_token()}").status_code == 429
    # Once blocked, even a valid token is refused, so the scanner learns nothing.
    assert client.get(f"/api/cards/{card}").status_code == 429


def test_state_changes_require_csrf_header(app, card):
    bare = TestClient(app)
    res = bare.post("/api/auth/register", json={"username": "alice", "password": "password123"})
    assert res.status_code == 403


# --- auth --------------------------------------------------------------------


def test_register_login_logout(client):
    register(client, "alice")
    assert client.get("/api/auth/me").json() == {"username": "alice"}
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").json() == {"username": None}
    res = client.post("/api/auth/login", json={"username": "alice", "password": "wrong-password"})
    assert res.status_code == 401
    res = client.post("/api/auth/login", json={"username": "ALICE", "password": "password123"})
    assert res.status_code == 200
    assert client.get("/api/auth/me").json() == {"username": "alice"}


def test_duplicate_username_rejected(client, other):
    register(client, "alice")
    res = other.post("/api/auth/register", json={"username": "Alice", "password": "password123"})
    assert res.status_code == 409


def test_session_cookie_is_httponly(client):
    res = client.post("/api/auth/register", json={"username": "alice", "password": "password123"})
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_login_bruteforce_is_rate_limited(client):
    register(client, "alice")
    for _ in range(10):
        client.post("/api/auth/login", json={"username": "alice", "password": "nope-nope"})
    res = client.post("/api/auth/login", json={"username": "alice", "password": "password123"})
    assert res.status_code == 429


# --- claiming ------------------------------------------------------------------


def test_anonymous_cannot_claim(client, card):
    assert client.post(f"/api/cards/{card}/claim").status_code == 401
    assert client.get(f"/api/cards/{card}").json()["claimed"] is False


def test_first_signed_in_user_claims_and_second_cannot(client, other, card):
    register(client, "alice")
    register(other, "bob")
    assert client.post(f"/api/cards/{card}/claim").json() == {"claimed": True, "already": False}
    assert client.post(f"/api/cards/{card}/claim").json() == {"claimed": True, "already": True}
    assert other.post(f"/api/cards/{card}/claim").status_code == 409

    info = other.get(f"/api/cards/{card}").json()
    assert info["claimed"] is True and info["is_owner"] is False and info["owner"] == "alice"
    assert client.get(f"/api/cards/{card}").json()["is_owner"] is True


# --- messages ------------------------------------------------------------------


def test_only_owner_can_upload_and_everyone_can_listen(app, client, other, card):
    register(client, "alice")
    client.post(f"/api/cards/{card}/claim")

    res = upload(client, card)
    assert res.status_code == 200, res.text
    msg = res.json()
    assert msg["mime"] == "audio/mp4" and msg["duration"] == 3.2

    register(other, "bob")
    assert upload(other, card).status_code == 403

    anon = make_client(app)
    assert upload(anon, card).status_code == 401
    listing = anon.get(f"/api/cards/{card}").json()
    assert [m["id"] for m in listing["messages"]] == [msg["id"]]
    audio = anon.get(msg["url"])
    assert audio.status_code == 200
    assert audio.content == M4A
    assert audio.headers["content-type"] == "audio/mp4"


def test_audio_supports_range_requests(client, card):
    register(client, "alice")
    client.post(f"/api/cards/{card}/claim")
    url = upload(client, card, WEBM).json()["url"]
    res = client.get(url, headers={"Range": "bytes=0-3"})
    assert res.status_code == 206
    assert res.content == WEBM[:4]


def test_audio_needs_the_right_card_token(app, client, card):
    register(client, "alice")
    client.post(f"/api/cards/{card}/claim")
    msg_id = upload(client, card).json()["id"]

    second = new_token()
    app.state.db.create_card(hash_token(second))
    assert client.get(f"/api/cards/{second}/messages/{msg_id}/audio").status_code == 404


def test_rejects_non_audio(client, card):
    register(client, "alice")
    client.post(f"/api/cards/{card}/claim")
    res = upload(client, card, b"<html><script>alert(1)</script>")
    assert res.status_code == 415


def test_message_limit_and_delete(client, card):
    register(client, "alice")
    client.post(f"/api/cards/{card}/claim")
    ids = [upload(client, card).json()["id"] for _ in range(3)]
    assert upload(client, card).status_code == 409

    url = f"/api/cards/{card}/messages/{ids[0]}"
    assert client.delete(url).status_code == 200
    assert client.get(f"{url}/audio").status_code == 404
    assert upload(client, card).status_code == 200


def test_non_owner_cannot_delete_or_rename(client, other, card):
    register(client, "alice")
    client.post(f"/api/cards/{card}/claim")
    msg_id = upload(client, card).json()["id"]
    register(other, "bob")
    assert other.delete(f"/api/cards/{card}/messages/{msg_id}").status_code == 403
    assert other.patch(f"/api/cards/{card}", json={"title": "mine"}).status_code == 403

    assert client.patch(f"/api/cards/{card}", json={"title": "  外婆的生日  "}).json() == {"title": "外婆的生日"}
    assert other.get(f"/api/cards/{card}").json()["title"] == "外婆的生日"


def test_revoked_card_is_gone(app, client, card):
    row = app.state.db.card_by_token_hash(hash_token(card))
    app.state.db.revoke_card(row["id"])
    assert client.get(f"/api/cards/{card}").status_code == 404


def test_csrf_header_constant_matches_frontend():
    js = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text()
    name, value = next(iter(HEADERS.items()))
    assert f'"{name}": "{value}"' in js
