process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerSchoolRoutes } = require('../server/school-routes');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeAppWithToken() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerSchoolRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('school routes', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('未帶 token 回 401', async () => {
    const res = await request(app).get('/api/schools');
    expect(res.status).toBe(401);
  });

  test('建立學校含縣市與聯絡人', async () => {
    const res = await auth(request(app).post('/api/schools')).send({
      name: '中正國小',
      county: '台北市',
      contacts: [{ name: '主任', phone: '02', is_primary: true }, { name: '幹事' }]
    });
    expect(res.status).toBe(201);
    expect(res.body.county).toBe('台北市');
    expect(res.body.contacts).toHaveLength(2);
    expect(res.body.contacts.filter(c => c.is_primary)).toHaveLength(1);
  });

  test('建立學校缺名稱回 400', async () => {
    const res = await auth(request(app).post('/api/schools')).send({ county: '台北市' });
    expect(res.status).toBe(400);
  });

  test('主要聯絡人唯一(多筆勾主要只留第一位)', async () => {
    const res = await auth(request(app).post('/api/schools')).send({
      name: '大安國中',
      contacts: [{ name: 'a', is_primary: true }, { name: 'b', is_primary: true }]
    });
    expect(res.body.contacts.filter(c => c.is_primary)).toHaveLength(1);
    expect(res.body.contacts.find(c => c.is_primary).name).toBe('a');
  });

  test('更新學校整批取代聯絡人與縣市', async () => {
    const created = await auth(request(app).post('/api/schools')).send({
      name: '舊校', county: '台北市', contacts: [{ name: '原' }]
    });
    const upd = await auth(request(app).put(`/api/schools/${created.body.id}`)).send({
      name: '新校', county: '新北市', contacts: [{ name: '新甲', is_primary: true }]
    });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('新校');
    expect(upd.body.county).toBe('新北市');
    expect(upd.body.contacts).toHaveLength(1);
  });

  test('搜尋 ?q= 依名稱過濾', async () => {
    await auth(request(app).post('/api/schools')).send({ name: '中正國小', county: '台北市' });
    await auth(request(app).post('/api/schools')).send({ name: '大同國小', county: '台北市' });
    const res = await auth(request(app).get('/api/schools?q=中正'));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('中正國小');
  });

  // 決標公告 28/28 都有「機關地址」,原本無處可存
  test('地址可存可改', async () => {
    const created = await auth(request(app).post('/api/schools')).send({
      name: '有址國小', county: '雲林縣', address: '655 雲林縣 元長鄉 元西路76號',
    });
    expect(created.body.address).toBe('655 雲林縣 元長鄉 元西路76號');
    const upd = await auth(request(app).put(`/api/schools/${created.body.id}`)).send({
      name: '有址國小', county: '雲林縣', address: '655 雲林縣 元長鄉 新址1號',
    });
    expect(upd.body.address).toBe('655 雲林縣 元長鄉 新址1號');
  });

  // /seed 的全部價值在於「不覆蓋」:公告是決標當下的快照,承辦人維護過的值較新。
  // 若這條壞掉,每解析一次公告就把承辦人改過的聯絡人與地址打回舊值,而且沒人會發現。
  test('seed 不覆蓋既有聯絡人與地址', async () => {
    const created = await auth(request(app).post('/api/schools')).send({
      name: '已維護國小', address: '承辦人填的地址',
      contacts: [{ name: '承辦人填的聯絡人', phone: '0900', is_primary: true }],
    });
    const res = await auth(request(app).post(`/api/schools/${created.body.id}/seed`)).send({
      address: '公告上的地址', contact: { name: '公告上的聯絡人', phone: '0800' },
    });
    expect(res.status).toBe(200);
    expect(res.body.seeded).toEqual({ contact: false, address: false });
    expect(res.body.address).toBe('承辦人填的地址');
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].name).toBe('承辦人填的聯絡人');
  });

  test('seed 只補空缺:沒聯絡人就補、地址空就填', async () => {
    const created = await auth(request(app).post('/api/schools')).send({ name: '空白國小' });
    const res = await auth(request(app).post(`/api/schools/${created.body.id}/seed`)).send({
      address: '公告上的地址', contact: { name: '李美奇', phone: '(05) 7882017 # 14' },
    });
    expect(res.body.seeded).toEqual({ contact: true, address: true });
    expect(res.body.address).toBe('公告上的地址');
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0]).toMatchObject({
      name: '李美奇', phone: '(05) 7882017 # 14', is_primary: true,
    });
  });

  // 同一所學校承接兩件工程時會解析兩次公告,不得長出第二筆聯絡人
  test('seed 冪等:重複呼叫不會長出第二筆聯絡人', async () => {
    const created = await auth(request(app).post('/api/schools')).send({ name: '兩案國小' });
    const body = { address: 'A', contact: { name: '甲', phone: '1' } };
    await auth(request(app).post(`/api/schools/${created.body.id}/seed`)).send(body);
    const second = await auth(request(app).post(`/api/schools/${created.body.id}/seed`)).send(body);
    expect(second.body.seeded).toEqual({ contact: false, address: false });
    expect(second.body.contacts).toHaveLength(1);
  });

  test('seed 目標不存在回 404', async () => {
    const res = await auth(request(app).post('/api/schools/99999/seed')).send({ address: 'x' });
    expect(res.status).toBe(404);
  });

  test('刪除學校連同聯絡人', async () => {
    const created = await auth(request(app).post('/api/schools')).send({
      name: '待刪校', contacts: [{ name: 'x' }]
    });
    const del = await auth(request(app).delete(`/api/schools/${created.body.id}`));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get(`/api/schools/${created.body.id}`));
    expect(get.status).toBe(404);
  });
});
