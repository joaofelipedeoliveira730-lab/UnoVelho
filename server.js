require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jwt-simple");
const cors = require("cors");
const helmet = require("helmet");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || "minha_chave_secreta_super_segura_12345";
let isGamePaused = false;

// Middleware de Autenticação JWT
function authenticateToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Acesso negado." });
  try {
    const decoded = jwt.decode(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Token inválido." });
  }
}

// Criar ou Inicializar Conta do CEO
async function initCeoAccount() {
  const ceoUsername = process.env.ADMIN_INITIAL_USERNAME || "CeoVelho";
  const ceoPassword = process.env.ADMIN_INITIAL_PASSWORD || "CeoMasterPass123!";
  
  const userCheck = await pool.query("SELECT * FROM users WHERE username = $1", [ceoUsername]);
  if (userCheck.rows.length === 0) {
    const hash = await bcrypt.hash(ceoPassword, 10);
    const newUser = await pool.query(
      "INSERT INTO users (username, password_hash, role, coins, level) VALUES ($1, $2, 'CEO', 999999, 100) RETURNING id",
      [ceoUsername, hash]
    );
    await pool.query("INSERT INTO user_profiles (user_id) VALUES ($1)", [newUser.rows[0].id]);
    console.log(`[CEO] Conta ${ceoUsername} inicializada com sucesso.`);
  }
}
initCeoAccount().catch(console.error);

// --- ROTAS DA API REST ---

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const userRes = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, role, coins, level, xp",
      [username, hash]
    );
    const user = userRes.rows[0];
    await pool.query("INSERT INTO user_profiles (user_id) VALUES ($1)", [user.id]);
    const token = jwt.encode({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
    res.json({ success: true, message: "Conta criada com sucesso!", token, user });
  } catch (err) {
    res.status(400).json({ success: false, message: "Usuário já existente ou erro no cadastro." });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (userRes.rows.length === 0) return res.json({ success: false, message: "Usuário não encontrado." });
    
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.json({ success: false, message: "Senha incorreta." });

    const token = jwt.encode({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
    delete user.password_hash;
    res.json({ success: true, message: "Login realizado com sucesso!", token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Erro no servidor de autenticação." });
  }
});

app.post("/api/user/character", authenticateToken, async (req, res) => {
  const { avatarData } = req.body;
  try {
    await pool.query(
      "UPDATE user_profiles SET avatar_data = $1 WHERE user_id = $2",
      [JSON.stringify(avatarData), req.user.id]
    );
    res.json({ success: true, message: "Personagem atualizado!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao salvar o personagem." });
  }
});

app.get("/api/shop/items", async (req, res) => {
  try {
    const items = await pool.query("SELECT * FROM shop_items");
    res.json(items.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao carregar loja." });
  }
});

app.post("/api/shop/buy", authenticateToken, async (req, res) => {
  const { itemId } = req.body;
  try {
    const itemRes = await pool.query("SELECT * FROM shop_items WHERE id = $1", [itemId]);
    if (itemRes.rows.length === 0) return res.status(404).json({ error: "Item não encontrado." });
    const item = itemRes.rows[0];

    const userRes = await pool.query("SELECT coins FROM users WHERE id = $1", [req.user.id]);
    if (userRes.rows[0].coins < item.price) return res.status(400).json({ error: "Moedas insuficientes." });

    await pool.query("UPDATE users SET coins = coins - $1 WHERE id = $2", [item.price, req.user.id]);
    await pool.query("INSERT INTO inventory (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, itemId]);
    
    res.json({ success: true, message: "Item comprado com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro durante a transação de compra." });
  }
});

// --- LÓGICA DE WEBSOCKETS E SALAS ONLINE ---

const rooms = {};

io.on("connection", (socket) => {
  socket.on("join_global_chat", (username) => {
    socket.username = username;
    socket.join("global");
  });

  socket.on("send_global_chat", (data) => {
    const { message, token } = data;
    try {
      const user = jwt.decode(token, JWT_SECRET);
      
      // COMANDOS DE ADMINISTRAÇÃO DO CEO
      if (user.role === "CEO" && message.startsWith("/")) {
        handleCeoCommand(socket, message);
        return;
      }

      if (isGamePaused) {
        socket.emit("system_message", "⚠️ O jogo está temporariamente paralisado pelo CEO.");
        return;
      }

      io.to("global").emit("global_message", { user: user.username, message, role: user.role });
    } catch (e) {
      socket.emit("system_message", "Sessão inválida.");
    }
  });

  socket.on("create_room", ({ roomName, password, maxPlayers, mapId, token }) => {
    try {
      const user = jwt.decode(token, JWT_SECRET);
      const roomId = "MATX-" + Math.floor(1000 + Math.random() * 9000);
      rooms[roomId] = {
        id: roomId,
        name: roomName,
        password: password || null,
        maxPlayers: maxPlayers || 4,
        mapId: mapId || "map_saloon",
        owner: user.username,
        players: [{ id: socket.id, username: user.username, isHost: true }]
      };
      socket.join(roomId);
      socket.emit("room_created", rooms[roomId]);
      io.emit("update_rooms_list", Object.values(rooms));
    } catch (e) {
      socket.emit("system_message", "Erro ao criar sala.");
    }
  });

  socket.on("get_rooms", () => {
    socket.emit("update_rooms_list", Object.values(rooms));
  });
});

function handleCeoCommand(socket, commandStr) {
  const parts = commandStr.split(" ");
  const cmd = parts[0].toLowerCase();

  if (cmd === "/paralisaruno") {
    isGamePaused = true;
    io.emit("game_paused_event", { paused: true, msg: "⚠️ O CEO paralisou todas as partidas do UNO Matematixa!" });
    io.emit("global_message", { user: "SISTEMA", message: "🚨 O jogo foi paralisado pelo CEO.", role: "CEO" });
  } else if (cmd === "/desparalisaruno") {
    isGamePaused = false;
    io.emit("game_paused_event", { paused: false, msg: "▶️ O CEO retomou as partidas!" });
    io.emit("global_message", { user: "SISTEMA", message: "✅ O jogo foi liberado pelo CEO.", role: "CEO" });
  } else if (cmd === "/help") {
    const helpMsg = "👑 COMANDOS DO CEO: /paralisaruno, /desparalisaruno, /anuncio [msg], /darcoins [user] [qtd]";
    socket.emit("system_message", helpMsg);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[UNO MATEMATIXA] Servidor rodando na porta ${PORT}`));
