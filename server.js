require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: false
  }
});

const pvpRooms = new Map();

function createPvpRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('LỖI: Hãy tạo file .env và đặt JWT_SECRET dài ít nhất 32 ký tự.');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'gameverse.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    genre TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const gameColumns = db.prepare('PRAGMA table_info(games)').all();

if (!gameColumns.some(column => column.name === 'file_path')) {
  db.exec('ALTER TABLE games ADD COLUMN file_path TEXT');
}

if (!gameColumns.some(column => column.name === 'play_count')) {
  db.exec('ALTER TABLE games ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0');
}
const uploadGameFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ext === '.html' || ext === '.htm');
  }
});

app.use('/game-files', express.static(path.join(__dirname, 'uploads', 'games')));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.' }
});
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000
};
function makeToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });
}
function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email, createdAt: user.created_at };
}
function requireAuth(req, res, next) {
  const token = req.cookies.gv_token;
  if (!token) return res.status(401).json({ error: 'Bạn cần đăng nhập để thực hiện thao tác này.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Tài khoản không còn tồn tại.' });
    req.user = user;
    next();
  } catch {
    res.clearCookie('gv_token', { ...cookieOptions, maxAge: undefined });
    return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' });
  }
}

io.use((socket, next) => {
  const rawCookie = socket.handshake.headers.cookie || '';
  const match = rawCookie.match(/(?:^|;\s*)gv_token=([^;]+)/);

  if (!match) {
    return next(new Error('Bạn cần đăng nhập để chơi PVP.'));
  }

  try {
    const token = decodeURIComponent(match[1]);
    const payload = jwt.verify(token, JWT_SECRET);

    const user = db.prepare(
      'SELECT id, username FROM users WHERE id = ?'
    ).get(payload.sub);

    if (!user) {
      return next(new Error('Tài khoản không tồn tại.'));
    }

    socket.user = user;
    next();
  } catch {
    next(new Error('Phiên đăng nhập hết hạn. Hãy đăng nhập lại.'));
  }
});

function leavePvpRoom(socket) {
  const code = socket.data.pvpRoom;
  if (!code) return;

  const room = pvpRooms.get(code);
  socket.data.pvpRoom = null;
  socket.leave(code);

  if (!room) return;

  room.players = room.players.filter(
    player => player.socketId !== socket.id
  );

  if (room.players.length === 0) {
    pvpRooms.delete(code);
  } else {
    io.to(code).emit('pvp:players', {
      code,
      players: room.players.map(({ userId, username }) => ({
        userId,
        username
      })),
      status: 'waiting'
    });
  }
}

