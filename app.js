// APP.JS - LÓGICA DO UNO MATEMATIXA COMPLETA E INTEGRADA AO WEBSOCKET / REST

const socket = io();

// --- SINTETIZADOR DE ÁUDIO WEB AUDIO API ---
const SoundFX = {
  ctx: null,
  enabled: true,
  init() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); },
  play(freq, type = 'sine', duration = 0.15) {
    if (!this.enabled) return;
    try {
      this.init();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.00001, this.ctx.currentTime + duration);
    } catch(e) {}
  },
  cardPlay() { this.play(440, 'triangle', 0.1); },
  correctAnswer() { this.play(587, 'sine', 0.2); setTimeout(() => this.play(880, 'sine', 0.3), 150); },
  wrongAnswer() { this.play(150, 'sawtooth', 0.4); }
};

let currentUser = null;
let authToken = localStorage.getItem("uno_token") || null;

let gameState = {
  deck: [],
  discardCard: null,
  playerHand: [],
  botHand: [],
  isPlayerTurn: true,
  currentColor: "red",
  pendingCardIndex: null,
  mathTarget: 0,
  difficulty: "medium"
};

document.addEventListener("DOMContentLoaded", () => {
  checkTermsModal();
  setupAuthEvents();
  setupLobbyEvents();
  setupSocketListeners();
});

function checkTermsModal() {
  if (localStorage.getItem("uno_terms_accepted")) {
    document.getElementById("termsModal").style.display = "none";
  }
  document.getElementById("btnAcceptTerms").onclick = () => {
    localStorage.setItem("uno_terms_accepted", "true");
    document.getElementById("termsModal").style.display = "none";
  };
}

