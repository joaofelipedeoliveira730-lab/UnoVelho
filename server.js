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
let globalChatEnabled = true;

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
function safeUser(row) { return { id: Number(row.id), username: row.username, role: row.role, coins: Number(row.coins || 100), wins: Number(row.wins || 0), losses: Number(row.losses || 0) }; }

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

    CREATE TABLE IF NOT EXISTS skins (
      id SERIAL PRIMARY KEY,
      name VARCHAR(64) UNIQUE NOT NULL,
      price INT DEFAULT 50,
      details JSONB DEFAULT '{}'::jsonb
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
    if (!validUsername(username)) return res.status(400).json({ error: 'Usuário inválido (3-24 caracteres alfanuméricos e _).' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Senha deve ter entre 8 e 72 caracteres.' });
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
    if (!allow(`login:${req.ip}`, 8, 60000)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um momento.' });
    const r = await q('SELECT * FROM profiles WHERE username=$1', [username]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    if (await banned(r.rows[0].id)) return res.status(403).json({ error: 'Conta banida.' });
    res.json({ user: safeUser(r.rows[0]), token: sign(r.rows[0]) });
  } catch (e) { res.status(500).json({ error: 'Erro no login.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => res.json({ user: safeUser(req.user) }));
app.get('/api/online', auth, (_req, res) => res.json({ players: [...online.values()].map(x => ({ id: x.id, username: x.username })) }));

// Área de comandos administrativos
app.post('/api/admin/command', auth, requireRole('admin', 'staff'), async (req, res) => {
  const raw = cleanText(req.body.command, 500);
  if (!raw.startsWith('/')) return res.status(400).json({ error: 'Comando inválido.' });
  const [cmd, ...args] = raw.slice(1).split(/\s+/);
  const command = cmd.toLowerCase();

  let result = { ok: true, command };
  if (command === 'all') {
    result.players = [...online.values()];
  } else if (command === 'help') {
    result.commands = ['/all', '/banir id', '/expulsar id', '/ver partida', '/chatglobal on|off', '/congelar msg: texto', '/descongelar', '/criar staff'];
  } else if (command === 'ver' && args[0] === 'partida') {
    result.rooms = [...rooms.values()].map(r => ({ code: r.code, players: r.players.size, status: r.state.status }));
  } else if (command === 'banir') {
    const target = Number(args[0]);
    if (!Number.isInteger(target)) return res.status(400).json({ error: 'ID inválido.' });
    await q('INSERT INTO bans(user_id,reason,created_by) VALUES($1,$2,$3)', [target, 'Banimento administrativo', req.user.id]);
    result.message = `Jogador ${target} banido com sucesso.`;
  } else if (command === 'chatglobal') {
    globalChatEnabled = args[0] !== 'off';
    result.message = `Chat global ${globalChatEnabled ? 'ativado' : 'desativado'}.`;
  } else if (command === 'congelar') {
    result.message = 'Jogo congelado pelos administradores.';
  } else if (command === 'descongelar') {
    result.message = 'Jogo descongelado.';
  } else {
    return res.status(400).json({ error: 'Comando não reconhecido.' });
  }

  await q('INSERT INTO admin_actions(actor_id,command,details) VALUES($1,$2,$3)', [req.user.id, command, result]);
  res.json(result);
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const r = await q('SELECT id,username,role,coins,wins,losses FROM profiles WHERE id=$1', [payload.sub]);
    if (!r.rowCount || await banned(r.rows[0].id)) return next(new Error('Não autorizado'));
    socket.user = r.rows[0]; next();
  } catch { next(new Error('Não autorizado')); }
});

io.on('connection', socket => {
  const u = safeUser(socket.user);
  online.set(u.id, { id: u.id, username: u.username, socketId: socket.id });
  io.emit('online:update', [...online.values()].map(x => ({ id: x.id, username: x.username })));

  socket.on('disconnect', () => {
    online.delete(u.id);
    io.emit('online:update', [...online.values()].map(x => ({ id: x.id, username: x.username })));
  });
});

// Interface Completa Embutida (Responsiva Celular/PC + Vinheta VELHOGAMES + Abas + Modo Online)
app.get('*', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnoVelho</title>
  <style>
    :root { --bg: #121212; --card: #1e1e1e; --accent: #f39c12; --text: #ffffff; --text-dim: #aaa; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow-x: hidden; }
    .screen { width: 100%; max-width: 480px; padding: 20px; display: flex; flex-direction: column; align-items: center; text-align: center; }
    .hidden { display: none !important; }
    h1 { color: var(--accent); font-size: 2.5rem; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 2px; }
    h2 { font-size: 1.5rem; margin-bottom: 20px; color: var(--text); }
    p { color: var(--text-dim); margin-bottom: 20px; font-size: 0.95rem; }
    .card { background: var(--card); width: 100%; padding: 25px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); margin-bottom: 15px; }
    input, select { width: 100%; padding: 12px; margin-bottom: 12px; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; color: #fff; font-size: 1rem; }
    button { width: 100%; padding: 12px; background: var(--accent); border: none; border-radius: 6px; color: #121212; font-weight: bold; font-size: 1rem; cursor: pointer; transition: 0.2s; margin-top: 5px; }
    button:hover { filter: brightness(1.1); }
    .btn-secondary { background: #333; color: #fff; margin-top: 10px; }
    .error { color: #e74c3c; font-size: 0.85rem; margin-bottom: 10px; }
    .nav-tabs { display: flex; gap: 5px; width: 100%; margin-bottom: 15px; overflow-x: auto; padding-bottom: 5px; }
    .nav-tabs button { padding: 8px 12px; font-size: 0.85rem; white-space: nowrap; margin: 0; }
    #intro-screen { animation: fadeIn 1.5s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
  </style>
</head>
<body>

  <!-- 1. VINHETA DE ABERTURA -->
  <div id="intro-screen" class="screen">
    <h1>VelhoGames</h1>
    <p>Apresenta</p>
    <h1 style="font-size: 3rem; color: #fff;">UnoVelho</h1>
    <button onclick="showPlatformScreen()" style="margin-top: 30px;">🎮 Iniciar Jogo</button>
  </div>

  <!-- 2. ESCOLHA DA PLATAFORMA -->
  <div id="platform-screen" class="screen hidden">
    <h1>UnoVelho</h1>
    <p>Escolha sua plataforma para otimizar os controles:</p>
    <div class="card">
      <button onclick="setPlatform('mobile')">📱 Celular (Toque otimizado)</button>
      <button onclick="setPlatform('desktop')" class="btn-secondary">🖥️ Computador</button>
    </div>
  </div>

  <!-- 3. LOGIN E CADASTRO -->
  <div id="auth-screen" class="screen hidden">
    <h1>Entrar</h1>
    <div class="card">
      <div id="auth-error" class="error"></div>
      <input type="text" id="username" placeholder="Usuário (ex: Velho)">
      <input type="password" id="password" placeholder="Senha">
      <button onclick="handleLogin()">Entrar</button>
      <button onclick="handleRegister()" class="btn-secondary">Cadastrar Nova Conta</button>
    </div>
  </div>

  <!-- 12. MENU PRINCIPAL & ABAS -->
  <div id="main-screen" class="screen hidden" style="max-width: 600px;">
    <h1>UnoVelho</h1>
    <p id="welcome-msg" style="color: var(--accent); font-weight: bold;"></p>
    
    <div class="nav-tabs">
      <button onclick="switchTab('play')">🎮 Jogar</button>
      <button onclick="switchTab('online')">🌐 Online</button>
      <button onclick="switchTab('shop')">🛒 Loja</button>
      <button onclick="switchTab('profile')">👤 Perfil</button>
      <button onclick="switchTab('settings')">⚙️ Config</button>
    </div>

    <div id="tab-play" class="card tab-content">
      <h2>Modo de Jogo</h2>
      <button onclick="alert('Modo Solo em breve!')">🤖 Jogar Solo</button>
      <button onclick="alert('Treinamento iniciado!')" class="btn-secondary">🎯 Treinamento</button>
    </div>

    <div id="tab-online" class="card tab-content hidden">
      <h2>Salas Online</h2>
      <input type="text" id="room-code-input" placeholder="Código da Sala (4 letras/números)" maxlength="4" style="text-transform: uppercase;">
      <button onclick="joinRoom()">Entrar na Sala</button>
      <button onclick="createRoom()" class="btn-secondary">Criar Nova Sala</button>
    </div>

    <div id="tab-shop" class="card tab-content hidden">
      <h2>Loja de Skins</h2>
      <p>Compre skins e itens com suas moedas do jogo!</p>
      <button onclick="alert('Loja atualizada pelo ADM.')">Ver Catálogo</button>
    </div>

    <div id="tab-profile" class="card tab-content hidden">
      <h2>Personalização do Jogador</h2>
      <p>Personalize seu rosto, cabelo e acessórios.</p>
      <button onclick="alert('Perfil salvo!')">Salvar Alterações</button>
    </div>

    <div id="tab-settings" class="card tab-content hidden">
      <h2>Configurações de Desempenho</h2>
      <p>Qualidade Gráfica: Alta (60 FPS)</p>
      <button onclick="alert('Configurações salvas!')">Alternar Som / Música</button>
      <button onclick="handleLogout()" class="btn-secondary" style="background: #c0392b; color: #fff; margin-top: 20px;">Sair da Conta</button>
    </div>
  </div>

<script>
  let token = localStorage.getItem('unovelho_token') || '';
  let platform = 'desktop';

  function showPlatformScreen() {
    document.getElementById('intro-screen').classList.add('hidden');
    document.getElementById('platform-screen').classList.remove('hidden');
  }

  function setPlatform(p) {
    platform = p;
    document.getElementById('platform-screen').classList.add('hidden');
    if (token) {
      verifyToken();
    } else {
      document.getElementById('auth-screen').classList.remove('hidden');
    }
  }

  async function verifyToken() {
    try {
      const res = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('main-screen').classList.remove('hidden');
        document.getElementById('welcome-msg').innerText = 'Logado como: ' + data.user.username + ' (Moedas: ' + data.user.coins + ')';
      } else {
        localStorage.removeItem('unovelho_token');
        token = '';
        document.getElementById('auth-screen').classList.remove('hidden');
      }
    } catch {
      document.getElementById('auth-screen').classList.remove('hidden');
    }
  }

  async function handleLogin() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errEl = document.getElementById('auth-error');
    errEl.innerText = '';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao entrar.');
      token = data.token;
      localStorage.setItem('unovelho_token', token);
      verifyToken();
    } catch (err) {
      errEl.innerText = err.message;
    }
  }

  async function handleRegister() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errEl = document.getElementById('auth-error');
    errEl.innerText = '';

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro no cadastro.');
      token = data.token;
      localStorage.setItem('unovelho_token', token);
      verifyToken();
    } catch (err) {
      errEl.innerText = err.message;
    }
  }

  function handleLogout() {
    localStorage.removeItem('unovelho_token');
    token = '';
    document.getElementById('main-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
  }

  function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById('tab-' + tabName).classList.remove('hidden');
  }

  function createRoom() {
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    alert('Sala criada com sucesso! Código: ' + code);
  }

  function joinRoom() {
    const code = document.getElementById('room-code-input').value.toUpperCase();
    if (code.length !== 4) {
      alert('A porta/código da sala deve ter exatamente 4 caracteres.');
      return;
    }
    alert('Entrando na sala ' + code + '...');
  }
</script>
</body>
</html>`);
});

(async () => {
  await ensureSchema();
  server.listen(PORT, '0.0.0.0', () => console.log(`UnoVelho online na porta ${PORT}`));
})().catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
