# PMIS 平台基座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一個能啟動、能一鍵安裝、支援多使用者登入的 PMIS 空殼平台(Node.js + Express + PostgreSQL),之後各主檔功能可直接掛上。

**Architecture:** 後端 Express 每個領域一個 `*-routes.js`,各自 `registerRoutes(app)`;`db.js` 提供 `getPool()`/`migrate()`/`query()`/`_setPoolForTesting()`,schema 以 `CREATE TABLE IF NOT EXISTS` 冪等建立,測試以 `pg-mem` 注入池。前端為**純原生 JS**(無框架、無 CDN)的 hash-router SPA,沿用 odoo-v2 的 `app.css` dark-aware CSS 變數。認證用 JWT(Bearer)+ pbkdf2/bcrypt 密碼雜湊,首次啟動導向建立管理員。

**Tech Stack:** Node.js + Express, PostgreSQL(pg), JWT(jsonwebtoken)+bcryptjs, 原生 JS SPA, jest + pg-mem + supertest, PowerShell 安裝腳本(Windows)

## Global Constraints

- 平台**僅 Windows**;安裝/啟動走 PowerShell(`install.ps1` / `start.ps1`)。
- 服務埠固定 `4141`,程式一律 `process.env.PORT || 4141`(避開 odoo-v2 的 3939)。
- 資料庫用 PostgreSQL(`pg`);schema 一律 `CREATE TABLE IF NOT EXISTS` **冪等** migration,可重複執行不報錯。
- 多使用者:JWT(Bearer token)+ 密碼雜湊(pbkdf2-sha512,`checkPassword` 保留 bcrypt fallback);`verifyToken` middleware 保護 API;首次啟動 `/api/setup/status` 回 `needsSetup`,引導建立管理員。
- 密碼至少 8 個字元。
- 前端配色**一律走 `app.css` 的 CSS 變數／dark-aware class**;**禁止在 inline style 寫死淺色 `background`**(`#fff`/`#fef2f2`/`#f8fafc` 等)而不同時寫死可讀文字色。底色需區隔時用 `var(--bg)`/`var(--surface)`。
- **禁止寫死任何絕對路徑**(`C:\...` 或 `/home/...`);一律相對路徑或環境變數(`__dirname`、`process.env`)。
- 上傳/產出檔存 `data/`;DB 只存相對路徑(本階段僅建表基礎,尚未上傳)。
- 金額計算禁用原生 `round()`(銀行家捨入);改用 `Decimal` + `ROUND_HALF_UP`(本階段用不到,列著供後續階段遵循)。
- Commit message 用 `[Module]: Why` 風格,結尾加一行:`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: 專案骨架 + package.json + jest 設定

**Files:**
- Create: `C:\pmis\app\package.json`
- Create: `C:\pmis\app\.gitignore`
- Create: `C:\pmis\app\tests\smoke.test.js`

**Interfaces:**
- Consumes: 無(第一個 task)。
- Produces:
  - npm scripts:`npm test`(= `jest --runInBand --forceExit`,cwd = `C:\pmis\app`)、`npm start`(= `node server/index.js`)。
  - jest 設定:`testMatch` = `["**/tests/**/*.test.js"]`,`testEnvironment` = `node`。
  - 依賴就緒供後續 task `require`:`express`、`pg`、`bcryptjs`、`jsonwebtoken`、`multer`;devDeps:`jest`、`pg-mem`、`supertest`。

- [ ] **Step 1: 建立 `app/package.json`**

寫入 `C:\pmis\app\package.json`:

```json
{
  "name": "pmis",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node server/index.js",
    "test": "jest --runInBand --forceExit"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "express": "^4.19.2",
    "jsonwebtoken": "^9.0.2",
    "multer": "^2.2.0",
    "pg": "^8.22.0"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "pg-mem": "^2.9.1",
    "supertest": "^7.0.0"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": [
      "**/tests/**/*.test.js"
    ]
  }
}
```

- [ ] **Step 2: 建立 `app/.gitignore`**

寫入 `C:\pmis\app\.gitignore`:

```gitignore
node_modules/
```

- [ ] **Step 3: 安裝依賴**

Run(cwd 必須是 `C:\pmis\app`):
```powershell
cd C:\pmis\app; npm install
```
Expected: 安裝完成,`C:\pmis\app\node_modules` 出現,無 error 結尾(warnings 可忽略)。

- [ ] **Step 4: 寫一個 smoke 測試確認 jest 通**

寫入 `C:\pmis\app\tests\smoke.test.js`:

```javascript
test('jest 環境可運作', () => {
  expect(1 + 1).toBe(2);
});

test('pg-mem 可載入並建記憶體資料庫', () => {
  const { newDb } = require('pg-mem');
  const db = newDb();
  expect(typeof db.adapters.createPg).toBe('function');
});
```

- [ ] **Step 5: 跑測試確認通過**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npm test
```
Expected: PASS,2 tests passed。

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/.gitignore app/tests/smoke.test.js
git commit -m "$(cat <<'EOF'
[App]: 建立 PMIS 平台基座專案骨架與 jest 測試環境

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: db.js — PostgreSQL pool + migrate(users/settings) + query + _setPoolForTesting

**Files:**
- Create: `C:\pmis\app\server\db.js`
- Test: `C:\pmis\app\tests\db.test.js`

**Interfaces:**
- Consumes: `pg`(prod)、`pg-mem`(test,由 `_setPoolForTesting` 注入)。
- Produces(後續所有 task 依賴):
  - `getPool() → pg.Pool` 單例;prod 讀 `process.env.DATABASE_URL`。
  - `query(text, params?) → Promise<{ rows: any[] }>`,`text` 用 `$1/$2` 佔位。
  - `migrate() → Promise<void>`,冪等建立 `users`、`settings` 兩表;可重複呼叫不報錯。
  - `_setPoolForTesting(pool|null)`:注入 pg-mem 池;傳 `null` 復位。
  - 表結構:
    - `users(id SERIAL PK, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())`
    - `settings(key TEXT PRIMARY KEY, value TEXT)`

