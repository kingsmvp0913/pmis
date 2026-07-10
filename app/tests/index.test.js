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
