const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');

// ===== PROTEÇÃO GLOBAL =====
process.on('uncaughtException', (err) => {
  console.error('🚨 Erro não capturado (CRASH):', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Promise rejeitada não tratada:', reason);
});

// ========== INICIALIZAÇÃO DO FIREBASE ==========
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('🔥 Firebase conectado!');
} catch (e) {
  console.error('⚠️ Erro ao conectar Firebase:', e.message);
  process.exit(1);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT_KEY não definida. O servidor não pode funcionar.');
  process.exit(1);
}
console.log('🔑 Firestore configurado com a coleção "users".');

const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(cookieParser());

// ========== CONFIG ==========
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];
const settings = { maxQueue: 20, cooldown: 30, maxDuration: 600, maxListeners: 20 };
const DISLIKE_THRESHOLD = 10;
const MAX_SONGS_PER_USER = 3;
const SKIP_VOTE_THRESHOLD = 0.5;
const MIN_SKIP_VOTES = 3;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// ========== ESTADO EM MEMÓRIA ==========
const users = new Map();
const sessions = new Map(); // sessionToken -> email
const userFavorites = new Map();
const userPoints = new Map();
const userThemes = new Map();
const userSettings = new Map();
const rooms = new Map();
const roomLikes = new Map();
const roomVotes = new Map();
const waitingRooms = new Map();

// ========== FUNÇÕES DE APOIO ==========
function getRoomLikes(slug) {
  if (!roomLikes.has(slug)) roomLikes.set(slug, {});
  return roomLikes.get(slug);
}

function getRoomVotes(slug) {
  if (!roomVotes.has(slug)) roomVotes.set(slug, {});
  return roomVotes.get(slug);
}

function createRoom(slug, name, adminName = null) {
  roomLikes.set(slug, {});
  roomVotes.set(slug, {});
  waitingRooms.set(slug, []);
  return {
    slug, name, admin: adminName,
    queue: [], waitingQueue: [],
    currentIndex: 0, startedAt: Date.now(),
    votes: { up: 0, down: 0 }, bannedUsers: [],
    chatHistory: [], listenerCount: 0,
    lastAddTime: new Map(), isPlaying: false, lastAdvanceAt: 0,
    history: [], skipVotes: new Set(),
    radioMode: false, radioGenre: 'pop',
    pinnedMessage: null, color: '#7c3aed',
    discordWebhook: null, inviteCount: 0, eventStartTime: null,
    totalSongsAdded: 0, totalVotesGiven: 0, mostVoted: [],
  };
}

// ========== FUNÇÕES FIREBASE ==========
async function getUserFromFirestore(email) {
  try { const doc = await db.collection('users').doc(email).get(); if (doc.exists) return doc.data(); } catch (e) {}
  return null;
}
async function setUserInFirestore(email, data) {
  try { await db.collection('users').doc(email).set(data, { merge: true }); } catch (e) {}
}
async function getFavoritesFromFirestore(email) {
  try { const doc = await db.collection('favorites').doc(email).get(); if (doc.exists) return doc.data().items || []; } catch (e) {}
  return [];
}
async function setFavoritesInFirestore(email, items) {
  try { await db.collection('favorites').doc(email).set({ items }); } catch (e) {}
}
async function getPointsFromFirestore(email) {
  try { const doc = await db.collection('points').doc(email).get(); if (doc.exists) return doc.data(); } catch (e) {}
  return { points: 0, badges: [] };
}
async function setPointsInFirestore(email, data) {
  try { await db.collection('points').doc(email).set(data); } catch (e) {}
}

// ===== ADMIN PERSISTENTE =====
async function loadAdmins() {
  try {
    const snapshot = await db.collection('admins').get();
    const adminSet = new Set();
    snapshot.forEach(doc => adminSet.add(doc.id));
    return adminSet;
  } catch (e) { return new Set(); }
}
let adminEmails = new Set();
(async () => { adminEmails = await loadAdmins(); })();

async function isAdmin(email) {
  if (!email) return false;
  if (adminEmails.has(email)) return true;
  const user = await getUserFromFirestore(email);
  return user && user.isAdmin === true;
}

async function promoteAdmin(email) {
  adminEmails.add(email);
  try { await db.collection('admins').doc(email).set({ email }); } catch (e) {}
  const user = await getUserFromFirestore(email);
  if (user) { user.isAdmin = true; await setUserInFirestore(email, user); }
}

// ========== CARREGAR USUÁRIOS ==========
async function loadAllUsers() {
  try {
    const snapshot = await db.collection('users').get();
    snapshot.forEach(doc => { users.set(doc.id, doc.data()); });
    console.log(`✅ ${users.size} usuários carregados do Firestore.`);
  } catch (e) {}
}
loadAllUsers();

rooms.set('lounge', createRoom('lounge', 'Lounge Sonora', 'Sistema'));
console.log('✅ Sala inicial "lounge" criada com sucesso!');

