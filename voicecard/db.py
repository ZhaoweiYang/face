"""SQLite storage for users, sessions, cards and voice messages."""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, List, Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at REAL NOT NULL
);
-- A card is one NFC tag. Only the hash of its URL token is stored.
CREATE TABLE IF NOT EXISTS cards (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  batch      TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  owner_id   INTEGER REFERENCES users(id),
  claimed_at REAL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  duration   REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_card ON messages(card_id, created_at);
"""


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            with conn:  # commit on success, roll back on error
                yield conn
        finally:
            conn.close()

    # --- users & sessions -------------------------------------------------

    def create_user(self, username: str, password_hash: str) -> Optional[int]:
        try:
            with self.connect() as conn:
                cur = conn.execute(
                    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                    (username, password_hash, time.time()),
                )
                return cur.lastrowid
        except sqlite3.IntegrityError:
            return None

    def user_by_name(self, username: str) -> Optional[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()

    def create_session(self, token_hash: str, user_id: int, ttl: float) -> None:
        now = time.time()
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            conn.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                (token_hash, user_id, now + ttl),
            )

    def session_user(self, token_hash: str) -> Optional[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (token_hash, time.time()),
            ).fetchone()

    def delete_session(self, token_hash: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    # --- cards ------------------------------------------------------------

    def create_card(self, token_hash: str, batch: str = "") -> int:
        with self.connect() as conn:
            cur = conn.execute(
                "INSERT INTO cards (token_hash, batch, created_at) VALUES (?, ?, ?)",
                (token_hash, batch, time.time()),
            )
            return cur.lastrowid  # type: ignore[return-value]

    def card_by_token_hash(self, token_hash: str) -> Optional[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT cards.*, users.username AS owner_name FROM cards "
                "LEFT JOIN users ON users.id = cards.owner_id "
                "WHERE cards.token_hash = ? AND cards.revoked = 0",
                (token_hash,),
            ).fetchone()

    def claim_card(self, card_id: int, user_id: int) -> bool:
        """Atomically gives an unclaimed card to `user_id`. False if someone already owns it."""
        with self.connect() as conn:
            cur = conn.execute(
                "UPDATE cards SET owner_id = ?, claimed_at = ? WHERE id = ? AND owner_id IS NULL",
                (user_id, time.time(), card_id),
            )
            return cur.rowcount == 1

    def set_title(self, card_id: int, title: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE cards SET title = ? WHERE id = ?", (title, card_id))

    def list_cards(self) -> List[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT cards.id, cards.batch, cards.title, cards.revoked, cards.created_at, cards.claimed_at, "
                "users.username AS owner_name, "
                "(SELECT COUNT(*) FROM messages WHERE messages.card_id = cards.id) AS messages "
                "FROM cards LEFT JOIN users ON users.id = cards.owner_id ORDER BY cards.id"
            ).fetchall()

    def unclaim_card(self, card_id: int) -> bool:
        with self.connect() as conn:
            cur = conn.execute("UPDATE cards SET owner_id = NULL, claimed_at = NULL WHERE id = ?", (card_id,))
            return cur.rowcount == 1

    def revoke_card(self, card_id: int) -> bool:
        with self.connect() as conn:
            cur = conn.execute("UPDATE cards SET revoked = 1 WHERE id = ?", (card_id,))
            return cur.rowcount == 1

    # --- messages ---------------------------------------------------------

    def list_messages(self, card_id: int) -> List[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT * FROM messages WHERE card_id = ? ORDER BY created_at", (card_id,)
            ).fetchall()

    def count_messages(self, card_id: int) -> int:
        with self.connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM messages WHERE card_id = ?", (card_id,)).fetchone()[0]

    def add_message(
        self, msg_id: str, card_id: int, author_id: int, filename: str, mime: str, size: int, duration: float
    ) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO messages (id, card_id, author_id, filename, mime, size, duration, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (msg_id, card_id, author_id, filename, mime, size, duration, time.time()),
            )

    def get_message(self, card_id: int, msg_id: str) -> Optional[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT * FROM messages WHERE id = ? AND card_id = ?", (msg_id, card_id)
            ).fetchone()

    def delete_message(self, card_id: int, msg_id: str) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM messages WHERE id = ? AND card_id = ?", (msg_id, card_id))