- [ ] **Step 1: 寫失敗測試**

寫入 `C:\pmis\app\tests\db.test.js`:

```javascript
const { newDb } = require('pg-mem');
const db = require('../server/db');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

describe('db.migrate', () => {
  afterEach(() => db._setPoolForTesting(null));

  test('建立 users 與 settings 兩表', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    const { rows } = await db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const names = rows.map(r => r.table_name);
    expect(names).toContain('users');
    expect(names).toContain('settings');
  });

  test('重複呼叫 migrate 冪等、不報錯', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    await expect(db.migrate()).resolves.toBeUndefined();
  });

  test('query 可插入並讀回 users 列', async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    await db.query(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES ($1,$2,$3,$4)',
      ['admin', 'x', '管理員', 'admin']
    );
    const { rows } = await db.query('SELECT username, role, active FROM users WHERE username=$1', ['admin']);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('admin');
    expect(rows[0].active).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/db.test.js
```
Expected: FAIL,`Cannot find module '../server/db'`(檔案尚未建立)。

- [ ] **Step 3: 寫最小實作**

寫入 `C:\pmis\app\server\db.js`:

```javascript
/**
 * db.js — PostgreSQL connection pool + schema migration
 *
 * Exports:
 *   getPool()              → pg.Pool singleton
 *   migrate()              → Promise<void>, CREATE TABLE IF NOT EXISTS (idempotent)
 *   query(text, params)    → Promise<{ rows }>, thin wrapper over pool.query
 *   _setPoolForTesting(p)  → inject a pg-mem pool in tests
 */
const { Pool } = require('pg');

let _pool = null;

/**
 * Returns the pg.Pool singleton.
 * In production, reads DATABASE_URL from env.
 * In tests, use _setPoolForTesting() to inject a pg-mem pool.
 */
function getPool() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  _pool = new Pool(connectionString ? { connectionString } : undefined);
  return _pool;
}

/**
 * Thin query wrapper — always use this instead of pool.query directly
 * so tests can inject a mock pool transparently.
 *
 * @param {string} text    SQL text with $1/$2 placeholders
 * @param {any[]}  [params] Query parameters
 * @returns {Promise<{ rows: any[] }>}
 */
async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Creates the base application tables if they don't exist.
 * Safe to call multiple times (idempotent via IF NOT EXISTS + existence probe).
 *
 * @returns {Promise<void>}
 */
async function migrate() {
  // Run each statement separately so pg-mem handles them without issues
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      active        BOOLEAN NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )`,
  ];

  // Build set of tables that already exist so we can skip them.
  // This makes migrate() idempotent even in pg-mem, which has limited
  // support for IF NOT EXISTS with DEFAULT constraints on re-run.
  const { rows: existingRows } = await query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
  );
  const existing = new Set(existingRows.map(r => r.table_name));

  // Extract table name from "CREATE TABLE IF NOT EXISTS <name>" DDL
  const tableNameRe = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i;

  for (const sql of statements) {
    const match = sql.match(tableNameRe);
    if (match && existing.has(match[1])) {
      continue; // table already exists, skip
    }
    try {
      await query(sql);
    } catch (err) {
      // Ignore "table already exists" (pg code 42P07)
      if (err.code !== '42P07') throw err;
    }
  }
}

/**
 * Test-only: inject a pre-built pool (e.g. from pg-mem).
 * Pass null to reset to default behaviour.
 *
 * @param {object|null} pool
 */
function _setPoolForTesting(pool) {
  _pool = pool;
}

module.exports = { getPool, migrate, query, _setPoolForTesting };
```

- [ ] **Step 4: 跑測試確認通過**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/db.test.js
```
Expected: PASS,3 tests passed。

- [ ] **Step 5: Commit**

```bash
git add app/server/db.js app/tests/db.test.js
git commit -m "$(cat <<'EOF'
[db]: PostgreSQL pool 與冪等 migrate(users/settings),供測試注入 pg-mem

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: password.js — pbkdf2 雜湊 + bcrypt fallback

**Files:**
- Create: `C:\pmis\app\server\password.js`
- Test: `C:\pmis\app\tests\password.test.js`

**Interfaces:**
- Consumes: Node 內建 `crypto`、`bcryptjs`。
- Produces(auth.js 依賴):
  - `hashPassword(pw: string) → Promise<string>`:回傳 `$pbkdf2-sha512$<rounds>$<ab64 salt>$<ab64 checksum>` 格式雜湊。
  - `checkPassword(pw: string, hash: string) → Promise<boolean>`:驗證 pbkdf2 雜湊;`hash` 為 `$2` 開頭時走 bcrypt fallback;`hash` 非字串回 `false`。

- [ ] **Step 1: 寫失敗測試**

寫入 `C:\pmis\app\tests\password.test.js`:

```javascript
const { hashPassword, checkPassword } = require('../server/password');

