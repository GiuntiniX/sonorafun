const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

// ===== PROTEÇÃO GLOBAL =====
process.on('uncaughtException', (err) => {
  console.error('🚨 Erro não capturado:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('🚨 Promise rejeitada:', reason);
});

// ===== FIREBASE =====
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
const db = admin.firestore();

// ===== APP =====
const app = express();
// ===== CORREÇÃO: confiar no proxy (necessário para rate-limit) =====
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ===== SEGURANÇA =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://www.gstatic.com",
        "https://www.youtube.com",
        "https://cdnjs.cloudflare.com",
        "https://cdn.jsdelivr.net",
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: [
        "'self'",
        "data:",
        "https://img.youtube.com",
        "https://encrypted-tbn0.gstatic.com",
        "https://upload.wikimedia.org",
        "https://img.magnific.com",
      ],
      connectSrc: [
        "'self'",
        "https://firestore.googleapis.com",
        "https://www.googleapis.com",
        "https://sonorafan-777-default-rtdb.firebaseio.com",
      ],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'self'", "https://www.youtube.com"],
      objectSrc: ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  xssFilter: true,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));

// Rate limiting com validação de IP desabilitada para evitar conflito com proxy
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Muitas requisições, tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { ip: false }, // <-- CORREÇÃO: desabilita validação de IP
});
app.use('/api/login', limiter);
app.use('/api/signup', limiter);
app.use('/api/me', limiter);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// ===== CONFIG =====
const colors = ['#f59e0b', '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#ec4899', '#06b6d4', '#f97316', '#8b5cf6', '#14b8a6'];
const adminEmails = new Set((process.env.ADMIN_EMAILS || 'admin@sonora.com').split(','));
const settings = { maxQueue: 20, cooldown: 30, maxDuration: 600, maxListeners: 20 };
const DISLIKE_THRESHOLD = 10;
const MAX_SONGS_PER_USER = 3;
const SKIP_VOTE_THRESHOLD = 0.5;
const MIN_SKIP_VOTES = 3;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// ===== ESTADO =====
const users = new Map();
const sessions = new Map();
const userFavorites = new Map();
const userPoints = new Map();
const userThemes = new Map();
const userSettings = new Map();
const rooms = new Map();
const roomLikes = new Map();
const roomVotes = new Map();
const waitingRooms = new Map();

// ===== FUNÇÕES DE APOIO =====
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}

function sanitizeRoom(room) {
  return {
    ...room,
    name: escapeHtml(room.name),
    queue: room.queue.map(t => ({ ...t, title: escapeHtml(t.title), artist: escapeHtml(t.artist), dj: escapeHtml(t.dj) })),
    waitingQueue: room.waitingQueue.map(t => ({ ...t, title: escapeHtml(t.title), artist: escapeHtml(t.artist), dj: escapeHtml(t.dj) })),
    admin: escapeHtml(room.admin),
    pinnedMessage: room.pinnedMessage ? { ...room.pinnedMessage, text: escapeHtml(room.pinnedMessage.text), author: escapeHtml(room.pinnedMessage.author) } : null,
    history: room.history.slice(-10).map(t => ({ ...t, title: escapeHtml(t.title), artist: escapeHtml(t.artist) })),
  };
}

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
    slug, name: escapeHtml(name), admin: escapeHtml(adminName || 'Sistema'),
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

// ===== FIREBASE HELPERS =====
async function getUserFromFirestore(email) { /* ... */ }
async function setUserInFirestore(email, data) { /* ... */ }
async function getFavoritesFromFirestore(email) { /* ... */ }
async function setFavoritesInFirestore(email, items) { /* ... */ }
async function getPointsFromFirestore(email) { /* ... */ }
async function setPointsInFirestore(email, data) { /* ... */ }
async function loadAllUsers() { /* ... */ }
loadAllUsers();

rooms.set('lounge', createRoom('lounge', 'Lounge Sonora', 'Sistema'));

// ===== FUNÇÕES DE SALA =====
function getPosition(room) { /* ... */ }
function broadcastState(slug) { /* ... */ }
function broadcastUsers(slug) { /* ... */ }
function addSystemMsg(slug, text) { /* ... */ }
function advanceQueue(slug) { /* ... */ }
function updateMostVoted(room, track) { /* ... */ }

// ===== ROTAS (mantidas as mesmas, com sanitização) =====
app.post('/api/signup', async (req, res) => { /* ... */ });
app.post('/api/login', async (req, res) => { /* ... */ });
app.post('/api/logout', (req, res) => { /* ... */ });
app.get('/api/me', async (req, res) => { /* ... */ });
app.get('/api/rooms', (req, res) => { /* ... */ });
app.post('/api/rooms', (req, res) => { /* ... */ });
app.get('/api/rooms/random', (req, res) => { /* ... */ });
app.get('/api/room/:slug/queue', (req, res) => { /* ... */ });
app.get('/api/room/:slug/stats', (req, res) => { /* ... */ });
app.post('/api/room/:slug/invite', (req, res) => { /* ... */ });
app.get('/api/favorites', async (req, res) => { /* ... */ });
app.post('/api/favorites', async (req, res) => { /* ... */ });
app.delete('/api/favorites/:id', async (req, res) => { /* ... */ });
app.post('/api/update-avatar', async (req, res) => { /* ... */ });
app.get('/api/admin/stats', async (req, res) => { /* ... */ });
app.get('/api/admin/users', async (req, res) => { /* ... */ });
app.post('/api/admin/promote', async (req, res) => { /* ... */ });
app.post('/api/admin/delete-user', async (req, res) => { /* ... */ });
app.post('/api/admin/kick-user', (req, res) => { /* ... */ });
app.post('/api/admin/ban-user', async (req, res) => { /* ... */ });
app.post('/api/admin/remove-song', (req, res) => { /* ... */ });
app.post('/api/admin/clear-all-chats', (req, res) => { /* ... */ });
app.post('/api/admin/clear-all-rooms', (req, res) => { /* ... */ });
app.get('/api/admin/export-data', (req, res) => { /* ... */ });
app.get('/api/search-youtube', async (req, res) => { /* ... */ });
app.get('/api/video-info', async (req, res) => { /* ... */ });

// ===== SOCKET.IO =====
io.on('connection', (socket) => { /* mesmo código, já seguro */ });

// ===== ROTAS EXTRAS =====
app.get('/invite/:slug', (req, res) => { /* ... */ });
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎧 Sonora Fan → http://localhost:${PORT}`));