// ========== FUNÇÕES AUXILIARES ==========
function getPosition(room) {
  const track = room.queue[room.currentIndex];
  if (!track) return 0;
  return Math.min((Date.now() - room.startedAt) / 1000, track.duration || 180);
}
function broadcastState(slug) {
  const room = rooms.get(slug);
  if (!room) return;
  io.to(slug).emit('roomState', {
    slug: room.slug, name: room.name,
    currentIndex: room.currentIndex,
    position: getPosition(room),
    votes: room.votes,
    queue: room.queue,
    waitingQueue: room.waitingQueue,
    admin: room.admin,
    isPlaying: room.isPlaying,
    history: room.history.slice(-10),
    radioMode: room.radioMode,
    pinnedMessage: room.pinnedMessage,
    listenerCount: room.listenerCount,
    maxListeners: settings.maxListeners,
    color: room.color,
    inviteCount: room.inviteCount,
    eventStartTime: room.eventStartTime,
  });
}
function broadcastUsers(slug) {
  io.in(slug).fetchSockets().then(sockets => {
    const userList = sockets.map(s => ({
      name: s.userName || 'Anônimo', color: s.userColor || '#888', isAdmin: s.isAdmin || false, avatar: s.userAvatar || '👤',
      points: userPoints.get(s.userEmail)?.points || 0, badges: userPoints.get(s.userEmail)?.badges || [],
    }));
    io.to(slug).emit('users', userList);
  });
}
function addSystemMsg(slug, text) {
  const room = rooms.get(slug);
  if (!room) return;
  const msg = { _id: Date.now().toString() + Math.random(), user: 'Sistema', text, color: '#888', isSystem: true, createdAt: new Date() };
  room.chatHistory.push(msg);
  if (room.chatHistory.length > 300) room.chatHistory.shift();
  io.to(slug).emit('chat', msg);
}

function generateItemId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function autoShuffle(room) {
  if (!room || room.queue.length <= 1) return;
  const current = room.queue[room.currentIndex];
  if (!current) return;
  const rest = room.queue.filter((_, i) => i !== room.currentIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  room.queue = [current, ...rest];
  room.currentIndex = 0;
  const votes = getRoomVotes(room.slug);
  const newVotes = {};
  room.queue.forEach((track, idx) => {
    const oldIndex = room.queue.findIndex(t => t._id === track._id);
    if (votes[oldIndex] !== undefined) newVotes[idx] = votes[oldIndex];
  });
  roomVotes.set(room.slug, newVotes);
  broadcastState(room.slug);
}

function advanceQueue(slug) {
  const room = rooms.get(slug);
  if (!room || !room.isPlaying || room.queue.length === 0) {
    if (room && room.waitingQueue.length > 0) {
      const next = room.waitingQueue.shift();
      room.queue.push(next);
      if (!room.isPlaying) {
        room.isPlaying = true;
        room.currentIndex = 0;
        room.startedAt = Date.now();
        room.lastAdvanceAt = Date.now();
        addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
        broadcastState(slug);
        return true;
      }
    }
    return false;
  }
  if (Date.now() - room.lastAdvanceAt < 10000) return false;
  room.lastAdvanceAt = Date.now();
  const current = room.queue[room.currentIndex];
  if (current) { room.history.push(current); if (room.history.length > 50) room.history.shift(); updateMostVoted(room, current); }
  room.queue.shift();
  room.currentIndex = 0;
  room.startedAt = Date.now();
  room.votes = { up: Math.floor(Math.random() * 8) + 1, down: 0 };
  room.skipVotes = new Set();
  if (room.queue.length === 0 && room.waitingQueue.length > 0) {
    const next = room.waitingQueue.shift();
    room.queue.push(next);
    addSystemMsg(slug, `📥 Música da fila de espera: ${next.title} — ${next.artist}`);
  }
  const votes = getRoomVotes(slug);
  const newVotes = {};
  room.queue.forEach((_, i) => { if (votes[i + 1]) newVotes[i] = votes[i + 1]; });
  roomVotes.set(slug, newVotes);
  autoShuffle(room);
  broadcastState(slug);
  if (room.queue.length > 0) {
    const next = room.queue[0];
    addSystemMsg(slug, `▶ ${next.title} — ${next.artist}`);
  } else {
    if (room.radioMode) { startRadio(slug); }
    else { room.isPlaying = false; broadcastState(slug); addSystemMsg(slug, '🏁 Fila encerrada. Adicione músicas!'); io.to(slug).emit('queueEmpty'); }
  }
  return true;
}

async function startRadio(slug) {
  const room = rooms.get(slug);
  if (!room || !room.radioMode) return;
  if (!YOUTUBE_API_KEY) {
    addSystemMsg(slug, '⚠️ API Key do YouTube não configurada. Rádio desativado.');
    room.isPlaying = false;
    broadcastState(slug);
    return;
  }
  try {
    let query = room.radioGenre || 'pop';
    if (room.history.length > 0) { const last = room.history[room.history.length - 1]; if (last && last.title) query = last.title + ' ' + (last.artist || ''); }
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Erro na busca');
    const data = await response.json();
    const items = data.items.map(item => ({ 
      _id: generateItemId(),
      id: item.id.videoId, 
      title: item.snippet.title, 
      artist: item.snippet.channelTitle, 
      duration: null,
      dj: '🎧 Rádio'
    }));
    for (const song of items) { if (room.queue.length >= settings.maxQueue) break; room.queue.push(song); }
    if (room.queue.length > 0) { room.isPlaying = true; room.currentIndex = 0; room.startedAt = Date.now(); room.lastAdvanceAt = Date.now(); const next = room.queue[0]; addSystemMsg(slug, `📻 Rádio automático: ▶ ${next.title} — ${next.artist}`); broadcastState(slug); }
  } catch (e) { console.error('Erro no modo rádio:', e.message); addSystemMsg(slug, '⚠️ Erro ao buscar músicas para o rádio.'); room.isPlaying = false; broadcastState(slug); }
}

setInterval(() => {
  for (const [slug, room] of rooms) {
    if (!room.isPlaying || room.queue.length === 0) continue;
    const track = room.queue[room.currentIndex];
    if (!track) continue;
    const pos = getPosition(room);
    const duration = track.duration || 180;
    if (pos >= duration - 2) advanceQueue(slug);
  }
}, 2000);

function updateMostVoted(room, track) {
  const upVotes = room.votes?.up || 0;
  if (upVotes > 0) {
    const entry = room.mostVoted.find(t => t.id === track.id);
    if (entry) { entry.votes += upVotes; } else { room.mostVoted.push({ id: track.id, title: track.title, artist: track.artist, votes: upVotes }); }
    room.mostVoted.sort((a, b) => b.votes - a.votes);
    if (room.mostVoted.length > 20) room.mostVoted.pop();
  }
}

async function sendDiscordWebhook(webhookUrl, message) {
  if (!webhookUrl) return;
  try { await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }) }); } catch (e) {}
}

