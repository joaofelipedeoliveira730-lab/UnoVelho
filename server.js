'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || '';
const ADMIN_USERNAME = process.env.ADMIN_INITIAL_USERNAME || 'Velho';
const ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || '';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada.');
if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET deve ter pelo menos 32 caracteres.');
if (ADMIN_PASSWORD.length < 8) throw new Error('ADMIN_INITIAL_PASSWORD deve ter pelo menos 8 caracteres.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

const rooms = new Map();
const online = new Map();
const rate = new Map();

function cleanName(v) { return String(v || '').trim(); }
function cleanText(v, max = 500) { return cleanName(v).slice(0, max); }
function validUsername(v) { return /^[A-Za-z0-9_]{3,24}$/.test(v); }
function validRoomCode(v) { return /^[A-Z0-9]{4}$/.test(v); }
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function sign(user) { return jwt.sign({ sub: String(user.id), role: user.role }, JWT_SECRET, { expiresIn: '7d' }); }
function safeUser(row) { return { id: Number(row.id), username: row.username, role: row.role, coins: Number(row.coins), wins: row.wins, losses: row.losses }; }

async function q(text, params = []) { return pool.query(text, params); }

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(16) DEFAULT 'user',
      coins INT DEFAULT 100,
      wins INT DEFAULT 0,
      losses INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customizations (
      user_id INT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      data JSONB DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS bans (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES profiles(id) ON DELETE CASCADE,
      reason TEXT,
      active BOOLEAN DEFAULT true,
      created_by INT REFERENCES profiles(id),
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code VARCHAR(4) UNIQUE NOT NULL,
      owner_id INT REFERENCES profiles(id),
      max_players INT DEFAULT 4,
      map_key VARCHAR(64) DEFAULT 'taverna',
      status VARCHAR(16) DEFAULT 'waiting',
      rules JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_players (
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES profiles(id) ON DELETE CASCADE,
      seat INT,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      sender_id INT REFERENCES profiles(id),
      channel VARCHAR(16) DEFAULT 'room',
      body TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_actions (
      id SERIAL PRIMARY KEY,
      actor_id INT REFERENCES profiles(id),
      command VARCHAR(64),
      details JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await q(`INSERT INTO profiles (username, password_hash, role) VALUES ($1,$2,'admin')
           ON CONFLICT (username) DO UPDATE SET role='admin'`, [ADMIN_USERNAME, hash]);
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });
    const payload = jwt.verify(token, JWT_SECRET);
    const r = await q('SELECT id, username, role, coins, wins, losses FROM profiles WHERE id=$1', [payload.sub]);
    if (!r.rowCount) return res.status(401).json({ error: 'Sessão inválida.' });
    req.user = r.rows[0];
    next();
  } catch { res.status(401).json({ error: 'Sessão inválida.' }); }
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Sem permissão.' });
}

async function banned(userId) {
  const r = await q(`SELECT 1 FROM bans WHERE user_id=$1 AND active=true AND (expires_at IS NULL OR expires_at>NOW()) LIMIT 1`, [userId]);
  return r.rowCount > 0;
}

function allow(key, limit, windowMs) {
  const now = Date.now();
  const arr = rate.get(key) || [];
  const recent = arr.filter(t => now - t < windowMs);
  recent.push(now); rate.set(key, recent);
  return recent.length <= limit;
}

app.get('/health', async (_req, res) => {
  try { await q('SELECT 1'); res.json({ ok: true, service: 'unovelho' }); }
  catch { res.status(503).json({ ok: false }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const username = cleanName(req.body.username);
    const password = String(req.body.password || '');
    if (!validUsername(username)) return res.status(400).json({ error: 'Usuário inválido.' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Senha inválida.' });
    const hash = await bcrypt.hash(password, 12);
    const r = await q('INSERT INTO profiles (username,password_hash) VALUES ($1,$2) RETURNING id,username,role,coins,wins,losses', [username, hash]);
    await q('INSERT INTO customizations(user_id,data) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, {}]);
    res.status(201).json({ user: safeUser(r.rows[0]), token: sign(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Usuário já existe.' });
    res.status(500).json({ error: 'Erro no cadastro.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = cleanName(req.body.username);
    const password = String(req.body.password || '');
    if (!allow(`login:${req.ip}`, 8, 60000)) return res.status(429).json({ error: 'Muitas tentativas.' });
    const r = await q('SELECT * FROM profiles WHERE username=$1', [username]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'Dados inválidos.' });
    if (await banned(r.rows[0].id)) return res.status(403).json({ error: 'Conta banida.' });
    res.json({ user: safeUser(r.rows[0]), token: sign(r.rows[0]) });
  } catch (e) { res.status(500).json({ error: 'Erro no login.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => res.json({ user: safeUser(req.user) }));
app.get('/api/online', auth, (_req, res) => res.json({ players: [...online.values()].map(x => ({ id: x.id, username: x.username })) }));

// Rota principal renderizando o HTML embutido para dispensar a pasta public
app.get('*', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnoVelho</title>
  <style>
    body { font-family: Arial, sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
    .card { background: #1e1e1e; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); text-align: center; width: 300px; }
    h1 { color: #f39c12; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>UnoVelho</h1>
    <p>Servidor online e operando com sucesso!</p>
  </div>
</body>
</html>`);
});

(async () => {
  await ensureSchema();
  server.listen(PORT, '0.0.0.0', () => console.log(`UnoVelho online na porta ${PORT}`));
})().catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
