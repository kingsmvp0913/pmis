process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerSettingsRoutes } = require('../server/settings');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeAppWithToken() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerSettingsRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('settlement-day 設定', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('未帶 token 回 401', async () => {
    const res = await request(app).get('/api/settings/settlement-day');
    expect(res.status).toBe(401);
  });

  test('未設定時回預設值 5', async () => {
    const res = await auth(request(app).get('/api/settings/settlement-day'));
    expect(res.status).toBe(200);
    expect(res.body.settlement_day).toBe(5);
  });

  test('PUT 設定後 GET 回新值', async () => {
    const put = await auth(request(app).put('/api/settings/settlement-day')).send({ settlement_day: 10 });
    expect(put.status).toBe(200);
    expect(put.body.settlement_day).toBe(10);
    const get = await auth(request(app).get('/api/settings/settlement-day'));
    expect(get.body.settlement_day).toBe(10);
  });

  test('超出 1–28 範圍回 400', async () => {
    const tooLow = await auth(request(app).put('/api/settings/settlement-day')).send({ settlement_day: 0 });
    expect(tooLow.status).toBe(400);
    const tooHigh = await auth(request(app).put('/api/settings/settlement-day')).send({ settlement_day: 29 });
    expect(tooHigh.status).toBe(400);
  });
});
