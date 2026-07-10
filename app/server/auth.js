/**
 * auth.js — JWT 認證,首次設定,登入
 *
 * Exports:
 *   verifyToken(req, res, next)  — Express middleware
 *   registerRoutes(app)          — 掛載所有 auth 路由
 */
const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { hashPassword, checkPassword } = require('./password');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required');
const JWT_EXPIRES = '7d';

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function registerRoutes(app) {
  // GET /api/setup/status — 是否需要首次設定
  app.get('/api/setup/status', async (req, res) => {
    try {
      const { rows } = await query('SELECT COUNT(*) AS n FROM users');
      const n = parseInt(rows[0].n, 10);
      res.json({ needsSetup: n === 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/setup — 建立首位管理員(僅 users 表為空時)
  app.post('/api/auth/setup', async (req, res) => {
    try {
      const { rows } = await query('SELECT COUNT(*) AS n FROM users');
      if (parseInt(rows[0].n, 10) > 0) {
        return res.status(403).json({ error: '已完成初始設定' });
      }

      const { username, password, display_name } = req.body;
      if (!username || !password || !display_name) {
        return res.status(400).json({ error: 'username, password, display_name 為必填' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: '密碼至少 8 個字元' });
      }

      const password_hash = await hashPassword(password);
      const { rows: inserted } = await query(
        'INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [username, password_hash, display_name, 'admin']
      );

      res.json({ token: signToken(inserted[0].id) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/login — 驗證並回傳 token + user(不含 password_hash)
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
      const user = rows[0];

      if (!user || user.active === false || !(await checkPassword(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const { password_hash, ...safeUser } = user;
      res.json({ token: signToken(user.id), user: safeUser });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/auth/me — 目前使用者(需有效 JWT)
  app.get('/api/auth/me', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        'SELECT id, username, display_name, role, active FROM users WHERE id = $1',
        [req.userId]
      );
      if (!rows[0]) return res.status(404).json({ error: 'User not found' });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { verifyToken, registerRoutes };
