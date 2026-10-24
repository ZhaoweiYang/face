-- TapStory schema. Card and session tokens are stored only as SHA-256 hashes.

CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  email      TEXT UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);

-- One row per login method: google / apple (OIDC subject) or email (the address).
CREATE TABLE identities (
  provider TEXT NOT NULL,
  subject  TEXT NOT NULL,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (provider, subject)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at REAL NOT NULL
);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE email_codes (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  code_hash  TEXT NOT NULL,
  expires_at REAL NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- A family group. plan_until > now means the family plan (多人留言) is active.
CREATE TABLE families (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  plan_until REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

CREATE TABLE family_members (
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  nickname  TEXT NOT NULL DEFAULT '',
  joined_at REAL NOT NULL,
  PRIMARY KEY (family_id, user_id)
);
CREATE INDEX members_by_user ON family_members(user_id);

-- Requests to join a family, sent from a card page by a non-member.
CREATE TABLE applications (
  id         INTEGER PRIMARY KEY,
  family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id    INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  identity   TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at REAL NOT NULL,
  decided_at REAL
);
CREATE INDEX applications_by_family ON applications(family_id, status);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  family_id  INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  expires_at REAL NOT NULL
);

-- One NFC tag. family_id is NULL until a signed-in user activates it.
CREATE TABLE cards (
  id           INTEGER PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  batch        TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL DEFAULT '',
  family_id    INTEGER REFERENCES families(id),
  activated_by INTEGER REFERENCES users(id),
  activated_at REAL,
  revoked      INTEGER NOT NULL DEFAULT 0,
  created_at   REAL NOT NULL
);
CREATE INDEX cards_by_family ON cards(family_id);

CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  r2_key     TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  duration   REAL NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE INDEX messages_by_card ON messages(card_id, created_at);

-- Plan purchases. provider "demo" until a real payment provider is wired in.
CREATE TABLE orders (
  id         INTEGER PRIMARY KEY,
  family_id  INTEGER NOT NULL REFERENCES families(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  period     TEXT NOT NULL CHECK (period IN ('quarter', 'year')),
  amount_fen INTEGER NOT NULL,
  provider   TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at REAL NOT NULL
);
