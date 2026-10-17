-- Same schema as voicecard/db.py; audio lives in R2 under messages.filename.
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
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);
