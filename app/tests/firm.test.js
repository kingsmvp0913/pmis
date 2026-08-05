process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerFirmRoutes } = require('../server/firm-routes');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeAppWithToken() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerFirmRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('firm routes', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('未帶 token 回 401', async () => {
    const res = await request(app).get('/api/firms');
    expect(res.status).toBe(401);
  });

  test('建立事務所並讀回,list 依名稱排序', async () => {
    await auth(request(app).post('/api/firms')).send({ name: '乙建築師事務所' });
    await auth(request(app).post('/api/firms')).send({ name: '甲建築師事務所' });
    const res = await auth(request(app).get('/api/firms'));
    expect(res.status).toBe(200);
    expect(res.body.map((f) => f.name)).toEqual(['乙建築師事務所', '甲建築師事務所'].sort());
  });

  test('建立事務所缺名稱回 400', async () => {
    const res = await auth(request(app).post('/api/firms')).send({ name: '  ' });
    expect(res.status).toBe(400);
  });

  test('建立同名事務所回 400', async () => {
    await auth(request(app).post('/api/firms')).send({ name: '同名事務所' });
    const res = await auth(request(app).post('/api/firms')).send({ name: '同名事務所' });
    expect(res.status).toBe(400);
  });

  test('更新事務所名稱', async () => {
    const created = await auth(request(app).post('/api/firms')).send({ name: '舊名稱' });
    const upd = await auth(request(app).put(`/api/firms/${created.body.id}`)).send({ name: '新名稱' });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('新名稱');
  });

  test('更新為與另一筆同名回 400', async () => {
    await auth(request(app).post('/api/firms')).send({ name: 'A事務所' });
    const b = await auth(request(app).post('/api/firms')).send({ name: 'B事務所' });
    const res = await auth(request(app).put(`/api/firms/${b.body.id}`)).send({ name: 'A事務所' });
    expect(res.status).toBe(400);
  });

  test('更新自己名稱不變不算重複', async () => {
    const created = await auth(request(app).post('/api/firms')).send({ name: '不變事務所' });
    const res = await auth(request(app).put(`/api/firms/${created.body.id}`)).send({ name: '不變事務所' });
    expect(res.status).toBe(200);
  });

  test('刪除未被使用的事務所', async () => {
    const created = await auth(request(app).post('/api/firms')).send({ name: '待刪事務所' });
    const del = await auth(request(app).delete(`/api/firms/${created.body.id}`));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get(`/api/firms/${created.body.id}`));
    expect(get.status).toBe(404);
  });

  test('刪除不存在的事務所回 404', async () => {
    const res = await auth(request(app).delete('/api/firms/99999'));
    expect(res.status).toBe(404);
  });

  // projects.supervisor_firm / designer_firm 存的是名稱字串而非外鍵,刪除不會
  // 破壞既有工程資料,但不可靜默——沒有 ?force=1 要回 409 並告知使用中的筆數。
  test('刪除有工程正在使用的事務所回 409,附 force=1 才真的刪除', async () => {
    const created = await auth(request(app).post('/api/firms')).send({ name: '使用中事務所' });
    // 直接寫工程列(繞過決標公告等建案流程,這裡只關心 firms 刪除時的使用中判斷)
    await db.query(
      'INSERT INTO projects (name, supervisor_firm, designer_firm) VALUES ($1, $2, $3)',
      ['測試工程', '使用中事務所', '使用中事務所']
    );

    const blocked = await auth(request(app).delete(`/api/firms/${created.body.id}`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.count).toBe(1);

    const forced = await auth(request(app).delete(`/api/firms/${created.body.id}?force=1`));
    expect(forced.status).toBe(200);
    const get = await auth(request(app).get(`/api/firms/${created.body.id}`));
    expect(get.status).toBe(404);
  });

  // 這條最重要:migrate() 要把 settings 既有的兩個值 seed 進 firms,且重跑不會重複——
  // 這是升級不掉資料的保證。
  test('migrate 把 settings 既有的監造/設計單位 seed 進 firms,重跑不重複', async () => {
    await db._setPoolForTesting(null);
    const pool = freshPool();
    db._setPoolForTesting(pool);
    await db.migrate();

    // 模擬升級前已存在的系統預設值(直接寫 settings,不經過 firms)
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('supervisor_firm', $1), ('designer_firm', $2)`,
      ['既有監造事務所', '既有設計事務所']
    );

    // 第一次 migrate:應把兩個值 seed 進 firms
    await db.migrate();
    const { rows: firstRun } = await db.query('SELECT name FROM firms ORDER BY name');
    expect(firstRun.map((r) => r.name).sort()).toEqual(['既有監造事務所', '既有設計事務所'].sort());

    // 重跑 migrate:不應產生重複列
    await db.migrate();
    await db.migrate();
    const { rows: afterRerun } = await db.query('SELECT name FROM firms ORDER BY name');
    expect(afterRerun.map((r) => r.name).sort()).toEqual(['既有監造事務所', '既有設計事務所'].sort());
  });

  test('migrate 遇到 settings 空值不 seed 空字串', async () => {
    await db._setPoolForTesting(null);
    const pool = freshPool();
    db._setPoolForTesting(pool);
    await db.migrate();

    await db.query(
      `INSERT INTO settings (key, value) VALUES ('supervisor_firm', $1), ('designer_firm', $2)`,
      ['', '  ']
    );
    await db.migrate();
    const { rows } = await db.query('SELECT name FROM firms');
    expect(rows).toHaveLength(0);
  });

  test('migrate 監造/設計同一值只 seed 一筆', async () => {
    await db._setPoolForTesting(null);
    const pool = freshPool();
    db._setPoolForTesting(pool);
    await db.migrate();

    await db.query(
      `INSERT INTO settings (key, value) VALUES ('supervisor_firm', $1), ('designer_firm', $1)`,
      ['同一家事務所']
    );
    await db.migrate();
    const { rows } = await db.query('SELECT name FROM firms');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('同一家事務所');
  });
});
