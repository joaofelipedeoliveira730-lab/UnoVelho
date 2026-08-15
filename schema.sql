-- Schema para Uno Velho Matematixa Completo

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'USER',
  coins INT DEFAULT 500,
  xp INT DEFAULT 0,
  level INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  avatar_data JSONB DEFAULT '{"skinColor":"#ffdbac","hairStyle":"short","hairColor":"#000000","eyesColor":"#000000","outfit":"casual","accessory":"none"}'::jsonb,
  wins INT DEFAULT 0,
  matches INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  item_id VARCHAR(100) NOT NULL,
  acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, item_id)
);

CREATE TABLE IF NOT EXISTS shop_items (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL,
  price INT NOT NULL,
  icon VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS player_market (
  id SERIAL PRIMARY KEY,
  seller_id INT REFERENCES users(id) ON DELETE CASCADE,
  item_id VARCHAR(100) NOT NULL,
  price INT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS global_state (
  key VARCHAR(50) PRIMARY KEY,
  value JSONB NOT NULL
);

-- Inserção de itens de exemplo na loja
INSERT INTO shop_items (id, name, category, price, icon) VALUES
  ('hair_mohawk', 'Cabelo Moicano Neon', 'hair', 150, '💈'),
  ('hair_afro', 'Estilo Afro Power', 'hair', 150, '👨‍🦱'),
  ('outfit_tuxedo', 'Terno Elegante', 'outfit', 300, '👔'),
  ('outfit_cyber', 'Jaqueta Cyberpunk', 'outfit', 450, '🧥'),
  ('acc_sunglasses', 'Óculos Escuros VIP', 'accessory', 200, '🕶️'),
  ('acc_gold_chain', 'Corrente de Ouro', 'accessory', 500, '🪙')
ON CONFLICT (id) DO NOTHING;

INSERT INTO global_state (key, value) VALUES ('game_paused', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
