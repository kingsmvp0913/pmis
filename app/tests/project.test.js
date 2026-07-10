process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerProjectRoutes, computeDesignFeeActual, roundHalfUp } = require('../server/project-routes');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeAppWithToken() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerProjectRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('roundHalfUp helper', () => {
  test('0.5 邊界向上進位(非銀行家捨入)', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3); // 銀行家捨入會得 2
    expect(roundHalfUp(30.5)).toBe(31); // CLAUDE.md 明示例
  });
  test('一般四捨五入', () => {
    expect(roundHalfUp(30.4)).toBe(30);
    expect(roundHalfUp(30.6)).toBe(31);
  });
  test('null/非數字回 null', () => {
    expect(roundHalfUp(null)).toBe(null);
    expect(roundHalfUp('abc')).toBe(null);
  });
});

describe('computeDesignFeeActual', () => {
  test('lump_sum 直接取金額', () => {
    const r = computeDesignFeeActual({ design_fee_type: 'lump_sum', design_fee_amount: 500000 });
    expect(r.design_fee_actual).toBe(500000);
    expect(r.unbid).toBe(false);
  });

  test('pct 以決標金額 × % 並 half-up', () => {
    // 1,234,567 × 2.5% = 30864.175 → 30864
    const r = computeDesignFeeActual({ design_fee_type: 'pct', award_amount: 1234567, design_fee_pct: 2.5 });
    expect(r.design_fee_actual).toBe(30864);
    expect(r.unbid).toBe(false);
  });

  test('pct 進位邊界 half-up(非銀行家)', () => {
    // 100 × 2.5% = 2.5 → 3
    const r = computeDesignFeeActual({ design_fee_type: 'pct', award_amount: 100, design_fee_pct: 2.5 });
    expect(r.design_fee_actual).toBe(3);
  });

  test('pct 但決標金額未填 → null + unbid', () => {
    const r = computeDesignFeeActual({ design_fee_type: 'pct', award_amount: null, design_fee_pct: 3 });
    expect(r.design_fee_actual).toBe(null);
    expect(r.unbid).toBe(true);
  });
});

describe('project routes', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('未帶 token 回 401', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
  });

  test('建立工程(lump_sum)回附 design_fee_actual', async () => {
    const res = await auth(request(app).post('/api/projects')).send({
      project_no: 'P-001',
      name: '校舍整修',
      design_fee_type: 'lump_sum',
      design_fee_amount: 800000
    });
    expect(res.status).toBe(201);
    expect(res.body.design_fee_actual).toBe(800000);
    expect(res.body.design_fee_unbid).toBe(false);
  });

  test('建立工程(pct,含決標金額)計算實際設計費', async () => {
    const res = await auth(request(app).post('/api/projects')).send({
      name: '操場工程',
      award_amount: 1234567,
      design_fee_type: 'pct',
      design_fee_pct: 2.5
    });
    expect(res.status).toBe(201);
    expect(res.body.design_fee_actual).toBe(30864);
  });

  test('建立工程(pct,決標金額空)標記未招標', async () => {
    const res = await auth(request(app).post('/api/projects')).send({
      name: '未招標工程',
      award_amount: '',
      design_fee_type: 'pct',
      design_fee_pct: 3
    });
    expect(res.status).toBe(201);
    expect(res.body.design_fee_actual).toBe(null);
    expect(res.body.design_fee_unbid).toBe(true);
  });

  test('建立工程缺名稱回 400', async () => {
    const res = await auth(request(app).post('/api/projects')).send({ project_no: 'X' });
    expect(res.status).toBe(400);
  });

  test('更新工程改設計費類型', async () => {
    const created = await auth(request(app).post('/api/projects')).send({
      name: '工程A', design_fee_type: 'lump_sum', design_fee_amount: 100
    });
    const upd = await auth(request(app).put(`/api/projects/${created.body.id}`)).send({
      name: '工程A', award_amount: 200, design_fee_type: 'pct', design_fee_pct: 10
    });
    expect(upd.status).toBe(200);
    expect(upd.body.design_fee_actual).toBe(20);
  });

  test('搜尋 ?q= 依名稱或編號過濾', async () => {
    await auth(request(app).post('/api/projects')).send({ name: '操場工程', project_no: 'P-100' });
    await auth(request(app).post('/api/projects')).send({ name: '校舍整修', project_no: 'P-200' });
    const byName = await auth(request(app).get('/api/projects?q=操場'));
    expect(byName.body).toHaveLength(1);
    const byNo = await auth(request(app).get('/api/projects?q=P-200'));
    expect(byNo.body).toHaveLength(1);
    expect(byNo.body[0].name).toBe('校舍整修');
  });

  test('刪除工程', async () => {
    const created = await auth(request(app).post('/api/projects')).send({ name: '待刪工程' });
    const del = await auth(request(app).delete(`/api/projects/${created.body.id}`));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get(`/api/projects/${created.body.id}`));
    expect(get.status).toBe(404);
  });
});