io.on('connection', socket => {
  socket.on('pvp:createRoom', callback => {
    if (socket.data.pvpRoom) {
      leavePvpRoom(socket);
    }

    let code;
    do {
      code = createPvpRoomCode();
    } while (pvpRooms.has(code));

const room = {
  code,
  hostId: socket.user.id,
  selectedGameId: null,
  players: [{
    socketId: socket.id,
    userId: socket.user.id,
    username: socket.user.username
  }]
};
    pvpRooms.set(code, room);
    socket.data.pvpRoom = code;
    socket.join(code);

    if (typeof callback === 'function') {
      callback({
        success: true,
        code,
        players: [{
          userId: socket.user.id,
          username: socket.user.username
        }],
        status: 'waiting'
      });
    }
  });

  socket.on('pvp:joinRoom', (rawCode, callback) => {
    const code = String(rawCode || '').trim().toUpperCase();
    const room = pvpRooms.get(code);

    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Phòng không tồn tại.' });
      }
      return;
    }

    if (socket.data.pvpRoom) {
      leavePvpRoom(socket);
    }

    if (room.players.length >= 2) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Phòng đã đủ 2 người.' });
      }
      return;
    }

    if (room.players.some(player => player.userId === socket.user.id)) {
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Bạn đã ở trong phòng này.' });
      }
      return;
    }

    room.players.push({
      socketId: socket.id,
      userId: socket.user.id,
      username: socket.user.username
    });

    socket.data.pvpRoom = code;
    socket.join(code);

    const players = room.players.map(({ userId, username }) => ({
      userId,
      username
    }));

    io.to(code).emit('pvp:players', {
      code,
      players,
      selectedGameId: room.selectedGameId,
      selectedGameName: room.selectedGameName || null,
      hostId: room.hostId,
      status: 'ready'
    });

    if (typeof callback === 'function') {
      callback({
        success: true,
        code,
        players,
        selectedGameId: room.selectedGameId,
        selectedGameName: room.selectedGameName || null,
        hostId: room.hostId,
        status: 'ready'
      });
    }
  });

  socket.on('pvp:selectGame', (rawGameId, callback) => {
    const code = socket.data.pvpRoom;
    const room = pvpRooms.get(code);

    if (!room) {
      return callback?.({ success: false, error: 'You are not in a room.' });
    }

    if (room.hostId !== socket.user.id) {
      return callback?.({ success: false, error: 'Only the room host can select a game.' });
    }

    const gameId = Number(rawGameId);

    if (!Number.isInteger(gameId) || gameId <= 0) {
      return callback?.({ success: false, error: 'Invalid game ID.' });
    }

    const game = db.prepare(
      'SELECT id, name FROM games WHERE id = ?'
    ).get(gameId);

    if (!game) {
      return callback?.({ success: false, error: 'Game not found.' });
    }

    room.selectedGameId = game.id;
    room.selectedGameName = game.name;

    const players = room.players.map(({ userId, username }) => ({
      userId,
      username
    }));

    const result = {
      code,
      players,
      selectedGameId: game.id,
      selectedGameName: game.name,
      hostId: room.hostId,
      status: room.players.length === 2 ? 'ready' : 'waiting'
    };

    io.to(code).emit('pvp:players', result);
    callback?.({ success: true, ...result });
  });
  socket.on('pvp:leaveRoom', () => {
    leavePvpRoom(socket);
  });

  socket.on('disconnect', () => {
    leavePvpRoom(socket);
  });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'GAMEVERSE API' }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Tên người dùng phải có từ 3 đến 24 ký tự.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return res.status(400).json({ error: 'Email không hợp lệ.' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Mật khẩu phải có từ 8 đến 72 ký tự.' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email này đã được sử dụng.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)').run(username, email, passwordHash);
    const user = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.cookie('gv_token', makeToken(user), cookieOptions);
    res.status(201).json({ message: 'Tạo tài khoản thành công!', user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Không thể tạo tài khoản lúc này.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Email hoặc mật khẩu không chính xác.' });
    res.cookie('gv_token', makeToken(user), cookieOptions);
    res.json({ message: 'Đăng nhập thành công!', user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Không thể đăng nhập lúc này.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('gv_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ message: 'Bạn đã đăng xuất.' });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/games', (req, res) => {
  const games = db.prepare(`SELECT games.id, games.name, games.description, games.genre,
  games.created_at, games.file_path, games.play_count, users.username AS creator
    FROM games JOIN users ON users.id = games.user_id
    ORDER BY games.id DESC LIMIT 100`).all();
  res.json({
    games: games.map(g => ({
      ...g,
      play_url: g.file_path ? '/game-files/' + g.file_path : null
    }))
  });
});


// API cộng lượt chơi
app.post('/api/games/:id/play', (req, res) => {
  const gameId = Number(req.params.id);

  if (!Number.isInteger(gameId) || gameId <= 0) {
    return res.status(400).json({ error: 'ID game khong hop le.' });
  }

  const result = db.prepare(
    'UPDATE games SET play_count = play_count + 1 WHERE id = ?'
  ).run(gameId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Khong tim thay game.' });
  }

  const game = db.prepare(
    'SELECT play_count FROM games WHERE id = ?'
  ).get(gameId);

  res.json({ success: true, play_count: game.play_count });
});

// API TOP 10 game được chơi nhiều nhất
app.get('/api/games/top', (req, res) => {
  const games = db.prepare(`
    SELECT games.id, games.name, games.description, games.genre,
      games.play_count, users.username AS creator
    FROM games
    JOIN users ON users.id = games.user_id
    ORDER BY games.play_count DESC, games.id DESC
    LIMIT 10
  `).all();

  res.json({ games });
});

app.post('/api/games', requireAuth, uploadGameFile.single('gameFile'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const genre = String(req.body.genre || '').trim();

  if (name.length < 2 || name.length > 45)
    return res.status(400).json({ error: 'Ten game phai co tu 2 den 45 ky tu.' });
  if (description.length > 180)
    return res.status(400).json({ error: 'Mo ta toi da 180 ky tu.' });
  if (!['2D', '3D', 'Indie'].includes(genre))
    return res.status(400).json({ error: 'The loai khong hop le.' });
  if (!req.file)
    return res.status(400).json({ error: 'Hay chon file game HTML hoac HTM.' });

  const gameId = crypto.randomUUID();
  const gameDir = path.join(__dirname, 'uploads', 'games', gameId);
  const filePath = gameId + '/index.html';

  try {
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'index.html'), req.file.buffer);

    const result = db.prepare(
      'INSERT INTO games (user_id, name, description, genre, file_path) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, name, description, genre, filePath);

    const game = db.prepare(`SELECT games.id, games.name, games.description,
      games.genre, games.created_at, games.file_path,
      users.username AS creator
      FROM games JOIN users ON users.id = games.user_id
      WHERE games.id = ?`).get(result.lastInsertRowid);

    res.status(201).json({
      message: 'Dang game thanh cong!',
      game: { ...game, play_url: '/game-files/' + filePath }
    });
  } catch (error) {
    fs.rmSync(gameDir, { recursive: true, force: true });
    console.error(error);
    res.status(500).json({ error: 'Khong the luu file game.' });
  }
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
httpServer.listen(PORT, () => {
  console.log(`GAMEVERSE đang chạy tại http://localhost:${PORT}`);
});
