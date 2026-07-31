process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerSettingsRoutes, getFirmDefaults } = require('../server/settings');

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

describe('監造/設計單位系統預設', () => {
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  // 這兩支是決標公告比對時帶入監造/設計單位預設的來源,且 PUT 會改動全系統預設值;
  // verifyToken 是唯一的門,沒有測試釘住的話重排 middleware 就會靜默開洞。
  test('未帶 token 回 401', async () => {
    const { app } = await makeAppWithToken();
    expect((await request(app).get('/api/settings/firms')).status).toBe(401);
    expect((await request(app).put('/api/settings/firms')
      .send({ supervisor_firm: '甲事務所' })).status).toBe(401);
  });

  test('未設定時兩者皆 null(不假設等於某家事務所)', async () => {
    const { app } = await makeAppWithToken();
    expect(app).toBeDefined();
    await expect(getFirmDefaults()).resolves.toEqual({
      supervisor_firm: null, designer_firm: null,
    });
  });

  test('PUT 後 GET 取得同值', async () => {
    const { app, token } = await makeAppWithToken();
    const put = await request(app).put('/api/settings/firms')
      .set('Authorization', `Bearer ${token}`)
      .send({ supervisor_firm: '呂罡銘建築師事務所', designer_firm: '呂罡銘建築師事務所' });
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/settings/firms')
      .set('Authorization', `Bearer ${token}`);
    expect(get.body).toEqual({
      supervisor_firm: '呂罡銘建築師事務所', designer_firm: '呂罡銘建築師事務所',
    });
  });

  test('只更新其中一個不會把另一個洗掉', async () => {
    const { app, token } = await makeAppWithToken();
    await request(app).put('/api/settings/firms').set('Authorization', `Bearer ${token}`)
      .send({ supervisor_firm: '甲事務所', designer_firm: '乙事務所' });
    await request(app).put('/api/settings/firms').set('Authorization', `Bearer ${token}`)
      .send({ supervisor_firm: '丙事務所' });
    const get = await request(app).get('/api/settings/firms')
      .set('Authorization', `Bearer ${token}`);
    expect(get.body).toEqual({ supervisor_firm: '丙事務所', designer_firm: '乙事務所' });
  });
});

describe('migrate 欄位級異動', () => {
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  test('projects 取得 supervisor_firm / designer_firm 且重跑 migrate 不炸', async () => {
    // migrate() 在每次啟動都會跑;不冪等會讓第二次啟動直接掛掉
    await makeAppWithToken();
    await db.migrate();
    const { rows } = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'"
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain('supervisor_firm');
    expect(cols).toContain('designer_firm');
  });
});
