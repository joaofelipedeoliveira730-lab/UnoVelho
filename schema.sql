CREATE TABLE IF NOT EXISTS profiles (
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(24) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'player' CHECK (role IN ('player','staff','admin')),
  coins BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_permissions (
  user_id BIGINT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bans (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT 'Sem motivo informado',
  expires_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id BIGSERIAL PRIMARY KEY,
  code CHAR(4) NOT NULL UNIQUE,
  owner_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  max_players SMALLINT NOT NULL DEFAULT 4 CHECK (max_players BETWEEN 2 AND 10),
  map_key VARCHAR(64) NOT NULL DEFAULT 'taverna',
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  password_hash TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','playing','frozen','finished')),
  frozen_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_players (
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
  seat SMALLINT NOT NULL,
  spectator BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id),
  UNIQUE (room_id, seat)
);

CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  sender_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  channel VARCHAR(16) NOT NULL DEFAULT 'room' CHECK (channel IN ('global','room','private','admin')),
  recipient_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  body VARCHAR(500) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS maps (
  id BIGSERIAL PRIMARY KEY,
  map_key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS skins (
  id BIGSERIAL PRIMARY KEY,
  skin_key VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  kind VARCHAR(32) NOT NULL DEFAULT 'character',
  price BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory (
  user_id BIGINT REFERENCES profiles(id) ON DELETE CASCADE,
  item_type VARCHAR(32) NOT NULL,
  item_key VARCHAR(64) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  equipped BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, item_type, item_key)
);

CREATE TABLE IF NOT EXISTS customizations (
  user_id BIGINT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transactions (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  reference_key VARCHAR(100),
  created_by BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gifts (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  recipient_id BIGINT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  gift_type VARCHAR(32) NOT NULL,
  item_key VARCHAR(64),
  amount BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  command VARCHAR(64) NOT NULL,
  target_user_id BIGINT REFERENCES profiles(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_settings (
  key VARCHAR(64) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_room_players_user ON room_players(user_id);
CREATE INDEX IF NOT EXISTS idx_games_room ON games(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_global_created ON messages(channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bans_user_active ON bans(user_id, active);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);

INSERT INTO maps (map_key, name, config) VALUES
('taverna', 'Bar Medieval', '{"theme":"medieval","lighting":"torches","table":"wood"}'::jsonb),
('classico', 'Clássico', '{"theme":"classic"}'::jsonb),
('neon', 'Neon', '{"theme":"neon"}'::jsonb),
('praia', 'Praia', '{"theme":"beach"}'::jsonb),
('espaco', 'Espaço', '{"theme":"space"}'::jsonb)
ON CONFLICT (map_key) DO NOTHING;
