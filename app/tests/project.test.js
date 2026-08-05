process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-proj-'));
// ⚠️ 必須在 require 之前設定:history-routes 在 module load 時就把 UPLOAD_DIR 算好,
// 晚一步設定的話測試會把附件寫進正式的 data/ 目錄。
process.env.PMIS_DATA_DIR = TMP;

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

// 建工程的唯一入口是決標公告路徑(2026-08-05 起手動新增已移除),所以測試裡凡是
// 「先要有一個工程」的前置一律走這裡,不再用只填 name 的舊捷徑。
let projectSeq = 0;
async function createViaAward(app, token, fields = {}) {
  const { rows: v } = await db.query(`INSERT INTO vendors (name) VALUES ('晉林') RETURNING id`);
  const { rows: s } = await db.query(`INSERT INTO schools (name) VALUES ('南陽國小') RETURNING id`);
  const { name = '校舍整修', project_no = `P-${++projectSeq}`, award_amount = 1000000, ...rest } = fields;
  const req = request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .field('name', name)
    .field('project_no', project_no)
    .field('award_amount', String(award_amount))
    .field('school_id', String(s[0].id))
    .field('vendor_id', String(v[0].id));
  for (const [k, val] of Object.entries(rest)) req.field(k, val == null ? '' : String(val));
  return req.attach('award_notice', Buffer.from('%PDF-1.4'), '決標公告.pdf');
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
    const res = await createViaAward(app, token, {
      project_no: 'P-001', name: '校舍整修',
      design_fee_type: 'lump_sum', design_fee_amount: 800000,
    });
    expect(res.status).toBe(201);
    expect(res.body.design_fee_actual).toBe(800000);
    expect(res.body.design_fee_unbid).toBe(false);
  });

  test('建立工程(pct,含決標金額)計算實際設計費', async () => {
    const res = await createViaAward(app, token, {
      name: '操場工程', award_amount: 1234567,
      design_fee_type: 'pct', design_fee_pct: 2.5,
    });
    expect(res.status).toBe(201);
    expect(res.body.design_fee_actual).toBe(30864);
  });

  // 註:原有的「建立工程(pct,決標金額空)標記未招標」已移除——決標金額是決標公告
  // 路徑的必填欄位,建案時不可能為空。unbid 分支仍由 computeDesignFeeActual 的
  // 單元測試(本檔上方)覆蓋。

  test('建立工程缺名稱回 400', async () => {
    const res = await createViaAward(app, token, { name: '' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('name');
  });

  // 拆出決標公告分岔前,name 一律 trim 後才寫入;拆分時若漏掉這行,
  // 前後空白會原樣存進 DB(靜默行為漂移,舊測試只查狀態碼查不到)。
  // 這裡直接讀 DB 落地值,釘住「寫入前必 trim」而不是只看回應。
  test('工程名稱前後空白於寫入前裁掉(相容舊版行為)', async () => {
    const res = await createViaAward(app, token, { name: '  校舍整修  ' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('校舍整修');
    const { rows } = await db.query('SELECT name FROM projects WHERE id = $1', [res.body.id]);
    expect(rows[0].name).toBe('校舍整修');
  });

  test('更新工程改設計費類型', async () => {
    const created = await createViaAward(app, token, {
      name: '工程A', design_fee_type: 'lump_sum', design_fee_amount: 100,
    });
    const upd = await auth(request(app).put(`/api/projects/${created.body.id}`)).send({
      name: '工程A', award_amount: 200, design_fee_type: 'pct', design_fee_pct: 10
    });
    expect(upd.status).toBe(200);
    expect(upd.body.design_fee_actual).toBe(20);
  });

  test('搜尋 ?q= 依名稱或編號過濾', async () => {
    await createViaAward(app, token, { name: '操場工程', project_no: 'P-100' });
    await createViaAward(app, token, { name: '校舍整修', project_no: 'P-200' });
    const byName = await auth(request(app).get('/api/projects?q=操場'));
    expect(byName.body).toHaveLength(1);
    const byNo = await auth(request(app).get('/api/projects?q=P-200'));
    expect(byNo.body).toHaveLength(1);
    expect(byNo.body[0].name).toBe('校舍整修');
  });

  test('刪除工程', async () => {
    const created = await createViaAward(app, token, { name: '待刪工程' });
    const del = await auth(request(app).delete(`/api/projects/${created.body.id}`));
    expect(del.status).toBe(200);
    const get = await auth(request(app).get(`/api/projects/${created.body.id}`));
    expect(get.status).toBe(404);
  });
});

describe('POST /api/projects 決標公告路徑', () => {
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  // 2026-08-05 裁決推翻原本的「手動新增只要工程名稱」:沒有決標公告的工程,
  // 到開工報告表那關一定會被擋下(比對沒有基準),等於讓承辦人先建一個註定
  // 要重建的案子。建案入口收斂成決標公告一條。
  test('未附決標公告時擋下建案', async () => {
    const { app, token } = await makeAppWithToken();
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '手動建立的工程' })
      .expect(400);
    expect(res.body.error).toMatch(/決標公告/);
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM projects');
    expect(rows[0].n).toBe(0);
  });

  // 半套工程會讓後續 SP2/SP3 全部落空,且承辦人不會回頭檢查一個已顯示「建立成功」的工程。
  test('含決標公告但缺欄位時 400,且一次列全缺項', async () => {
    const { app, token } = await makeAppWithToken();
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .field('name', '南陽國小廁所工程')
      .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
      .expect(400);
    expect(res.body.fields.sort()).toEqual(
      ['award_amount', 'project_no', 'school_id', 'vendor_id'].sort()
    );
  });

  // 停在「找不到○○」狀態就送出,會產生沒有廠商/學校的無主工程。
  test('廠商或學校未綁定視同未填', async () => {
    const { app, token } = await makeAppWithToken();
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .field('name', '南陽').field('project_no', '1150113')
      .field('award_amount', '3122168').field('school_id', '')
      .field('vendor_id', '')
      .attach('award_notice', Buffer.from('%PDF-1.4'), 'a.pdf')
      .expect(400);
    expect(res.body.fields).toEqual(expect.arrayContaining(['school_id', 'vendor_id']));
  });

  // 同一份決標公告被傳兩次(承辦人忘記已建過、或兩人同時處理)會產生兩個內容
  // 一樣的工程,之後的施工日誌、監造報表全部分岔到兩邊,而且沒有任何畫面看得出
  // 它們是同一件事。契約編號是決標公告上的唯一識別。
  test('契約編號已存在時擋下並指出既有工程', async () => {
    const { app, token } = await makeAppWithToken();
    await createViaAward(app, token, { project_no: '1150113', name: '南陽國小廁所工程' });
    const res = await createViaAward(app, token, { project_no: '1150113', name: '重複送的同一案' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已建立/);
    expect(res.body.existing).toEqual({
      id: expect.any(Number), name: '南陽國小廁所工程', project_no: '1150113',
    });
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM projects');
    expect(rows[0].n).toBe(1);
  });

  test('齊全時建立工程並歸檔決標公告', async () => {
    const { app, token } = await makeAppWithToken();
    const { rows: v } = await db.query(`INSERT INTO vendors (name) VALUES ('晉林') RETURNING id`);
    const { rows: s } = await db.query(`INSERT INTO schools (name) VALUES ('南陽國小') RETURNING id`);
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .field('name', '南陽國小廁所工程').field('project_no', '1150113')
      .field('award_amount', '3122168')
      .field('school_id', String(s[0].id)).field('vendor_id', String(v[0].id))
      .attach('award_notice', Buffer.from('%PDF-1.4'), '決標公告.pdf')
      .expect(201);
    expect(res.body.id).toEqual(expect.any(Number));
    const { rows } = await db.query(
      'SELECT * FROM project_attachments WHERE project_id = $1', [res.body.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('award_notice');
    expect(rows[0].original_name).toBe('決標公告.pdf');
  });
});

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
