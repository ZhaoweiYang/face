"""Card tokens, password hashing, sessions and rate limiting.

Card URLs are bearer secrets: the only way to reach a card is to already hold its
128-bit random token (written on the NFC tag), so there is nothing to enumerate.
The database stores only SHA-256 hashes of card and session tokens, so a leaked
database does not leak working URLs or logins.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Deque, Dict

# 16 random bytes -> 22 url-safe base64 characters (128 bits of entropy).
TOKEN_BYTES = 16
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")

USERNAME_RE = re.compile(r"^[\w.-]{2,32}$")
MIN_PASSWORD = 8

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        got = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p), dklen=len(digest) // 2
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), digest)


# Verified against when the username does not exist, so a failed login takes the
# same time whether or not the account exists.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(16))


@dataclass(frozen=True)
class Rule:
    limit: int
    window: float  # seconds


class RateLimiter:
    """In-memory sliding-window counters (single process).

    For several workers or machines, swap this for Redis with the same interface.
    """

    def __init__(self) -> None:
        self._hits: Dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def _window(self, key: str, rule: Rule, now: float) -> Deque[float]:
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - rule.window:
            hits.popleft()
        return hits

    def blocked(self, key: str, rule: Rule) -> bool:
        with self._lock:
            return len(self._window(key, rule, time.monotonic())) >= rule.limit

    def record(self, key: str, rule: Rule) -> None:
        with self._lock:
            now = time.monotonic()
            self._window(key, rule, now).append(now)
            if len(self._hits) > 50_000:
                self._hits = {k: v for k, v in self._hits.items() if v and v[-1] > now - 3600}

    def allow(self, key: str, rule: Rule) -> bool:
        """Records a hit and returns whether it is within the limit."""
        with self._lock:
            now = time.monotonic()
            hits = self._window(key, rule, now)
            if len(hits) >= rule.limit:
                return False
            hits.append(now)
            return True
