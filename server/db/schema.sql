-- SYNCBEAT PostgreSQL schema (applied automatically on startup when DATABASE_URL is set).
-- Live state (connected devices, playback position) is intentionally NOT stored here;
-- it lives in server memory and is rebuilt from clients on reconnect.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id            VARCHAR(8) PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name    TEXT NOT NULL,
  password_hash TEXT,
  locked        BOOLEAN NOT NULL DEFAULT FALSE,
  lead_ms       INTEGER NOT NULL DEFAULT 2000,
  master_volume REAL NOT NULL DEFAULT 1,
  repeat_mode   TEXT NOT NULL DEFAULT 'off' CHECK (repeat_mode IN ('off','all','one')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rooms_owner_idx ON rooms(owner_id);

CREATE TABLE IF NOT EXISTS tracks (
  id          UUID PRIMARY KEY,
  room_id     VARCHAR(8) NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  url         TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('upload','url')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracks_room_idx ON tracks(room_id, position);