describe('password', () => {
  test('hashPassword 產生 pbkdf2-sha512 格式字串', async () => {
    const h = await hashPassword('secret123');
    expect(h.startsWith('$pbkdf2-sha512$')).toBe(true);
  });

  test('同一密碼每次雜湊不同(salt 隨機)', async () => {
    const a = await hashPassword('secret123');
    const b = await hashPassword('secret123');
    expect(a).not.toBe(b);
  });

  test('checkPassword 正確密碼回 true', async () => {
    const h = await hashPassword('secret123');
    expect(await checkPassword('secret123', h)).toBe(true);
  });

  test('checkPassword 錯誤密碼回 false', async () => {
    const h = await hashPassword('secret123');
    expect(await checkPassword('wrong', h)).toBe(false);
  });

  test('checkPassword 相容既有 bcrypt hash', async () => {
    const bcrypt = require('bcryptjs');
    const bhash = bcrypt.hashSync('legacy-pw', 10);
    expect(await checkPassword('legacy-pw', bhash)).toBe(true);
    expect(await checkPassword('nope', bhash)).toBe(false);
  });

  test('checkPassword 非字串 hash 回 false', async () => {
    expect(await checkPassword('x', null)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/password.test.js
```
Expected: FAIL,`Cannot find module '../server/password'`。

- [ ] **Step 3: 寫最小實作**

寫入 `C:\pmis\app\server\password.js`:

```javascript
/**
 * password.js — 密碼雜湊
 *
 * 產生格式：$pbkdf2-sha512$<rounds>$<ab64 salt>$<ab64 checksum>
 * checkPassword 保留 bcrypt 驗證路徑,讓既有 $2 hash 仍可登入。
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 25000;      // pbkdf2_sha512 迭代次數；hash 自帶,驗證時依字串內 rounds
const SALT_BYTES = 16;
const KEY_BYTES = 64;      // sha512 digest 長度

// adapted-base64：標準 base64,'+' -> '.',去掉尾端 '='
function ab64encode(buf) {
  return buf.toString('base64').replace(/\+/g, '.').replace(/=+$/, '');
}
function ab64decode(str) {
  let s = str.replace(/\./g, '+');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const dk = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, ROUNDS, KEY_BYTES, 'sha512');
  return Promise.resolve(`$pbkdf2-sha512$${ROUNDS}$${ab64encode(salt)}$${ab64encode(dk)}`);
}

async function checkPassword(pw, hash) {
  if (typeof hash !== 'string') return false;
  if (hash.startsWith('$pbkdf2-sha512$')) {
    const m = /^\$pbkdf2-sha512\$(\d+)\$([^$]*)\$([^$]+)$/.exec(hash);
    if (!m) return false;
    const rounds = parseInt(m[1], 10);
    const salt = ab64decode(m[2]);
    const expected = ab64decode(m[3]);
    const dk = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, rounds, expected.length, 'sha512');
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  }
  // 相容 fallback：既有的 bcrypt hash
  return bcrypt.compare(pw, hash);
}

module.exports = { hashPassword, checkPassword };
```

- [ ] **Step 4: 跑測試確認通過**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/password.test.js
```
Expected: PASS,6 tests passed。

- [ ] **Step 5: Commit**

```bash
git add app/server/password.js app/tests/password.test.js
git commit -m "$(cat <<'EOF'
[password]: pbkdf2-sha512 密碼雜湊,保留 bcrypt 相容驗證

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: auth.js — setup/status、建管理員、登入、verifyToken

**Files:**
- Create: `C:\pmis\app\server\auth.js`
- Test: `C:\pmis\app\tests\auth.test.js`

**Interfaces:**
- Consumes:
  - `db`:`query`、`_setPoolForTesting`(test)、`migrate`(test)。
  - `password`:`hashPassword`、`checkPassword`。
  - env:`process.env.JWT_SECRET`(未設定則 throw,測試前需先設)。
- Produces(index.js 與後續路由依賴):
  - `verifyToken(req, res, next)`:Express middleware;無 `Authorization: Bearer <token>` 回 401 `{error:'Unauthorized'}`;token 無效回 401 `{error:'Invalid token'}`;成功則設 `req.userId`。
  - `registerRoutes(app)`:掛載下列路由:
    - `GET  /api/setup/status` → `{ needsSetup: boolean }`(users 表為空時 true)。
    - `POST /api/auth/setup` → body `{username, password, display_name}`;僅 users 空時可建首位 admin;回 `{ token }`。已完成回 403;缺欄位回 400;密碼 < 8 回 400。
    - `POST /api/auth/login` → body `{username, password}`;成功回 `{ token, user }`(user 不含 `password_hash`);失敗回 401 `{error:'Invalid credentials'}`;停用帳號(`active=false`)回 401。
    - `GET  /api/auth/me`(需 `verifyToken`)→ `{ id, username, display_name, role, active }`。

- [ ] **Step 1: 寫失敗測試**

寫入 `C:\pmis\app\tests\auth.test.js`:

```javascript
process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes, verifyToken } = require('../server/auth');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

function makeApp() {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  // 一條受保護的測試端點,驗證 verifyToken middleware
  app.get('/api/_protected', verifyToken, (req, res) => res.json({ userId: req.userId }));
  return app;
}

describe('auth routes', () => {
  let app;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    app = makeApp();
  });
  afterEach(() => db._setPoolForTesting(null));

  test('setup/status 在無使用者時回 needsSetup=true', async () => {
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });

  test('建立首位管理員回 token,之後 needsSetup=false', async () => {
    const res = await request(app)
      .post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const status = await request(app).get('/api/setup/status');
    expect(status.body.needsSetup).toBe(false);
  });

  test('已完成 setup 後再建管理員回 403', async () => {
    await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    const res = await request(app).post('/api/auth/setup')
      .send({ username: 'admin2', password: 'password1', display_name: '第二' });
    expect(res.status).toBe(403);
  });

  test('setup 密碼少於 8 字元回 400', async () => {
    const res = await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'short', display_name: '管理員' });
    expect(res.status).toBe(400);
  });

  test('登入成功回 token 與不含密碼的 user', async () => {
    await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'admin', password: 'password1' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.username).toBe('admin');
    expect(res.body.user.password_hash).toBeUndefined();
  });

  test('登入密碼錯誤回 401', async () => {
    await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('verifyToken 擋掉無 token 的請求(401)', async () => {
    const res = await request(app).get('/api/_protected');
    expect(res.status).toBe(401);
  });

  test('verifyToken 放行帶有效 token 的請求並帶出 userId', async () => {
    const setup = await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    const res = await request(app).get('/api/_protected')
      .set('Authorization', `Bearer ${setup.body.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.userId).toBe('number');
  });

  test('auth/me 帶 token 回目前使用者', async () => {
    const setup = await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    const res = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${setup.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('admin');
    expect(res.body.role).toBe('admin');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/auth.test.js
```
Expected: FAIL,`Cannot find module '../server/auth'`。

- [ ] **Step 3: 寫最小實作**

寫入 `C:\pmis\app\server\auth.js`:

```javascript
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
```

- [ ] **Step 4: 跑測試確認通過**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/auth.test.js
```
Expected: PASS,9 tests passed。

- [ ] **Step 5: Commit**

```bash
git add app/server/auth.js app/tests/auth.test.js
git commit -m "$(cat <<'EOF'
[auth]: JWT 認證,首次建管理員,登入與 verifyToken middleware

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: index.js — Express 組裝 + 端對端 supertest

**Files:**
- Create: `C:\pmis\app\server\index.js`
- Test: `C:\pmis\app\tests\index.test.js`

**Interfaces:**
- Consumes:
  - `auth`:`registerRoutes`。
  - `db`:`migrate`、`_setPoolForTesting`(test)。
  - env:`process.env.PORT`(預設 4141)、`process.env.JWT_SECRET`。
- Produces:
  - `createApp() → express.App`:已掛 `express.json()`、static 服務 `../public`、auth 路由;`GET /api/*` 未匹配回 404 `{error:'Not found'}`;其餘 GET 回傳 `public/index.html`(SPA fallback)。
  - `require.main === module` 時:呼叫 `migrate()` 後 `listen(PORT)`。

- [ ] **Step 1: 寫失敗測試**

寫入 `C:\pmis\app\tests\index.test.js`:

```javascript
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { createApp } = require('../server/index');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

describe('createApp 端對端', () => {
  let app;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    app = createApp();
  });
  afterEach(() => db._setPoolForTesting(null));

  test('掛上 auth 路由:setup/status 可回應', async () => {
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });

  test('未知 /api/ 路徑回 404 JSON', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });

  test('完整流程:建管理員 → 登入 → 用 token 取 me', async () => {
    await request(app).post('/api/auth/setup')
      .send({ username: 'admin', password: 'password1', display_name: '管理員' });
    const login = await request(app).post('/api/auth/login')
      .send({ username: 'admin', password: 'password1' });
    expect(login.status).toBe(200);
    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');
  });

  test('非 /api 路徑回傳 index.html(SPA fallback)', async () => {
    const res = await request(app).get('/some/spa/route');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<!doctype html>');
  });
});
```

> 註:`SPA fallback` 測試依賴 Task 6 的 `public/index.html`。**先在此建立最小 `public/index.html` 佔位**,Task 6 再補完整內容(見下方 Step 3)。

- [ ] **Step 2: 跑測試確認失敗**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/index.test.js
```
Expected: FAIL,`Cannot find module '../server/index'`。

- [ ] **Step 3: 建立最小 public/index.html 佔位**

寫入 `C:\pmis\app\public\index.html`(Task 6 會覆寫為完整版,此處確保 static fallback 測試可過):

```html
<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>PMIS</title></head>
<body><div id="app"></div></body>
</html>
```

- [ ] **Step 4: 寫最小實作**

寫入 `C:\pmis\app\server\index.js`:

```javascript
const express = require('express');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');

const PORT = process.env.PORT || 4141;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);

  // 未匹配的 /api 路徑回 JSON 404(避免掉進 SPA fallback)
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  // 其餘一律回 SPA 進入點
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}

if (require.main === module) {
  const { migrate } = require('./db');
  const app = createApp();
  migrate()
    .then(() => {
      app.listen(PORT, () => console.log(`PMIS http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('DB migration failed:', err);
      process.exit(1);
    });
}

module.exports = { createApp };
```

- [ ] **Step 5: 跑測試確認通過**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/index.test.js
```
Expected: PASS,4 tests passed。

- [ ] **Step 6: 跑全部測試確認整體綠燈**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npm test
```
Expected: PASS,全部 test suites 通過(smoke、db、password、auth、index)。

- [ ] **Step 7: Commit**

```bash
git add app/server/index.js app/tests/index.test.js app/public/index.html
git commit -m "$(cat <<'EOF'
[index]: Express 組裝(埠 4141)、static、auth 路由與 SPA fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 前端 SPA 骨架(index.html / app.css / api.js / dialog.js / app.js)

**Files:**
- Modify: `C:\pmis\app\public\index.html`(覆寫 Task 5 的佔位為完整版)
- Create: `C:\pmis\app\public\css\app.css`
- Create: `C:\pmis\app\public\js\api.js`
- Create: `C:\pmis\app\public\js\dialog.js`
- Create: `C:\pmis\app\public\js\app.js`

**Interfaces:**
- Consumes:後端 API:`GET /api/setup/status`、`POST /api/auth/setup`、`POST /api/auth/login`、`GET /api/auth/me`。
- Produces(供日後主檔 view 掛載):
  - `window.Api`:`getToken()`、`setToken(t)`、`clearToken()`、`isLoggedIn()`、`get(path)`、`post(path, body)`、`put(path, body)`、`delete(path)`。
  - `window.confirmDialog(opts) → Promise<boolean>`:全域確認對話框(取代原生 confirm)。
  - `window.showToast(message, level?)`:全域 toast。
  - hash router:`#/login`(登入或首次建管理員)、`#/`(登入後主框架)。
  - `window.PmisApp.registerRoute(hash, renderFn)`:日後主檔 view 註冊路由(`renderFn(mountEl, params)`)。
- **設計取捨**:odoo-v2 前端用 Vue 3(CDN),但 PMIS 需離線、無外部 CDN → 本 SPA 為**純原生 JS**(手刻 hash router),`app.css` 變數與 class 直接沿用 odoo-v2。

- [ ] **Step 1: 建立 `public/css/app.css`(沿用 odoo-v2 dark-aware 變數 + 基礎 class)**

寫入 `C:\pmis\app\public\css\app.css`:

```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #f7f8fa;
  --sidebar-bg: #18181b;
  --sidebar-text: #a1a1aa;
  --sidebar-active: #ffffff;
  --sidebar-accent: #6366f1;
  --card-bg: #ffffff;
  --surface: #ffffff;
  --border: #e4e4e7;
  --border-strong: #d1d5db;
  --text: #111827;
  --text-secondary: #374151;
  --text-muted: #6b7280;
  --text-placeholder: #9ca3af;
  --danger: #ef4444;
  --error: #ef4444;
  --warning: #f59e0b;
  --success: #10b981;
  --info: #3b82f6;
  --primary: #6366f1;
  --primary-hover: #4f46e5;
  --primary-light: #eef2ff;
  --radius-sm: 6px;
  --radius: 8px;
  --radius-lg: 12px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.05);
  --shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.04);
  --shadow-lg: 0 8px 32px rgba(0,0,0,.20);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --fs-sm: 12px;
  --fs-base: 13px;
  --fs-md: 14px;
  --fs-lg: 15px;
  --fs-xl: 18px;
  --fs-2xl: 20px;
  --fs-3xl: 22px;
  --fw-normal: 400;
  --fw-medium: 500;
  --fw-semibold: 600;
  --fw-bold: 700;
  --z-modal: 1000;
  --z-toast: 9999;
  --transition: 0.12s;
}

[data-theme="dark"] {
  --bg: #191919;
  --sidebar-bg: #202020;
  --sidebar-text: rgba(255,255,255,0.55);
  --sidebar-active: #ffffff;
  --card-bg: #202020;
  --surface: #202020;
  --border: #2e2e2e;
  --border-strong: #3d3d3d;
  --text: rgba(255,255,255,0.82);
  --text-secondary: rgba(255,255,255,0.62);
  --text-muted: rgba(255,255,255,0.44);
  --text-placeholder: rgba(255,255,255,0.30);
  --primary-hover: #7c7ff5;
  --primary-light: rgba(99,102,241,0.22);
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow: 0 2px 8px rgba(0,0,0,0.4);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.55);
}

/* 輸入框一律白底黑字,不隨深色模式切換 */
[data-theme="dark"] .form-control,
[data-theme="dark"] .form-group input { background: #fff; color: #111827; }
[data-theme="dark"] .login-box { background: var(--surface); }
[data-theme="dark"] .error-msg { background: rgba(239,68,68,0.12); border-color: rgba(239,68,68,0.35); }

body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); height: 100vh; overflow: hidden; font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

#app { display: flex; height: 100vh; }

/* ── Sidebar ── */
.sidebar { width: 220px; background: var(--sidebar-bg); color: var(--sidebar-text); display: flex; flex-direction: column; flex-shrink: 0; }
.sidebar-header { padding: 18px 16px 10px; }
.sidebar-header strong { display: block; font-size: 14px; font-weight: 700; color: #fff; letter-spacing: -0.2px; }
.sidebar-header span { font-size: 11px; color: var(--sidebar-text); }
.sidebar nav { flex: 1; padding: 6px 8px; }
.sidebar nav a { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 13px; color: var(--sidebar-text); text-decoration: none; cursor: pointer; border-radius: var(--radius-sm); transition: background var(--transition), color var(--transition); }
.sidebar nav a:hover { background: rgba(255,255,255,0.07); color: #e5e7eb; }
.sidebar nav a.active { background: rgba(99,102,241,0.18); color: #fff; font-weight: 500; }
.sidebar-footer { padding: 12px 16px; border-top: 1px solid rgba(255,255,255,0.06); }
.sidebar-footer a { font-size: 12px; color: var(--sidebar-text); text-decoration: none; cursor: pointer; }
.sidebar-footer a:hover { color: #fff; }

/* ── Main layout ── */
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.content { flex: 1; overflow-y: auto; padding: 24px 32px; min-width: 0; }
.page-title { font-size: 20px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; margin-bottom: 16px; }

/* ── Buttons ── */
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; border: none; cursor: pointer; transition: background var(--transition), opacity var(--transition); white-space: nowrap; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-primary { background: var(--primary); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn-outline { background: var(--surface); color: var(--text-secondary); border: 1px solid var(--border-strong); }
.btn-outline:hover:not(:disabled) { background: var(--bg); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-danger:hover:not(:disabled) { opacity: 0.88; }

/* ── Form ── */
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 5px; }
.form-control { width: 100%; padding: 8px 10px; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); font-size: 13px; color: var(--text); background: #fff; transition: border-color 0.15s, box-shadow 0.15s; }
.form-control:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
.form-control::placeholder { color: var(--text-placeholder); }

/* ── Login ── */
.login-wrap { display: flex; align-items: center; justify-content: center; height: 100vh; background: var(--sidebar-bg); width: 100%; }
.login-box { background: #fff; border-radius: var(--radius-lg); padding: 36px 40px; width: 380px; box-shadow: 0 8px 32px rgba(0,0,0,.25); }
.login-title { font-size: 22px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.3px; }
.login-sub { font-size: 13px; color: var(--text-muted); margin-bottom: 24px; }
.error-msg { background: #fef2f2; border: 1px solid #fecaca; color: var(--danger); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 13px; margin-bottom: 14px; }

/* ── Modal / Dialog ── */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; padding: var(--space-4); z-index: var(--z-modal); }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); width: 440px; max-width: 100%; }
.modal-title { font-size: var(--fs-lg); font-weight: var(--fw-semibold); color: var(--text); padding: var(--space-5) var(--space-6) var(--space-3); }
.modal-body { padding: 0 var(--space-6); font-size: var(--fs-md); color: var(--text-secondary); line-height: 1.7; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-5) var(--space-6) var(--space-6); }

/* ── Toasts ── */
.toast-container { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 8px; z-index: var(--z-toast); }
.toast { padding: 10px 16px; border-radius: var(--radius); font-size: 13px; font-weight: 500; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.18); max-width: 340px; }
.toast.info { background: var(--info); }
.toast.success { background: var(--success); }
.toast.warn { background: var(--warning); }
.toast.error { background: var(--danger); }
```

- [ ] **Step 2: 建立 `public/js/api.js`(原生 fetch 包裝)**

寫入 `C:\pmis\app\public\js\api.js`:

```javascript
// api.js — 原生 fetch 包裝 + token 管理
const TOKEN_KEY = 'pmis_token';

const Api = {
  getToken() { return localStorage.getItem(TOKEN_KEY); },
  setToken(t) { localStorage.setItem(TOKEN_KEY, t); },
  clearToken() { localStorage.removeItem(TOKEN_KEY); },
  isLoggedIn() { return !!this.getToken(); },

  async _fetch(method, path, body) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error('伺服器沒回應');
    }
    if (res.status === 401) {
      this.clearToken();
      window.location.hash = '/login';
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  get(path) { return this._fetch('GET', path); },
  post(path, body) { return this._fetch('POST', path, body); },
  put(path, body) { return this._fetch('PUT', path, body); },
  delete(path) { return this._fetch('DELETE', path); }
};

window.Api = Api;
```

- [ ] **Step 3: 建立 `public/js/dialog.js`(原生確認對話框 + toast)**

寫入 `C:\pmis\app\public\js\dialog.js`:

```javascript
// dialog.js — 全域確認對話框與 toast(原生 DOM,取代原生 confirm/alert)

// confirmDialog({ title, message, danger, confirmText, cancelText }) → Promise<boolean>
function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const danger = !!opts.danger;
    const confirmText = opts.confirmText || (danger ? '刪除' : '確定');
    const cancelText = opts.cancelText || '取消';

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title"></div>
        <div class="modal-body"><p style="white-space:pre-wrap;margin:0"></p></div>
        <div class="modal-actions">
          <button class="btn btn-outline" data-act="cancel"></button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = opts.title || '請確認';
    overlay.querySelector('.modal-body p').textContent = opts.message || '';
    overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
    overlay.querySelector('[data-act="ok"]').textContent = confirmText;

    function close(val) {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
    window.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}
window.confirmDialog = confirmDialog;

// showToast(message, level = 'info', duration = 4000)
function showToast(message, level = 'info', duration = 4000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}
window.showToast = showToast;
```

- [ ] **Step 4: 建立 `public/js/app.js`(原生 hash router + 登入/建管理員/主框架)**

寫入 `C:\pmis\app\public\js\app.js`:

```javascript
// app.js — 原生 hash router SPA 骨架
// 路由:#/login(登入或首次建管理員)、#/(登入後主框架)
// 日後主檔 view 以 PmisApp.registerRoute('#/vendors', renderFn) 掛入。

const routes = {};
function registerRoute(hash, renderFn) { routes[hash] = renderFn; }
window.PmisApp = { registerRoute };

const root = document.getElementById('app');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ── 登入 / 首次建管理員 ──
async function renderLogin() {
  root.innerHTML = '';
  let needsSetup = false;
  try {
    const status = await Api.get('setup/status');
    needsSetup = !!status.needsSetup;
  } catch { /* 後端未起,當作登入頁 */ }

  const errBox = el('div', { class: 'error-msg', style: 'display:none' });
  const userInput = el('input', { class: 'form-control', type: 'text', placeholder: '帳號' });
  const nameInput = el('input', { class: 'form-control', type: 'text', placeholder: '顯示名稱' });
  const pwInput = el('input', { class: 'form-control', type: 'password', placeholder: '密碼(至少 8 字元)' });

  function showErr(msg) { errBox.textContent = msg; errBox.style.display = ''; }

  async function submit() {
    errBox.style.display = 'none';
    try {
      if (needsSetup) {
        const res = await Api.post('auth/setup', {
          username: userInput.value.trim(),
          password: pwInput.value,
          display_name: nameInput.value.trim()
        });
        Api.setToken(res.token);
      } else {
        const res = await Api.post('auth/login', {
          username: userInput.value.trim(),
          password: pwInput.value
        });
        Api.setToken(res.token);
      }
      window.location.hash = '/';
    } catch (e) {
      showErr(e.message);
    }
  }

  const fields = [
    el('div', { class: 'form-group' }, [el('label', {}, '帳號'), userInput])
  ];
  if (needsSetup) {
    fields.push(el('div', { class: 'form-group' }, [el('label', {}, '顯示名稱'), nameInput]));
  }
  fields.push(el('div', { class: 'form-group' }, [el('label', {}, '密碼'), pwInput]));

  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const box = el('div', { class: 'login-box' }, [
    el('div', { class: 'login-title' }, needsSetup ? '建立管理員' : 'PMIS 登入'),
    el('div', { class: 'login-sub' }, needsSetup ? '首次啟動,請設定管理員帳號' : '營建監造管理系統'),
    errBox,
    ...fields,
    el('button', { class: 'btn btn-primary', style: 'width:100%;justify-content:center', onClick: submit },
      needsSetup ? '建立並登入' : '登入')
  ]);
  root.appendChild(el('div', { class: 'login-wrap' }, [box]));
}

// ── 登入後主框架(空殼,日後掛主檔 view)──
async function renderShell() {
  let me;
  try { me = await Api.get('auth/me'); }
  catch { Api.clearToken(); window.location.hash = '/login'; return; }

  root.innerHTML = '';
  const content = el('div', { class: 'content', id: 'view-root' });

  const sidebar = el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-header' }, [
      el('strong', {}, 'PMIS'),
      el('span', {}, '營建監造管理')
    ]),
    el('nav', {}, [
      el('a', { class: 'active', href: '#/' }, '🏠 首頁')
    ]),
    el('div', { class: 'sidebar-footer' }, [
      el('div', { style: 'font-size:12px;margin-bottom:8px;color:var(--sidebar-text)' }, me.display_name || me.username),
      el('a', { onClick: () => { Api.clearToken(); window.location.hash = '/login'; } }, '登出')
    ])
  ]);
  const main = el('div', { class: 'main' }, [content]);
  root.appendChild(sidebar);
  root.appendChild(main);

  // 首頁(空殼歡迎頁);日後主檔 view 以 registerRoute 掛入並在此 dispatch
  content.appendChild(el('div', { class: 'page-title' }, `歡迎,${me.display_name || me.username}`));
  content.appendChild(el('p', { style: 'color:var(--text-muted)' }, '平台基座已就緒。主檔功能將於後續階段掛載。'));
}

// ── router ──
async function route() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (!Api.isLoggedIn() && hash !== '/login') { window.location.hash = '/login'; return; }
  if (Api.isLoggedIn() && hash === '/login') { window.location.hash = '/'; return; }

  if (hash === '/login') return renderLogin();
  if (routes['#' + hash]) return routes['#' + hash](document.getElementById('view-root') || root, {});
  return renderShell();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
```

- [ ] **Step 5: 覆寫 `public/index.html`(引入 css/js,依序載入)**

覆寫 `C:\pmis\app\public\index.html`:

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PMIS 營建監造管理系統</title>
  <link rel="stylesheet" href="/css/app.css">
</head>
<body>
  <div id="app"></div>
  <script src="/js/api.js"></script>
  <script src="/js/dialog.js"></script>
  <script src="/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 6: 手動驗證前端(啟動 server 開瀏覽器)**

先確認測試仍綠(index.test.js 的 SPA fallback 現在讀到完整 index.html):
```powershell
cd C:\pmis\app; npx jest tests/index.test.js
```
Expected: PASS(SPA fallback 測試斷言 `<!doctype html>` 仍成立)。

再手動起 server 驗證畫面(需本機有 PostgreSQL,或暫時只驗證前端載入):
```powershell
cd C:\pmis\app; $env:JWT_SECRET='dev-secret'; $env:PORT='4141'; node server/index.js
```
Expected(有 DB 時):console 印 `PMIS http://localhost:4141`;瀏覽器開 `http://localhost:4141` 應看到「建立管理員」頁(首次)。驗證後 Ctrl+C 停止。

> 註:若本機尚無 PostgreSQL,此手動步驟可延到 Task 7 安裝腳本完成後再做;自動化測試(pg-mem)已覆蓋後端邏輯,不阻擋 commit。

- [ ] **Step 7: Commit**

```bash
git add app/public/index.html app/public/css/app.css app/public/js/api.js app/public/js/dialog.js app/public/js/app.js
git commit -m "$(cat <<'EOF'
[public]: 原生 JS SPA 骨架(登入/建管理員/主框架),沿用 dark-aware app.css

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: install.ps1 / start.ps1 / app/scripts/setup.js(一鍵安裝與啟動)

**Files:**
- Create: `C:\pmis\install.ps1`
- Create: `C:\pmis\start.ps1`
- Create: `C:\pmis\app\scripts\setup.js`
- Test: `C:\pmis\app\tests\setup.test.js`

**Interfaces:**
- Consumes:
  - `db`:`migrate`(setup.js 建表用)。
  - `password`:`hashPassword`(建管理員用)。
  - Node 內建 `pg`(建 DB)、`fs`、`path`、`crypto`(產 JWT_SECRET)。
- Produces:
  - `app/scripts/setup.js` 匯出 `buildConfig(overrides?) → { DATABASE_URL, JWT_SECRET, PORT }`:純函式,產生設定物件(JWT_SECRET 用 `crypto.randomBytes(32).toString('hex')`;PORT 預設 4141)。可測試,不做 I/O。
  - `app/scripts/setup.js` 主流程(`require.main === module` 時執行):讀/建 `data/config.json`(寫死絕對路徑禁止,一律 `path.resolve(__dirname, '..', '..')` 求根)、建 PostgreSQL DB(不存在才建)、跑 `migrate()`。
  - `install.ps1`:winget 靜默裝 Node LTS + PostgreSQL 17 → `npm install`(cwd `app`)→ `node app/scripts/setup.js`。
  - `start.ps1`:讀 `data/config.json` 設 env → 開瀏覽器 `http://localhost:4141` → `node app/server/index.js`。

- [ ] **Step 1: 寫失敗測試(針對可測的純函式 buildConfig)**

寫入 `C:\pmis\app\tests\setup.test.js`:

```javascript
const { buildConfig } = require('../scripts/setup');

describe('buildConfig', () => {
  test('無 overrides 時 PORT 預設 4141', () => {
    const cfg = buildConfig();
    expect(cfg.PORT).toBe(4141);
  });

  test('產生的 JWT_SECRET 為 64 字元 hex(32 bytes)', () => {
    const cfg = buildConfig();
    expect(cfg.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  test('每次產生的 JWT_SECRET 不同', () => {
    expect(buildConfig().JWT_SECRET).not.toBe(buildConfig().JWT_SECRET);
  });

  test('DATABASE_URL 有預設值(本機 postgres,DB 名 pmis)', () => {
    const cfg = buildConfig();
    expect(cfg.DATABASE_URL).toContain('/pmis');
  });

  test('overrides 覆寫預設(PORT / DATABASE_URL / JWT_SECRET)', () => {
    const cfg = buildConfig({ PORT: 5000, DATABASE_URL: 'postgres://x/y', JWT_SECRET: 'fixed' });
    expect(cfg.PORT).toBe(5000);
    expect(cfg.DATABASE_URL).toBe('postgres://x/y');
    expect(cfg.JWT_SECRET).toBe('fixed');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/setup.test.js
```
Expected: FAIL,`Cannot find module '../scripts/setup'`。

- [ ] **Step 3: 寫 `app/scripts/setup.js`**

寫入 `C:\pmis\app\scripts\setup.js`:

```javascript
#!/usr/bin/env node
/**
 * setup.js — PMIS 一鍵安裝編排(建 DB → migrate → 視需要建管理員)
 *
 * Exports:
 *   buildConfig(overrides?) → { DATABASE_URL, JWT_SECRET, PORT }  純函式,無 I/O
 *
 * 主流程(直接執行時):
 *   1. 讀/建 data/config.json(含 JWT_SECRET / DATABASE_URL / PORT)
 *   2. 若目標資料庫不存在則 CREATE DATABASE
 *   3. 對目標資料庫跑 migrate()
 *
 * 一律用 __dirname 求專案根,禁止寫死絕對路徑。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');           // C:\pmis
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULT_DB_NAME = 'pmis';
const DEFAULT_PORT = 4141;

/**
 * 產生設定物件(純函式,可測試)。overrides 逐欄覆寫。
 * @param {{DATABASE_URL?:string, JWT_SECRET?:string, PORT?:number}} [overrides]
 */
function buildConfig(overrides = {}) {
  return {
    DATABASE_URL: overrides.DATABASE_URL
      || process.env.DATABASE_URL
      || `postgres://postgres:postgres@localhost:5432/${DEFAULT_DB_NAME}`,
    JWT_SECRET: overrides.JWT_SECRET
      || crypto.randomBytes(32).toString('hex'),
    PORT: overrides.PORT || Number(process.env.PORT) || DEFAULT_PORT,
  };
}

// 讀既有 config;不存在則以 buildConfig 產生並寫檔(JWT_SECRET 落地後不再變)
function ensureConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = buildConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

// 從 DATABASE_URL 拆出 DB 名,並回傳連到 postgres 系統庫的 URL(用來 CREATE DATABASE)
function splitDbUrl(databaseUrl) {
  const u = new URL(databaseUrl);
  const dbName = u.pathname.replace(/^\//, '');
  u.pathname = '/postgres';
  return { adminUrl: u.toString(), dbName };
}

// 目標 DB 不存在則建立
async function ensureDatabase(databaseUrl) {
  const { Client } = require('pg');
  const { adminUrl, dbName } = splitDbUrl(databaseUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // 資料庫名來自本機 config,非使用者輸入;用識別字引號避免注入疑慮
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`[OK] 已建立資料庫 ${dbName}`);
    } else {
      console.log(`[OK] 資料庫 ${dbName} 已存在`);
    }
  } finally {
    await client.end();
  }
}

