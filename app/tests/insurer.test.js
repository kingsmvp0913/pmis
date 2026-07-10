process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerInsurerRoutes } = require('../server/insurer-routes');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeAppWithToken() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerInsurerRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('insurer routes', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('未帶 token 回 401', async () => {
    const res = await request(app).get('/api/insurers');
    expect(res.status).toBe(401);
  });

  test('建立保險公司含多險種', async () => {
    const res = await auth(request(app).post('/api/insurers')).send({
      name: '國泰產險',
      types: [{ name: '營造綜合保險' }, { name: '雇主意外責任險' }]
    });
    expect(res.status).toBe(201);
    expect(res.body.types).toHaveLength(2);
  });

  test('建立保險公司缺名稱回 400', async () => {
    const res = await auth(request(app).post('/api/insurers')).send({ types: [] });
    expect(res.status).toBe(400);
  });

  test('更新整批取代險種', async () => {
    const created = await auth(request(app).post('/api/insurers')).send({
      name: '富邦', types: [{ name: '舊險種' }]
    });
    const upd = await auth(request(app).put(`/api/insurers/${created.body.id}`)).send({
      name: '富邦產險', types: [{ name: '新甲' }, { name: '新乙' }]
    });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('富邦產險');
    expect(upd.body.types.map(t => t.name).sort()).toEqual(['新乙', '新甲'].sort());
  });

  test('GET /:id/types 供前端連動', async () => {
    const created = await auth(request(app).post('/api/insurers')).send({
      name: '新光', types: [{ name: 'A險' }, { name: 'B險' }]
    });
    const res = await auth(request(app).get(`/api/insurers/${created.body.id}/types`));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toHaveProperty('id');
    expect(res.body[0]).toHaveProperty('name');
  });

  test('GET /:id/types 保險公司不存在回 404', async () => {
    const res = await auth(request(app).get('/api/insurers/9999/types'));
    expect(res.status).toBe(404);
  });

  test('搜尋 ?q= 過濾', async () => {
    await auth(request(app).post('/api/insurers')).send({ name: '國泰產險' });
    await auth(request(app).post('/api/insurers')).send({ name: '富邦產險' });
    const res = await auth(request(app).get('/api/insurers?q=國泰'));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('國泰產險');
  });

  test('刪除保險公司連同險種', async () => {
    const created = await auth(request(app).post('/api/insurers')).send({
      name: '待刪', types: [{ name: 'x' }]
    });
    const del = await auth(request(app).delete(`/api/insurers/${created.body.id}`));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get(`/api/insurers/${created.body.id}`));
    expect(get.status).toBe(404);
  });
});
