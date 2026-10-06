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

describe('firms 發文資訊五欄', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  // 公文的地址/電話/傳真/聯絡人/信箱直接印在函上,存不進去就等於公文產不出來
  test('新增時可帶入五欄並回傳', async () => {
    const res = await request(app).post('/api/firms')
      .set('Authorization', 'Bearer ' + token)
      .send({
        name: '呂罡銘建築師事務所',
        address: '403台中市西區中華路一段7號3樓',
        phone: '04-22238088',
        fax: '04-22230988',
        contact: '呂罡銘',
        email: 'arch.kmlu@gmail.com',
      });
    expect(res.status).toBe(201);
    expect(res.body.address).toBe('403台中市西區中華路一段7號3樓');
    expect(res.body.phone).toBe('04-22238088');
    expect(res.body.fax).toBe('04-22230988');
    expect(res.body.contact).toBe('呂罡銘');
    expect(res.body.email).toBe('arch.kmlu@gmail.com');
  });

  test('編輯時可更新五欄', async () => {
    const created = await request(app).post('/api/firms')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: '大墩規劃設計顧問有限公司' });
    const res = await request(app).put('/api/firms/' + created.body.id)
      .set('Authorization', 'Bearer ' + token)
      .send({ name: '大墩規劃設計顧問有限公司', address: '403台中市西區柳川西路二段140巷8號12樓之2' });
    expect(res.status).toBe(200);
    expect(res.body.address).toBe('403台中市西區柳川西路二段140巷8號12樓之2');
  });

  // 五欄都是選填:既有事務所資料沒有這些值,不能因此擋住儲存
  test('五欄可留空', async () => {
    const res = await request(app).post('/api/firms')
      .set('Authorization', 'Bearer ' + token)
      .send({ name: '只有名字的事務所' });
    expect(res.status).toBe(201);
    expect(res.body.address == null || res.body.address === '').toBe(true);
  });
});

// 用印綁事務所:大墩的公文原本蓋成呂罡銘的章(範本寫死)。
describe('事務所公文用印', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));
  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000c8000000640806000000', 'hex'), Buffer.alloc(8)]);

  test('上傳後單筆回圖、清單只回 has_seal;移除後恢復', async () => {
    const { body: f } = await auth(request(app).post('/api/firms')).send({ name: '大墩規劃設計顧問有限公司' });
    expect(f.has_seal).toBe(false);
    const up = await auth(request(app).post(`/api/firms/${f.id}/seal`)).attach('seal', PNG, 'seal.png');
    expect(up.status).toBe(200);
    const one = await auth(request(app).get(`/api/firms/${f.id}`));
    expect(one.body.seal_image).toBe('data:image/png;base64,' + PNG.toString('base64'));
    const list = await auth(request(app).get('/api/firms'));
    expect(list.body[0].has_seal).toBe(true);
    expect(list.body[0].seal_image).toBeUndefined();
    // 編輯基本欄位(整份取代)不可把用印洗掉
    await auth(request(app).put(`/api/firms/${f.id}`)).send({ name: '大墩規劃設計顧問有限公司' });
    expect((await auth(request(app).get(`/api/firms/${f.id}`))).body.has_seal).toBe(true);
    await auth(request(app).delete(`/api/firms/${f.id}/seal`)).expect(200);
    expect((await auth(request(app).get(`/api/firms/${f.id}`))).body.seal_image).toBeNull();
  });

  test('不是 PNG/JPEG 擋下', async () => {
    const { body: f } = await auth(request(app).post('/api/firms')).send({ name: '甲' });
    const res = await auth(request(app).post(`/api/firms/${f.id}/seal`)).attach('seal', Buffer.from('hello world, not an image'), 'a.txt');
    expect(res.status).toBe(400);
  });

  // 升級前範本寫死的就是呂罡銘的章:升級後他的公文要照舊有印,但只補一次——
  // 承辦人刪掉之後,重啟不可以又被補回來
  test('升級時替呂罡銘補上原本範本的章,只補一次', async () => {
    await db.query("INSERT INTO firms (name) VALUES ('呂罡銘建築師事務所'), ('大墩規劃設計顧問有限公司')");
    await db.query("DELETE FROM settings WHERE key = 'seal_backfill_done'");
    await db.migrate();
    const { rows } = await db.query('SELECT name, seal_image FROM firms ORDER BY name');
    const by = Object.fromEntries(rows.map((r) => [r.name, r.seal_image]));
    expect(by['呂罡銘建築師事務所']).toMatch(/^data:image\/png;base64,/);
    expect(by['大墩規劃設計顧問有限公司']).toBeNull();
    await db.query("UPDATE firms SET seal_image = NULL WHERE name = '呂罡銘建築師事務所'");
    await db.migrate();
    const { rows: again } = await db.query("SELECT seal_image FROM firms WHERE name = '呂罡銘建築師事務所'");
    expect(again[0].seal_image).toBeNull();
  });
});