async function main() {
  console.log('=== PMIS 一鍵安裝 ===');
  const cfg = ensureConfig();
  console.log('[OK] 設定檔就緒:' + CONFIG_PATH);

  await ensureDatabase(cfg.DATABASE_URL);

  // 對目標 DB 跑 migrate
  process.env.DATABASE_URL = cfg.DATABASE_URL;
  const db = require(path.join(ROOT, 'app', 'server', 'db.js'));
  await db.migrate();
  console.log('[OK] 資料表 migration 完成');

  console.log('安裝完成。可執行 .\\start.ps1 啟動(首次啟動會導向建立管理員)。');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildConfig };
```

- [ ] **Step 4: 跑測試確認通過**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npx jest tests/setup.test.js
```
Expected: PASS,5 tests passed。

- [ ] **Step 5: 寫 `install.ps1`**

寫入 `C:\pmis\install.ps1`:

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "=== PMIS 系統套件安裝 (Windows) ===" -ForegroundColor Cyan

function Install-WingetPackage($id, $displayName) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "找不到 winget,請手動安裝 $displayName" -ForegroundColor Red
        exit 1
    }
    Write-Host "安裝 $displayName..." -ForegroundColor Yellow
    winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS" }
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { Install-WingetPackage "PostgreSQL.PostgreSQL.17" "PostgreSQL 17" }

