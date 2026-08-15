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
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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
async function transaction(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function ensureSchema() {
  const schema = require('fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await q(schema);
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
    if (!validUsername(username)) return res.status(400).json({ error: 'Usuário inválido. Use 3-24 letras, números ou _. ' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'A senha deve ter 8-72 caracteres.' });
    const hash = await bcrypt.hash(password, 12);
    const r = await q('INSERT INTO profiles (username,password_hash) VALUES ($1,$2) RETURNING id,username,role,coins,wins,losses', [username, hash]);
    await q('INSERT INTO customizations(user_id,data) VALUES($1,$2) ON CONFLICT DO NOTHING', [r.rows[0].id, {}]);
    res.status(201).json({ user: safeUser(r.rows[0]), token: sign(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Usuário já existe.' });
    console.error(e); res.status(500).json({ error: 'Erro no cadastro.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = cleanName(req.body.username);
    const password = String(req.body.password || '');
    if (!allow(`login:${req.ip}`, 8, 60000)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde.' });
    const r = await q('SELECT * FROM profiles WHERE username=$1', [username]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    if (await banned(r.rows[0].id)) return res.status(403).json({ error: 'Conta banida.' });
    res.json({ user: safeUser(r.rows[0]), token: sign(r.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro no login.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => res.json({ user: safeUser(req.user) }));

app.get('/api/online', auth, (_req, res) => res.json({ players: [...online.values()].map(x => ({ id: x.id, username: x.username })) }));

app.get('/api/rooms', auth, async (_req, res) => {
  const r = await q(`SELECT r.id,r.code,r.max_players,r.map_key,r.status,r.created_at,
    COUNT(rp.user_id)::int AS players FROM rooms r LEFT JOIN room_players rp ON rp.room_id=r.id
    WHERE r.status IN ('waiting','playing','frozen') GROUP BY r.id ORDER BY r.created_at DESC LIMIT 50`);
  res.json({ rooms: r.rows });
});

app.post('/api/rooms', auth, async (req, res) => {
  if (await banned(req.user.id)) return res.status(403).json({ error: 'Conta banida.' });
  const maxPlayers = Math.max(2, Math.min(10, Number(req.body.maxPlayers || 4)));
  const mapKey = cleanText(req.body.mapKey || 'taverna', 64);
  let code;
  for (let i = 0; i < 10; i++) { const c = roomCode(); const exists = await q('SELECT 1 FROM rooms WHERE code=$1 AND status<>\'finished\'', [c]); if (!exists.rowCount) { code = c; break; } }
  if (!code) return res.status(503).json({ error: 'Não foi possível criar a sala.' });
  const r = await q('INSERT INTO rooms(code,owner_id,max_players,map_key,rules) VALUES($1,$2,$3,$4,$5) RETURNING *', [code, req.user.id, maxPlayers, mapKey, req.body.rules || {}]);
  await q('INSERT INTO room_players(room_id,user_id,seat) VALUES($1,$2,1)', [r.rows[0].id, req.user.id]);
  rooms.set(code, { code, roomId: Number(r.rows[0].id), players: new Map([[req.user.id, { id: req.user.id, username: req.user.username, seat: 1, spectator: false }]]), state: { status: 'waiting' } });
  res.status(201).json({ room: { id: r.rows[0].id, code, maxPlayers, mapKey, status: 'waiting' } });
});

app.post('/api/rooms/:code/join', auth, async (req, res) => {
  const code = cleanName(req.params.code).toUpperCase();
  if (!validRoomCode(code)) return res.status(400).json({ error: 'Porta inválida.' });
  if (await banned(req.user.id)) return res.status(403).json({ error: 'Conta banida.' });
  const r = await q(`SELECT r.*, COUNT(rp.user_id)::int AS players FROM rooms r LEFT JOIN room_players rp ON rp.room_id=r.id WHERE r.code=$1 GROUP BY r.id`, [code]);
  if (!r.rowCount) return res.status(404).json({ error: 'Sala não encontrada.' });
  const room = r.rows[0];
  if (room.status !== 'waiting') return res.status(409).json({ error: 'Sala não está esperando jogadores.' });
  if (Number(room.players) >= room.max_players) return res.status(409).json({ error: 'Sala cheia.' });
  const already = await q('SELECT 1 FROM room_players WHERE room_id=$1 AND user_id=$2', [room.id, req.user.id]);
  if (!already.rowCount) {
    const seat = Number(room.players) + 1;
    await q('INSERT INTO room_players(room_id,user_id,seat) VALUES($1,$2,$3)', [room.id, req.user.id, seat]);
  }
  res.json({ room: { id: room.id, code: room.code, maxPlayers: room.max_players, mapKey: room.map_key, status: room.status } });
});

app.post('/api/admin/command', auth, requireRole('admin','staff'), async (req, res) => {
  const raw = cleanText(req.body.command, 500);
  if (!raw.startsWith('/')) return res.status(400).json({ error: 'Comando inválido.' });
  const [cmd, ...args] = raw.slice(1).split(/\s+/);
  const command = cmd.toLowerCase();
  const allowedStaff = new Set(['all','help','ver','banir','expulsar','chatglobal','chat','congelar','descongelar']);
  if (req.user.role === 'staff' && !allowedStaff.has(command)) return res.status(403).json({ error: 'Staff sem essa permissão.' });

  let result = { ok: true, command };
  if (command === 'all') result.players = [...online.values()];
  else if (command === 'help') result.commands = ['/all','/banir id','/expulsar id','/ver partida','/chatglobal on|off','/chat on|off','/congelar msg: texto','/descongelar'];
  else if (command === 'ver' && args[0] === 'partida') result.rooms = [...rooms.values()].map(r => ({ code:r.code, players:r.players.size, status:r.state.status }));
  else if (command === 'banir') {
    const target = Number(args[0]); if (!Number.isInteger(target)) return res.status(400).json({ error: 'ID inválido.' });
    await q('INSERT INTO bans(user_id,reason,created_by) VALUES($1,$2,$3)', [target, 'Banimento administrativo', req.user.id]);
    result.message = `Jogador ${target} banido.`;
  } else if (command === 'chatglobal') { result.message = `Chat global ${args[0] === 'off' ? 'desligado' : 'ligado'}.`; }
  else if (command === 'chat') { result.message = `Chat privado ${args[0] === 'off' ? 'desligado' : 'ligado'}.`; }
  else if (command === 'congelar') { result.message = 'Congelamento será aplicado à sala informada pela próxima versão do sistema de partidas.'; }
  else if (command === 'descongelar') { result.message = 'Descongelamento processado.'; }
  else return res.status(400).json({ error: 'Comando ainda não disponível nesta base.' });

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
  online.set(u.id, { id:u.id, username:u.username, socketId:socket.id });
  io.emit('online:update', [...online.values()].map(x => ({ id:x.id, username:x.username })));

  socket.on('room:join', async ({ code }) => {
    code = cleanName(code).toUpperCase();
    if (!validRoomCode(code)) return socket.emit('error:message', 'Porta inválida.');
    const r = await q('SELECT id FROM rooms WHERE code=$1 AND status IN (\'waiting\',\'playing\',\'frozen\')', [code]);
    if (!r.rowCount) return socket.emit('error:message', 'Sala não encontrada.');
    socket.join(`room:${r.rows[0].id}`); socket.data.roomId = Number(r.rows[0].id);
    socket.emit('room:joined', { roomId:Number(r.rows[0].id), code });
  });

  socket.on('chat:send', async ({ roomId, body }) => {
    const text = cleanText(body, 500);
    if (!text || !allow(`chat:${u.id}`, 8, 5000)) return;
    const result = await q('INSERT INTO messages(room_id,sender_id,channel,body) VALUES($1,$2,\'room\',$3) RETURNING id,created_at', [Number(roomId), u.id, text]);
    io.to(`room:${Number(roomId)}`).emit('chat:message', { id:result.rows[0].id, username:u.username, body:text, createdAt:result.rows[0].created_at });
  });

  socket.on('disconnect', () => {
    online.delete(u.id);
    io.emit('online:update', [...online.values()].map(x => ({ id:x.id, username:x.username })));
  });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

(async () => {
  await ensureSchema();
  server.listen(PORT, '0.0.0.0', () => console.log(`UnoVelho online na porta ${PORT}`));
})().catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