// ========== MIDDLEWARE DE AUTENTICAÇÃO ==========
async function authenticate(req, res, next) {
  const token = req.cookies.sessionToken;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  const email = sessions.get(token);
  if (!email) return res.status(401).json({ error: 'Sessão inválida' });
  req.userEmail = email;
  next();
}

// ========== ROTAS ==========
app.post('/api/signup', async (req, res) => {
  const { nome, email, senha, estilos } = req.body;
  if (!nome || nome.length < 2) return res.status(400).json({ error: 'Nome inválido' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'E-mail inválido' });
  if (!senha || senha.length < 6) return res.status(400).json({ error: 'Senha deve ter 6+ caracteres' });
  if (!estilos || estilos.length === 0) return res.status(400).json({ error: 'Escolha um estilo' });

  try {
    const existing = await db.collection('users').doc(email).get();
    if (existing.exists) return res.status(400).json({ error: 'E-mail já cadastrado' });

    const userData = { nome, email, estilos, avatar: '🎸', criadoEm: new Date(), theme: 'dark', fontSize: 16, colorblind: false, discordWebhook: null };
    await setUserInFirestore(email, userData);
    users.set(email, userData);
    await setPointsInFirestore(email, { points: 0, badges: [] });
    userPoints.set(email, { points: 0, badges: [] });
    await setFavoritesInFirestore(email, []);
    userFavorites.set(email, []);
    res.json({ success: true, nome, email });
  } catch (e) { console.error('Erro no signup:', e.message); res.status(500).json({ error: 'Erro ao salvar dados no Firestore: ' + e.message }); }
});

// ROTA DE LOGIN CORRIGIDA (cria usuário automaticamente se não existir)
app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email) return res.status(400).json({ error: 'Preencha e-mail' });

  try {
    let userData = await getUserFromFirestore(email);
    
    // Se não existir, cria um registro básico automaticamente
    if (!userData) {
      console.log(`⚠️ Usuário ${email} autenticado mas não encontrado no Firestore. Criando...`);
      const nome = email.split('@')[0] || 'Usuário';
      const estilos = ['pop'];
      const newUser = { 
        nome, 
        email, 
        estilos, 
        avatar: '🎸', 
        criadoEm: new Date(), 
        theme: 'dark',
        fontSize: 16,
        colorblind: false
      };
      await setUserInFirestore(email, newUser);
      users.set(email, newUser);
      await setPointsInFirestore(email, { points: 0, badges: [] });
      userPoints.set(email, { points: 0, badges: [] });
      await setFavoritesInFirestore(email, []);
      userFavorites.set(email, []);
      userData = newUser;
    }

    const token = crypto.randomBytes(64).toString('hex');
    sessions.set(token, email);
    res.cookie('sessionToken', token, { 
      httpOnly: true, 
      maxAge: 7 * 24 * 60 * 60 * 1000, 
      sameSite: 'lax', 
      path: '/' 
    });

    const points = await getPointsFromFirestore(email);
    const isAdmin = await isAdmin(email);
    res.json({ 
      success: true, 
      user: { 
        ...userData, 
        points: points.points, 
        badges: points.badges, 
        isAdmin 
      } 
    });
  } catch (e) {
    console.error('Erro no login:', e.message);
    res.status(500).json({ error: 'Erro interno ao fazer login. Tente novamente.' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies.sessionToken;
  if (token) sessions.delete(token);
  res.clearCookie('sessionToken');
  res.json({ success: true });
});

app.get('/api/me', authenticate, async (req, res) => {
  const email = req.userEmail;
  const userData = users.get(email) || await getUserFromFirestore(email);
  if (!userData) { sessions.delete(req.cookies.sessionToken); return res.status(401).json({ error: 'Usuário não encontrado' }); }
  const points = userPoints.get(email) || await getPointsFromFirestore(email);
  const isAdmin = await isAdmin(email);
  res.json({ success: true, user: { ...userData, points: points.points, badges: points.badges, isAdmin } });
});

// ========== SALAS ==========
app.get('/api/rooms', (req, res) => {
  try {
    const list = Array.from(rooms.values()).map(r => ({
      slug: r.slug, name: r.name, listenerCount: r.listenerCount,
      queueLength: r.queue.length, isPlaying: r.isPlaying,
      currentTrack: r.queue[r.currentIndex] || null,
      radioMode: r.radioMode, color: r.color || '#7c3aed',
      inviteCount: r.inviteCount, eventStartTime: r.eventStartTime,
    }));
    res.json(list);
  } catch (e) { console.error('Erro na rota /api/rooms:', e.message); res.status(500).json({ error: 'Erro interno ao listar salas' }); }
});

app.post('/api/rooms', authenticate, (req, res) => {
  const { name, adminName, color } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Nome inválido' });
  const slug = name.trim().toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36);
  if (rooms.has(slug)) return res.status(400).json({ error: 'Sala já existe' });
  const room = createRoom(slug, name.trim(), adminName || 'Anônimo');
  if (color) room.color = color;
  rooms.set(slug, room);
  res.json({ slug, name: room.name });
});

