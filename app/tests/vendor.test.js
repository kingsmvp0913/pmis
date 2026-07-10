process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerVendorRoutes } = require('../server/vendor-routes');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeAppWithToken() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerVendorRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('vendor routes', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('未帶 token 的 list 回 401', async () => {
    const res = await request(app).get('/api/vendors');
    expect(res.status).toBe(401);
  });

  test('建立廠商並讀回', async () => {
    const res = await auth(request(app).post('/api/vendors')).send({ name: '甲營造' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('甲營造');
    const list = await auth(request(app).get('/api/vendors'));
    expect(list.body).toHaveLength(1);
  });

  test('建立廠商缺名稱回 400', async () => {
    const res = await auth(request(app).post('/api/vendors')).send({ name: '  ' });
    expect(res.status).toBe(400);
  });

  test('建立廠商可帶多筆聯絡人,主要聯絡人唯一', async () => {
    const res = await auth(request(app).post('/api/vendors')).send({
      name: '乙營造',
      contacts: [
        { name: '甲', phone: '111', is_primary: true },
        { name: '乙', phone: '222', is_primary: true },
        { name: '丙', phone: '333' }
      ]
    });
    expect(res.status).toBe(201);
    expect(res.body.contacts).toHaveLength(3);
    const primaries = res.body.contacts.filter(c => c.is_primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].name).toBe('甲');
  });

  test('更新廠商整批取代聯絡人', async () => {
    const created = await auth(request(app).post('/api/vendors')).send({
      name: '丙營造',
      contacts: [{ name: '原', is_primary: true }]
    });
    const id = created.body.id;
    const upd = await auth(request(app).put(`/api/vendors/${id}`)).send({
      name: '丙營造改',
      contacts: [{ name: '新甲' }, { name: '新乙', is_primary: true }]
    });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('丙營造改');
    expect(upd.body.contacts).toHaveLength(2);
    expect(upd.body.contacts.filter(c => c.is_primary)).toHaveLength(1);
  });

  test('搜尋 ?q= 依名稱過濾', async () => {
    await auth(request(app).post('/api/vendors')).send({ name: '大同營造' });
    await auth(request(app).post('/api/vendors')).send({ name: '中華工程' });
    const res = await auth(request(app).get('/api/vendors?q=大同'));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('大同營造');
  });

  test('刪除廠商連同聯絡人', async () => {
    const created = await auth(request(app).post('/api/vendors')).send({
      name: '待刪', contacts: [{ name: 'x' }]
    });
    const id = created.body.id;
    const del = await auth(request(app).delete(`/api/vendors/${id}`));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get(`/api/vendors/${id}`));
    expect(get.status).toBe(404);
  });

  test('批次匯入:去空行、去重、跳過已存在', async () => {
    await auth(request(app).post('/api/vendors')).send({ name: '已存在' });
    const text = [
      '甲廠', '', '乙廠', '甲廠', '  ', '已存在', '丙廠'
    ].join('\n');
    const res = await auth(request(app).post('/api/vendors/import')).send({ text });
    expect(res.status).toBe(200);
    // 新建:甲廠、乙廠、丙廠 = 3
    expect(res.body.created).toBe(3);
    // 略過:重複甲廠1 + 已存在1 = 2(空行直接忽略,不計入)
    expect(res.body.skipped).toBe(2);
    const list = await auth(request(app).get('/api/vendors'));
    expect(list.body.map(v => v.name).sort()).toEqual(['丙廠', '乙廠', '已存在', '甲廠'].sort());
  });
});