# 重新整理 PATH(winget 裝完當前 session 讀不到新 PATH)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 安裝失敗,請手動安裝後重跑:https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js $(node --version)" -ForegroundColor Green

Write-Host "安裝 npm 依賴..." -ForegroundColor Yellow
Push-Location (Join-Path $Root "app")
npm install
Pop-Location

Write-Host "建立資料庫並執行 migration..." -ForegroundColor Yellow
node (Join-Path $Root "app\scripts\setup.js") @args

Write-Host "=== 安裝完成,執行 .\start.ps1 啟動 ===" -ForegroundColor Green
```

- [ ] **Step 6: 寫 `start.ps1`**

寫入 `C:\pmis\start.ps1`:

```powershell
#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

$configPath = Join-Path $Root "data\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "找不到 data\config.json,請先執行 .\install.ps1" -ForegroundColor Red
    exit 1
}

try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
} catch {
    Write-Host "data\config.json 損毀,請重跑 .\install.ps1" -ForegroundColor Red
    exit 1
}

if (-not $config.JWT_SECRET) {
    Write-Host "config.json 缺少 JWT_SECRET" -ForegroundColor Red
    exit 1
}

$env:JWT_SECRET = $config.JWT_SECRET
$env:PORT       = if ($config.PORT) { $config.PORT } else { 4141 }
if ($config.DATABASE_URL) { $env:DATABASE_URL = $config.DATABASE_URL }

