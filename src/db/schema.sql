-- Applied idempotently on boot. This is bootstrap DDL, not a versioned migration history.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  username TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY,
  name TEXT CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('room', 'dm')),
  created_by UUID NOT NULL REFERENCES users (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id);

CREATE TABLE IF NOT EXISTS dm_pairs (
  user_low UUID NOT NULL REFERENCES users (id),
  user_high UUID NOT NULL REFERENCES users (id),
  room_id UUID NOT NULL UNIQUE REFERENCES rooms (id) ON DELETE CASCADE,
  PRIMARY KEY (user_low, user_high),
  CHECK (user_low < user_high)
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users (id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  client_msg_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_client_msg_idx
  ON messages (room_id, sender_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_room_id_id_idx ON messages (room_id, id);

CREATE TABLE IF NOT EXISTS read_receipts (
  room_id UUID NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