app.get('/api/rooms/random', (req, res) => {
  const roomList = Array.from(rooms.values());
  if (roomList.length === 0) return res.status(404).json({ error: 'Nenhuma sala disponível' });
  const randomRoom = roomList[Math.floor(Math.random() * roomList.length)];
  res.json({ slug: randomRoom.slug });
});

app.get('/api/room/:slug/queue', (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({ queue: room.queue, currentIndex: room.currentIndex });
});

app.get('/api/room/:slug/stats', (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  res.json({ mostVoted: room.mostVoted.slice(0, 10) });
});

app.post('/api/room/:slug/invite', authenticate, (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  room.inviteCount = (room.inviteCount || 0) + 1;
  res.json({ success: true });
});

app.post('/api/room/:slug/webhook', authenticate, (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  room.discordWebhook = req.body.webhookUrl || null;
  res.json({ success: true });
});

app.post('/api/room/:slug/event', authenticate, (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  room.eventStartTime = req.body.startTime || null;
  broadcastState(req.params.slug);
  res.json({ success: true });
});

// ========== FAVORITOS ==========
app.get('/api/favorites', authenticate, async (req, res) => {
  const email = req.userEmail;
  const favs = await getFavoritesFromFirestore(email);
  res.json(favs);
});

app.post('/api/favorites', authenticate, async (req, res) => {
  const email = req.userEmail;
  const { videoId, title, artist } = req.body;
  if (!videoId) return res.status(400).json({ error: 'ID do vídeo necessário' });
  let favs = await getFavoritesFromFirestore(email);
  if (!favs.find(f => f.id === videoId)) {
    favs.push({ id: videoId, title: title || 'Música', artist: artist || 'Desconhecido' });
    await setFavoritesInFirestore(email, favs);
    userFavorites.set(email, favs);
  }
  res.json({ success: true });
});

app.delete('/api/favorites/:id', authenticate, async (req, res) => {
  const email = req.userEmail;
  const id = req.params.id;
  let favs = await getFavoritesFromFirestore(email);
  favs = favs.filter(f => f.id !== id);
  await setFavoritesInFirestore(email, favs);
  userFavorites.set(email, favs);
  res.json({ success: true });
});

// ========== AVATAR ==========
app.post('/api/update-avatar', authenticate, async (req, res) => {
  const email = req.userEmail;
  const { avatar } = req.body;
  if (!avatar) return res.status(400).json({ error: 'Avatar necessário' });
  const userData = users.get(email) || await getUserFromFirestore(email);
  if (!userData) return res.status(404).json({ error: 'Usuário não encontrado' });
  userData.avatar = avatar;
  await setUserInFirestore(email, userData);
  users.set(email, userData);
  res.json({ success: true });
});

// ========== ADMIN ROTAS ==========
app.get('/api/admin/stats', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  try {
    const snapshot = await db.collection('users').get();
    const totalUsers = snapshot.size;
    const totalRooms = rooms.size;
    const onlineUsers = (await io.fetchSockets()).length;
    res.json({ totalUsers, totalRooms, onlineUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  try {
    const snapshot = await db.collection('users').get();
    const usersList = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      usersList.push({ email: doc.id, nome: data.nome, isAdmin: adminEmails.has(doc.id) });
    });
    res.json(usersList);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/promote', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  await promoteAdmin(email);
  res.json({ success: true });
});

app.post('/api/admin/delete-user', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  try {
    await db.collection('users').doc(email).delete();
    await db.collection('favorites').doc(email).delete();
    await db.collection('points').doc(email).delete();
    users.delete(email);
    userPoints.delete(email);
    userFavorites.delete(email);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/kick-user', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  const { email, roomSlug } = req.body;
  if (!email || !roomSlug) return res.status(400).json({ error: 'Dados incompletos' });
  const room = rooms.get(roomSlug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  io.in(roomSlug).fetchSockets().then(sockets => {
    for (const socket of sockets) {
      if (socket.userEmail === email) {
        socket.emit('kicked', 'Você foi expulso da sala pelo admin.');
        socket.leave(roomSlug);
        room.listenerCount = Math.max(0, room.listenerCount - 1);
        broadcastState(roomSlug);
        broadcastUsers(roomSlug);
        res.json({ success: true });
        return;
      }
    }
    res.status(404).json({ error: 'Usuário não está na sala' });
  });
});

app.post('/api/admin/ban-user', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email necessário' });
  const userData = await getUserFromFirestore(email);
  if (!userData) return res.status(404).json({ error: 'Usuário não encontrado' });
  userData.banned = true;
  await setUserInFirestore(email, userData);
  io.fetchSockets().then(sockets => {
    for (const socket of sockets) {
      if (socket.userEmail === email) {
        socket.emit('banned', 'Você foi banido do Sonora Fan.');
        socket.disconnect();
      }
    }
  });
  res.json({ success: true });
});

app.post('/api/admin/remove-song', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  const { roomSlug, index } = req.body;
  if (roomSlug === undefined || index === undefined) return res.status(400).json({ error: 'Dados incompletos' });
  const room = rooms.get(roomSlug);
  if (!room) return res.status(404).json({ error: 'Sala não encontrada' });
  if (index < 0 || index >= room.queue.length) return res.status(400).json({ error: 'Índice inválido' });
  const removed = room.queue.splice(index, 1)[0];
  if (index < room.currentIndex) room.currentIndex--;
  const votes = getRoomVotes(roomSlug);
  const newVotes = {};
  room.queue.forEach((_, i) => { if (votes[i + 1]) newVotes[i] = votes[i + 1]; });
  roomVotes.set(roomSlug, newVotes);
  broadcastState(roomSlug);
  addSystemMsg(roomSlug, `🗑️ "${removed.title}" removida pelo admin.`);
  res.json({ success: true });
});