$port = if ($config.PORT) { $config.PORT } else { 4141 }
Start-Process "http://localhost:$port"
node (Join-Path $Root "app\server\index.js")
```

- [ ] **Step 7: 跑全部測試確認整體綠燈**

Run(cwd = `C:\pmis\app`):
```powershell
cd C:\pmis\app; npm test
```
Expected: PASS,全部 test suites 通過(smoke、db、password、auth、index、setup)。

- [ ] **Step 8: 語法檢查兩支 PowerShell 腳本(不實際安裝)**

Run:
```powershell
powershell -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('C:\pmis\install.ps1', [ref]$null, [ref]$null); $null = [System.Management.Automation.Language.Parser]::ParseFile('C:\pmis\start.ps1', [ref]$null, [ref]$null); Write-Host 'ps1 syntax OK'"
```
Expected: 印出 `ps1 syntax OK`,無 parse error。

- [ ] **Step 9: Commit**

```bash
git add install.ps1 start.ps1 app/scripts/setup.js app/tests/setup.test.js
git commit -m "$(cat <<'EOF'
[setup]: 一鍵安裝(winget Node/PG17)、建 DB+migrate、start.ps1 啟動並開瀏覽器

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 完成後驗收

平台基座完成後,下列全數成立即可視為 Task 完成:

1. `cd C:\pmis\app; npm test` → 全綠(smoke / db / password / auth / index / setup 六個 suite)。
2. `.\install.ps1`(在乾淨 Windows 上)→ 安裝 Node + PostgreSQL、建 `pmis` DB、跑完 migration。
3. `.\start.ps1` → 自動開瀏覽器 `http://localhost:4141`,首次顯示「建立管理員」頁。
4. 建立管理員後可登出、再以該帳密登入,看到空的主框架與登出鈕。
5. 深色/淺色模式下登入頁與主框架文字皆可讀(無寫死淺色底導致文字隱形)。
6. 全程無寫死絕對路徑(除 PowerShell 以 `$PSScriptRoot`、Node 以 `__dirname` 求根外)。

後續階段(主檔 / 歷史 / 讀取器)以新的 `*-routes.js` + `PmisApp.registerRoute` 掛入,不需改動本基座。