function setupAuthEvents() {
  const formLogin = document.getElementById("formLogin");
  const formRegister = document.getElementById("formRegister");
  const authMsg = document.getElementById("authMessage");

  formLogin.onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: e.target.username.value, password: e.target.password.value })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      localStorage.setItem("uno_token", authToken);
      currentUser = data.user;
      enterLobby();
    } else {
      authMsg.innerText = data.message;
    }
  };

  formRegister.onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: e.target.regUsername.value, password: e.target.regPassword.value })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      localStorage.setItem("uno_token", authToken);
      currentUser = data.user;
      document.getElementById("characterCreationModal").style.display = "flex";
    } else {
      authMsg.innerText = data.message;
    }
  };

  document.getElementById("btnSaveCharacter").onclick = async () => {
    const avatarData = {
      hairColor: document.getElementById("hairColorInput").value,
      hairStyle: document.getElementById("hairStyleSelect").value,
      outfit: document.getElementById("outfitSelect").value
    };
    await fetch("/api/user/character", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${authToken}` },
      body: JSON.stringify({ avatarData })
    });
    document.getElementById("characterCreationModal").style.display = "none";
    enterLobby();
  };
}

function enterLobby() {
  document.getElementById("authSection").style.display = "none";
  document.getElementById("lobbyDashboard").style.display = "block";
  document.getElementById("userNameDisplay").innerText = currentUser.username;
  document.getElementById("userCoinsDisplay").innerText = `🪙 ${currentUser.coins} Moedas`;
  document.getElementById("userXpDisplay").innerText = `⭐ Nível ${currentUser.level} (${currentUser.xp} XP)`;

  if (currentUser.role === "CEO") {
    document.getElementById("ceoBadge").style.display = "inline-block";
  }

  socket.emit("join_global_chat", currentUser.username);
}

function setupLobbyEvents() {
  document.getElementById("btnOpenGameModes").onclick = () => {
    document.getElementById("gameModesModal").style.display = "flex";
  };
  document.getElementById("btnModeSolo").onclick = () => {
    closeModal("gameModesModal");
    document.getElementById("soloDifficultyModal").style.display = "flex";
  };
  document.getElementById("btnSendGlobalChat").onclick = sendGlobalChatMessage;
  document.getElementById("btnSubmitMath").onclick = validateMathAnswer;
  document.getElementById("btnToggleAudio").onclick = () => {
    SoundFX.enabled = !SoundFX.enabled;
    document.getElementById("btnToggleAudio").innerText = `🔊 Som: ${SoundFX.enabled ? 'ON' : 'OFF'}`;
  };
}

function closeModal(id) {
  document.getElementById(id).style.display = "none";
}

function sendGlobalChatMessage() {
  const input = document.getElementById("globalChatInput");
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit("send_global_chat", { message: msg, token: authToken });
  input.value = "";
}

function setupSocketListeners() {
  socket.on("global_message", (data) => {
    const chatArea = document.getElementById("globalChatMessages");
    const msgEl = document.createElement("div");
    msgEl.innerHTML = `<strong>[${data.role || 'JOGADOR'}] ${data.user}:</strong> ${data.message}`;
    chatArea.appendChild(msgEl);
    chatArea.scrollTop = chatArea.scrollHeight;
  });

  socket.on("system_message", (msg) => {
    alert(msg);
  });

  socket.on("game_paused_event", (data) => {
    alert(data.msg);
  });
}

// --- LÓGICA DO JOGO UNO MATEMATIXA SOLO ---

function startSoloGame(difficulty) {
  closeModal("soloDifficultyModal");
  document.getElementById("lobbyDashboard").style.display = "none";
  document.getElementById("gameArena").style.display = "flex";

  gameState.difficulty = difficulty;
  gameState.deck = createFullDeck();
  gameState.playerHand = gameState.deck.splice(0, 7);
  gameState.botHand = gameState.deck.splice(0, 7);
  
  do {
    gameState.discardCard = gameState.deck.pop();
  } while (gameState.discardCard.color === "black");

  gameState.currentColor = gameState.discardCard.color;
  gameState.isPlayerTurn = true;
  updateRender();
}

function createFullDeck() {
  const colors = ["red", "blue", "green", "yellow"];
  let deck = [];
  colors.forEach(color => {
    for (let i = 0; i <= 9; i++) deck.push({ color, value: i.toString(), type: "number" });
    deck.push({ color, value: "🚫", type: "skip" });
    deck.push({ color, value: "🔄", type: "reverse" });
    deck.push({ color, value: "+2", type: "draw2" });
  });
  for (let i = 0; i < 4; i++) {
    deck.push({ color: "black", value: "🌈", type: "wild" });
    deck.push({ color: "black", value: "+4", type: "draw4" });
  }
  return deck.sort(() => Math.random() - 0.5);
}

function updateRender() {
  const discardEl = document.getElementById("discardPile");
  discardEl.className = `uno-card card-${gameState.currentColor}`;
  discardEl.innerText = gameState.discardCard.value;

  document.getElementById("botTopLabel").innerText = `Bot (${gameState.botHand.length} cartas)`;

  const handEl = document.getElementById("playerHand");
  handEl.innerHTML = "";
  gameState.playerHand.forEach((card, index) => {
    const cardDiv = document.createElement("div");
    cardDiv.className = `uno-card card-${card.color}`;
    cardDiv.innerText = card.value;
    cardDiv.onclick = () => attemptPlayCard(index);
    handEl.appendChild(cardDiv);
  });

  document.getElementById("turnStatus").innerText = gameState.isPlayerTurn ? "SUA VEZ!" : "VEZ DO BOT...";
}

function attemptPlayCard(index) {
  if (!gameState.isPlayerTurn) return;
  const card = gameState.playerHand[index];

  const isMatchColor = card.color === gameState.currentColor;
  const isMatchValue = card.value === gameState.discardCard.value;
  const isWild = card.color === "black";

  if (isMatchColor || isMatchValue || isWild) {
    gameState.pendingCardIndex = index;
    openMathChallenge(card);
  } else {
    SoundFX.wrongAnswer();
    alert("Carta inválida para este monte!");
  }
}

function openMathChallenge(card) {
  let n1, n2, op;
  if (card.type === "draw4" || card.type === "draw2") {
    n1 = Math.floor(Math.random() * 8) + 2;
    n2 = Math.floor(Math.random() * 8) + 2;
    op = "x";
    gameState.mathTarget = n1 * n2;
  } else if (card.type === "skip" || card.type === "reverse") {
    n1 = Math.floor(Math.random() * 30) + 10;
    n2 = Math.floor(Math.random() * 10) + 1;
    op = "-";
    gameState.mathTarget = n1 - n2;
  } else {
    n1 = Math.floor(Math.random() * 20) + 1;
    n2 = Math.floor(Math.random() * 20) + 1;
    op = "+";
    gameState.mathTarget = n1 + n2;
  }

  document.getElementById("mathQuestion").innerText = `Quanto é ${n1} ${op} ${n2}?`;
  document.getElementById("mathAnswer").value = "";
  document.getElementById("mathModal").style.display = "flex";
}

function validateMathAnswer() {
  const ans = parseInt(document.getElementById("mathAnswer").value);
  document.getElementById("mathModal").style.display = "none";

  if (ans === gameState.mathTarget) {
    SoundFX.correctAnswer();
    SoundFX.cardPlay();

    const playedCard = gameState.playerHand.splice(gameState.pendingCardIndex, 1)[0];
    gameState.discardCard = playedCard;

    if (playedCard.color === "black") {
      const colors = ["red", "blue", "green", "yellow"];
      gameState.currentColor = colors[Math.floor(Math.random() * colors.length)];
    } else {
      gameState.currentColor = playedCard.color;
    }

    if (gameState.playerHand.length === 0) {
      alert("🏆 PARABÉNS! Você venceu a partida!");
      location.reload();
      return;
    }

    gameState.isPlayerTurn = false;
    updateRender();
    setTimeout(botPlay, 1500);
  } else {
    SoundFX.wrongAnswer();
    alert("❌ Errou a conta! Perdeu a vez.");
    gameState.isPlayerTurn = false;
    updateRender();
    setTimeout(botPlay, 1500);
  }
}

function botPlay() {
  const playableIndex = gameState.botHand.findIndex(c => 
    c.color === gameState.currentColor || c.value === gameState.discardCard.value || c.color === "black"
  );

  if (playableIndex !== -1) {
    SoundFX.cardPlay();
    const played = gameState.botHand.splice(playableIndex, 1)[0];
    gameState.discardCard = played;

    if (played.color === "black") {
      const colors = ["red", "blue", "green", "yellow"];
      gameState.currentColor = colors[Math.floor(Math.random() * colors.length)];
    } else {
      gameState.currentColor = played.color;
    }

    if (gameState.botHand.length === 0) {
      alert("🤖 O Bot venceu!");
      location.reload();
      return;
    }
  } else if (gameState.deck.length > 0) {
    gameState.botHand.push(gameState.deck.pop());
  }

  gameState.isPlayerTurn = true;
  updateRender();
}