app.post('/api/admin/clear-all-chats', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  for (const [slug, room] of rooms) {
    room.chatHistory = [];
    roomLikes.set(slug, {});
    io.to(slug).emit('chatCleared');
  }
  res.json({ success: true });
});

app.post('/api/admin/clear-all-rooms', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  for (const [slug, room] of rooms) {
    if (slug === 'lounge') continue;
    io.to(slug).emit('roomClosed', 'Sala removida pelo admin.');
    rooms.delete(slug);
    roomLikes.delete(slug);
    roomVotes.delete(slug);
    waitingRooms.delete(slug);
  }
  res.json({ success: true });
});

app.get('/api/admin/export-data', authenticate, async (req, res) => {
  if (!(await isAdmin(req.userEmail))) return res.status(403).json({ error: 'Acesso negado' });
  const data = {
    users: Array.from(users.values()),
    rooms: Array.from(rooms.values()).map(r => ({ ...r, lastAddTime: undefined, skipVotes: undefined })),
    favorites: Array.from(userFavorites.entries()),
    points: Array.from(userPoints.entries()),
    settings,
  };
  res.json(data);
});

// ========== API DO YOUTUBE ==========
app.get('/api/search-youtube', async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 2) return res.json({ items: [] });
  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({ error: 'API Key do YouTube não configurada', items: [] });
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const items = data.items.map(item => ({ id: item.id.videoId, title: item.snippet.title, artist: item.snippet.channelTitle, thumb: item.snippet.thumbnails.default.url }));
    res.json({ items });
  } catch (e) { console.error('Erro na busca do YouTube:', e.message); res.status(500).json({ error: 'Erro ao buscar vídeos: ' + e.message, items: [] }); }
});

function fetchUrl(url, maxSize = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = ''; let size = 0;
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        size += Buffer.byteLength(chunk);
        if (size > maxSize) {
          req.destroy(new Error('Response too large'));
        }
      });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

app.get('/api/video-info', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ error: 'ID inválido' });
  const info = { id, title: null, artist: null, duration: null };
  try {
    const raw = await fetchUrl(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`);
    const data = JSON.parse(raw); info.title = data.title || null; info.artist = data.author_name || null;
  } catch (e) {}
  try {
    const html = await fetchUrl(`https://www.youtube.com/watch?v=${id}`);
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try { const jsonLd = JSON.parse(jsonLdMatch[1]); if (jsonLd.duration) { const match = jsonLd.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); if (match) { info.duration = (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0); } } } catch (e) {}
    }
    if (!info.duration) {
      const playerResponseMatch = html.match(/var ytInitialPlayerResponse\s*=\s*({[\s\S]*?});/);
      if (playerResponseMatch) { try { const data = JSON.parse(playerResponseMatch[1]); if (data.videoDetails && data.videoDetails.lengthSeconds) info.duration = parseInt(data.videoDetails.lengthSeconds, 10); } catch (e) {} }
    }
    if (!info.title) { const titleMatch = html.match(/<title>([^<]+)<\/title>/); if (titleMatch) info.title = titleMatch[1].replace(/ - YouTube\s*$/, '').trim(); }
  } catch (e) {}
  if (!info.title) info.title = 'Vídeo do YouTube (ID: ' + id + ')';
  res.json(info);
});

