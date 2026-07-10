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