// ========== SOCKET ==========
io.on('connection', (socket) => {
  let currentRoom = null;
  let userEmail = null;

  socket.on('joinRoom', async ({ slug, name, avatar }) => {
    try {
      const room = rooms.get(slug);
      if (!room) { socket.emit('error', 'Sala não encontrada'); return; }
      if (room.bannedUsers.includes(name)) { socket.emit('error', 'Você foi banido'); return; }
      if (room.listenerCount >= settings.maxListeners) {
        if (!waitingRooms.has(slug)) waitingRooms.set(slug, []);
        waitingRooms.get(slug).push(socket);
        socket.emit('waitingRoom', { position: waitingRooms.get(slug).length, maxListeners: settings.maxListeners });
        return;
      }
      if (currentRoom) {
        socket.leave(currentRoom);
        const old = rooms.get(currentRoom);
        if (old) old.listenerCount = Math.max(0, old.listenerCount - 1);
      }
      currentRoom = slug;
      socket.join(slug);
      socket.userName = name;
      socket.userColor = colors[Math.floor(Math.random() * colors.length)];
      socket.userAvatar = avatar || '👤';
      room.listenerCount++;
      const cookie = socket.handshake.headers.cookie || '';
      const tokenMatch = cookie.match(/sessionToken=([^;]+)/);
      const email = tokenMatch ? sessions.get(tokenMatch[1]) : null;
      userEmail = email;
      socket.userEmail = email;
      const isGlobalAdmin = email ? await isAdmin(email) : false;
      const isRoomAdmin = room.admin === name;
      socket.isAdmin = isGlobalAdmin || isRoomAdmin;
      if (isGlobalAdmin && !room.admin) room.admin = name;
      notifyNextWaiting(slug);

      socket.emit('likesState', getRoomLikes(slug));
      socket.emit('votesState', getRoomVotes(slug));

      socket.emit('roomState', {
        slug: room.slug, name: room.name, currentIndex: room.currentIndex,
        position: getPosition(room), votes: room.votes, queue: room.queue, waitingQueue: room.waitingQueue,
        admin: room.admin, isPlaying: room.isPlaying, history: room.history.slice(-10), radioMode: room.radioMode,
        pinnedMessage: room.pinnedMessage, listenerCount: room.listenerCount, maxListeners: settings.maxListeners,
        color: room.color, inviteCount: room.inviteCount, eventStartTime: room.eventStartTime,
      });
      socket.emit('chatHistory', room.chatHistory.slice(-150));
      socket.emit('isAdmin', socket.isAdmin);
      socket.emit('userPoints', userPoints.get(email) || { points: 0, badges: [] });
      broadcastUsers(slug);
    } catch (e) {
      console.error('Erro no joinRoom:', e.message);
      socket.emit('error', 'Erro ao entrar na sala.');
    }
  });

  function notifyNextWaiting(slug) {
    const waiting = waitingRooms.get(slug) || [];
    if (waiting.length === 0) return;
    const room = rooms.get(slug);
    if (!room) return;
    if (room.listenerCount < settings.maxListeners) {
      const nextSocket = waiting.shift();
      if (nextSocket) nextSocket.emit('waitingRoom', { position: 0, maxListeners: settings.maxListeners, canJoin: true });
    }
  }

  socket.on('chat', ({ text }) => {
    try {
      if (!currentRoom || !text.trim()) return;
      const room = rooms.get(currentRoom);
      const parts = text.trim().split(' ');
      const command = parts[0].toLowerCase();
      if (command.startsWith('/')) { handleCommand(socket, command, parts.slice(1), room); return; }
      const msg = { _id: Date.now().toString() + Math.random(), user: socket.userName, text: text.trim(), color: socket.userColor, isSystem: false, isAdmin: socket.isAdmin || false, avatar: socket.userAvatar || '👤', createdAt: new Date() };
      room.chatHistory.push(msg);
      if (room.chatHistory.length > 300) room.chatHistory.shift();
      io.to(currentRoom).emit('chat', msg);
    } catch (e) { console.error('Erro no chat:', e.message); }
  });

  async function handleCommand(socket, cmd, args, room) {
    const email = socket.userEmail;
    let reply = '';
    switch(cmd) {
      case '/stats':
        let stats = '📊 Estatísticas da sala:\n'; const userCounts = {};
        room.queue.forEach(t => { const dj = t.dj || 'Desconhecido'; userCounts[dj] = (userCounts[dj] || 0) + 1; });
        Object.entries(userCounts).sort((a,b) => b[1] - a[1]).forEach(([user, count]) => { stats += `  ${user}: ${count} música(s)\n`; });
        stats += `Total: ${room.queue.length} músicas | Histórico: ${room.history.length}`;
        socket.emit('chat', { _id: Date.now().toString() + Math.random(), user: 'Sistema', text: stats, color: '#888', isSystem: true, createdAt: new Date() });
        break;
      case '/vote':
        if (room.queue.length === 0) { reply = 'Nenhuma música na fila.'; break; }
        const track = room.queue[room.currentIndex]; if (!track) { reply = 'Nenhuma música tocando.'; break; }
        const votes = getRoomVotes(room.slug); if (!votes[room.currentIndex]) votes[room.currentIndex] = { up: [], down: [] };
        const data = votes[room.currentIndex];
        if (!data.up.includes(socket.userName)) {
          data.up.push(socket.userName); const downIdx = data.down.indexOf(socket.userName);
          if (downIdx > -1) data.down.splice(downIdx, 1);
          addPoints(email, 1); reply = '👍 Você votou na música atual!';
          io.to(currentRoom).emit('voteUpdate', { index: room.currentIndex, up: data.up, down: data.down }); broadcastState(currentRoom);
        } else { reply = 'Você já votou nessa música.'; }
        break;
      case '/clear':
        if (!socket.isAdmin) { reply = 'Apenas admin pode limpar o chat.'; break; }
        room.chatHistory = []; roomLikes.set(currentRoom, {}); io.to(currentRoom).emit('chatCleared'); addSystemMsg(currentRoom, '🧹 Chat limpo pelo admin');
        reply = 'Chat limpo.';
        break;
      case '/me':
        const p = userPoints.get(email) || { points: 0, badges: [] };
        reply = `👤 ${socket.userName} | Pontos: ${p.points} | Badges: ${p.badges.join(', ') || 'Nenhum'}`;
        break;
      case '/history':
        if (room.history.length === 0) { reply = 'Nenhuma música no histórico.'; break; }
        let hist = '📜 Histórico:\n';
        room.history.slice(-5).forEach((t, i) => { hist += `  ${i+1}. ${t.title} — ${t.artist}\n`; });
        socket.emit('chat', { _id: Date.now().toString() + Math.random(), user: 'Sistema', text: hist, color: '#888', isSystem: true, createdAt: new Date() });
        return;
      default:
        reply = `Comando desconhecido: ${cmd}. Use /stats, /vote, /clear (admin), /me, /history`;
    }
    if (reply) socket.emit('chat', { _id: Date.now().toString() + Math.random(), user: 'Sistema', text: reply, color: '#888', isSystem: true, createdAt: new Date() });
  }

  async function addPoints(email, amount) {
    if (!email) return;
    const p = userPoints.get(email) || await getPointsFromFirestore(email);
    p.points += amount;
    if (p.points >= 10 && !p.badges.includes('DJ Iniciante')) p.badges.push('DJ Iniciante');
    if (p.points >= 50 && !p.badges.includes('DJ Expert')) p.badges.push('DJ Expert');
    if (p.points >= 100 && !p.badges.includes('DJ Lendário')) p.badges.push('DJ Lendário');
    userPoints.set(email, p); await setPointsInFirestore(email, p);
    for (const [id, s] of io.sockets.sockets) { if (s.userEmail === email) s.emit('userPoints', p); }
  }

  socket.on('voteSkip', async () => {
    try {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      if (room.queue.length === 0) return;
      const isAdmin = socket.isAdmin || (socket.userEmail && await isAdmin(socket.userEmail));
      if (isAdmin) { advanceQueue(currentRoom); addSystemMsg(currentRoom, `⏭️ ${socket.userName} pulou a música (admin)`); return; }
      if (room.skipVotes.has(socket.userName)) { socket.emit('error', 'Você já votou para pular.'); return; }
      room.skipVotes.add(socket.userName);
      const totalListeners = room.listenerCount || 1;
      const minVotes = Math.max(MIN_SKIP_VOTES, Math.ceil(totalListeners * SKIP_VOTE_THRESHOLD));
      const currentVotes = room.skipVotes.size;
      io.to(currentRoom).emit('skipVoteUpdate', { votes: currentVotes, needed: minVotes });
      addSystemMsg(currentRoom, `🗳️ ${socket.userName} votou para pular (${currentVotes}/${minVotes})`);
      if (currentVotes >= minVotes) { addSystemMsg(currentRoom, `⏭️ Música pulada por votação! (${currentVotes} votos)`); advanceQueue(currentRoom); room.skipVotes = new Set(); }
    } catch (e) { console.error('Erro no voteSkip:', e.message); }
  });

  socket.on('addSong', (song) => {
    try {
      if (!currentRoom) return;
      const room = rooms.get(currentRoom);
      const now = Date.now();
      const lastAdd = room.lastAddTime.get(socket.userName) || 0;
      if (now - lastAdd < 30000) { const wait = Math.ceil((30000 - (now - lastAdd)) / 1000); socket.emit('error', `Aguarde ${wait}s`); return; }
      const userSongs = room.queue.filter(t => t.dj === socket.userName).length + room.waitingQueue.filter(t => t.dj === socket.userName).length;
      if (userSongs >= MAX_SONGS_PER_USER) { socket.emit('error', `Você já tem ${MAX_SONGS_PER_USER} músicas na fila/espera. Aguarde outras serem tocadas.`); return; }
      const isQueueFull = room.queue.length >= settings.maxQueue;
      if (isQueueFull) {
        if (room.waitingQueue.length >= settings.maxQueue) { socket.emit('error', `Fila de espera cheia (${settings.maxQueue})`); return; }
        song._id = generateItemId();
        song.dj = socket.userName; room.waitingQueue.push(song); room.lastAddTime.set(socket.userName, now); addPoints(socket.userEmail, 1);
        io.to(currentRoom).emit('playSound', 'waiting');
        addSystemMsg(currentRoom, `⏳ "${song.title}" entrou na fila de espera (${room.waitingQueue.length} músicas aguardando)`);
        broadcastState(currentRoom);
        return;
      }
      if (song.duration && song.duration > settings.maxDuration) { socket.emit('error', `⛔ Vídeo muito longo! Duração: ${Math.floor(song.duration / 60)} min. Limite: ${settings.maxDuration / 60} min.`); return; }
      song._id = generateItemId();
      song.dj = socket.userName; room.queue.push(song); room.lastAddTime.set(socket.userName, now); addPoints(socket.userEmail, 2);
      room.totalSongsAdded = (room.totalSongsAdded || 0) + 1;
      if (!room.isPlaying && room.queue.length === 1) { room.isPlaying = true; room.currentIndex = 0; room.startedAt = Date.now(); room.lastAdvanceAt = Date.now(); addSystemMsg(currentRoom, `▶ ${song.title} — ${song.artist}`); }
      else { autoShuffle(room); }
      broadcastState(currentRoom);
      if (room.discordWebhook) { const msg = `🎵 **${song.title}** por ${song.artist} foi adicionada por ${socket.userName} na sala **${room.name}**`; sendDiscordWebhook(room.discordWebhook, msg); }
      const musicMsg = { _id: Date.now().toString() + Math.random(), user: socket.userName, color: socket.userColor, isSystem: false, isAdmin: socket.isAdmin || false, isMusic: true, musicTitle: song.title, musicArtist: song.artist, createdAt: new Date() };
      room.chatHistory.push(musicMsg);
      if (room.chatHistory.length > 300) room.chatHistory.shift();
      io.to(currentRoom).emit('chat', musicMsg);
    } catch (e) {
      console.error('❌ CRASH AO ADICIONAR MÚSICA:', e.message);
      socket.emit('error', 'Erro interno ao adicionar música. Verifique os logs.');
    }
  });

  socket.on('likeMessage', ({ messageId, room }) => {
    try {
      if (!room || !socket.userName) return;
      const likes = getRoomLikes(room);
      if (!likes[messageId]) likes[messageId] = { likes: 0, users: [] };
      const data = likes[messageId];
      const userIndex = data.users.indexOf(socket.userName);
      if (userIndex > -1) { data.users.splice(userIndex, 1); data.likes = Math.max(0, data.likes - 1); }
      else { data.users.push(socket.userName); data.likes++; addPoints(socket.userEmail, 1); io.to(room).emit('playSound', 'like'); }
      io.to(room).emit('likeUpdate', { messageId, likes: data.likes, users: data.users });
    } catch (e) { console.error('Erro no like:', e.message); }
  });

  socket.on('videoDuration', ({ duration }) => {
    try {
      if (!currentRoom || !duration) return;
      const room = rooms.get(currentRoom);
      const track = room.queue[room.currentIndex];
      if (!track) return;
      track.duration = duration;
      if (duration > settings.maxDuration) {
        room.queue.shift(); room.currentIndex = 0; room.isPlaying = false; room.startedAt = Date.now();
        addSystemMsg(currentRoom, `⛔ A música "${track.title}" foi removida automaticamente por ser muito longa (${Math.floor(duration / 60)} min). Limite: ${settings.maxDuration / 60} min.`);
        const votes = getRoomVotes(currentRoom); const newVotes = {};
        room.queue.forEach((_, i) => { if (votes[i + 1]) newVotes[i] = votes[i + 1]; });
        roomVotes.set(currentRoom, newVotes); broadcastState(currentRoom); io.to(currentRoom).emit('queueEmpty');
        return;
      }
      broadcastState(currentRoom);
    } catch (e) { console.error('Erro no videoDuration:', e.message); }
  });

  socket.on('reorderQueue', async (newOrder) => {
    try {
      if (!currentRoom) { socket.emit('error', 'Você não está em uma sala'); return; }
      const isAdmin = socket.isAdmin || (socket.userEmail && await isAdmin(socket.userEmail));
      if (!isAdmin) { socket.emit('error', 'Apenas admin pode reordenar'); return; }
      const room = rooms.get(currentRoom);
      if (!room || room.queue.length === 0) return;
      const currentTrack = room.queue[room.currentIndex]; const currentId = currentTrack ? currentTrack._id : null;
      const newQueue = [];
      for (const id of newOrder) { const track = room.queue.find(t => t._id === id); if (track) newQueue.push(track); }
      if (newQueue.length === room.queue.length) {
        room.queue = newQueue;
        const newIndex = room.queue.findIndex(t => t._id === currentId);
        room.currentIndex = newIndex !== -1 ? newIndex : 0;
        const votes = getRoomVotes(currentRoom); const newVotes = {};
        room.queue.forEach((track, i) => { const oldIndex = room.queue.indexOf(track); if (votes[oldIndex]) newVotes[i] = votes[oldIndex]; });
        roomVotes.set(currentRoom, newVotes); broadcastState(currentRoom);
      }
    } catch (e) { console.error('Erro no reorder:', e.message); }
  });

  socket.on('voteSong', ({ index, type, room }) => {
    try {
      if (!room || !socket.userName) return;
      const roomData = rooms.get(room);
      if (!roomData) return;
      if (roomData.currentIndex === index) { socket.emit('error', 'Não é possível votar na música atual'); return; }
      if (index >= roomData.queue.length) { socket.emit('error', 'Música não encontrada'); return; }
      const votes = getRoomVotes(room);
      if (!votes[index]) votes[index] = { up: [], down: [] };
      const data = votes[index];
      const upIndex = data.up.indexOf(socket.userName);
      if (upIndex > -1) data.up.splice(upIndex, 1);
      const downIndex = data.down.indexOf(socket.userName);
      if (downIndex > -1) data.down.splice(downIndex, 1);
      if (type === 'up') { data.up.push(socket.userName); addPoints(socket.userEmail, 1); roomData.totalVotesGiven = (roomData.totalVotesGiven || 0) + 1; }
      else if (type === 'down') data.down.push(socket.userName);
      if (data.down.length >= DISLIKE_THRESHOLD) {
        const removed = roomData.queue.splice(index, 1)[0];
        if (index < roomData.currentIndex) roomData.currentIndex--;
        delete votes[index];
        const newVotes = {};
        roomData.queue.forEach((_, i) => { if (votes[i + 1]) newVotes[i] = votes[i + 1]; });
        roomVotes.set(room, newVotes); autoShuffle(roomData); broadcastState(room); io.to(room).emit('voteUpdate', { index, up: data.up, down: data.down, removed: true });
        addSystemMsg(room, `👎 "${removed.title}" foi removida por votação! (${data.down.length} votos negativos)`);
        return;
      }
      if (type === 'up') autoShuffle(roomData);
      io.to(room).emit('voteUpdate', { index, up: data.up, down: data.down });
      broadcastState(room);
    } catch (e) { console.error('Erro no voteSong:', e.message); }
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) { room.listenerCount = Math.max(0, room.listenerCount - 1); broadcastState(currentRoom); broadcastUsers(currentRoom); notifyNextWaiting(currentRoom); }
    }
  });
});

// ========== ROTAS EXTRAS ==========
app.get('/invite/:slug', (req, res) => {
  const room = rooms.get(req.params.slug);
  if (!room) return res.status(404).send('Sala não encontrada');
  room.inviteCount = (room.inviteCount || 0) + 1;
  res.redirect('/?room=' + req.params.slug);
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
