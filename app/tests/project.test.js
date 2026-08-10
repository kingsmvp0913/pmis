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
  // 它們是同一件事。
  test('同一個契約編號 + 同一個工程名稱才算重複,擋下並指出既有工程', async () => {
    const { app, token } = await makeAppWithToken();
    await createViaAward(app, token, { project_no: '1150113', name: '南陽國小廁所工程' });
    const res = await createViaAward(app, token, { project_no: '1150113', name: '南陽國小廁所工程' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/已建立/);
    expect(res.body.existing).toEqual({
      id: expect.any(Number), name: '南陽國小廁所工程', project_no: '1150113',
    });
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM projects');
    expect(rows[0].n).toBe(1);
  });

  // 契約編號**本身不是唯一的**:一次決標含多個標的、或機關的編號規則就會重複。
  // 只看案號會把合法的第二個工程擋在門外,而承辦人沒有別的路可以建。
  test('契約編號重複但工程名稱不同時要放行', async () => {
    const { app, token } = await makeAppWithToken();
    await createViaAward(app, token, { project_no: '1150113', name: '南陽國小廁所工程' });
    const res = await createViaAward(app, token, { project_no: '1150113', name: '南陽國小汙水工程' });
    expect(res.status).toBe(201);
    const { rows } = await db.query(
      'SELECT name FROM projects WHERE project_no = $1 ORDER BY id', ['1150113']);
    expect(rows.map((r) => r.name)).toEqual(['南陽國小廁所工程', '南陽國小汙水工程']);
  });

  // 事務所自己的檔案編號,與決標公告上的契約編號並存——兩者用途不同,
  // 對外文書引契約編號,事務所內部歸檔與狀態總表找案子用自己的編號。
  test('事務所檔案編號可存可讀,且與契約編號並存', async () => {
    const { app, token } = await makeAppWithToken();
    const created = await createViaAward(app, token, { project_no: '1150113', name: '南陽' });
    // PUT 是整筆取代(前端送的是整份表單),故要帶著 name 一起送
    const res = await request(app).put(`/api/projects/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '南陽', project_no: '1150113', firm_doc_no: '呂罡銘-114-021' })
      .expect(200);
    expect(res.body.firm_doc_no).toBe('呂罡銘-114-021');
    expect(res.body.project_no).toBe('1150113');
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

// 工程頁的流程狀態列要的兩個計數。專開端點而不是塞進 GET /projects/:id——
// 那支是列表與編輯頁共用的,每次都多兩個 COUNT 只為了一列狀態並不划算。
describe('GET /api/projects/:id/workflow-status', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  test('尚未建立契約表與施工日誌時皆為 0', async () => {
    const created = await createViaAward(app, token, { name: '狀態測試' });
    const res = await request(app).get(`/api/projects/${created.body.id}/workflow-status`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual({ contractItems: 0, logDays: 0 });
  });

  // 同一天多個項次只算一天:狀態列要講的是「寫了幾天進度」,不是幾筆資料
  test('契約項目數與施工日誌天數各自計數', async () => {
    const created = await createViaAward(app, token, { name: '狀態測試2' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO contract_items (project_id, seq, item_no, name, unit, quantity, unit_price)
       VALUES ($1, 1, '1', 'A', '式', 1, 100), ($1, 2, '2', 'B', '式', 1, 200)`, [id]);
    await db.query(
      `INSERT INTO daily_records (project_id, log_date, item_no, qty)
       VALUES ($1, '2026-04-08', '1', 1), ($1, '2026-04-08', '2', 2), ($1, '2026-04-09', '1', 3)`,
      [id]);
    const res = await request(app).get(`/api/projects/${id}/workflow-status`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toEqual({ contractItems: 2, logDays: 2 });
  });

  test('未帶 token 回 401', async () => {
    await request(app).get('/api/projects/1/workflow-status').expect(401);
  });
});

describe('GET /api/projects 流程狀態欄位', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  // 列表頁的四顆流程按鈕靠這四個欄位決定 ✓／下一步／disabled。少了它們,
  // 承辦人得逐個點開才知道哪個做過了——那正是這次改版要消滅的來回。
  test('回傳附件種類、契約項目數與施工日誌天數', async () => {
    const created = await createViaAward(app, token, { name: '狀態工程' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path)
       VALUES ($1, 'kickoff_report', 'k.pdf')`, [id]
    );
    await db.query(
      `INSERT INTO contract_items (project_id, seq, item_no, name, quantity, unit_price)
       VALUES ($1, 1, '1', '項目A', 10, 100), ($1, 2, '2', '項目B', 5, 200)`, [id]
    );
    const res = await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const row = res.body.find((r) => r.id === id);
    expect(row.has_kickoff).toBe(true);
    expect(row.has_budget).toBe(false);
    expect(row.contract_items).toBe(2);
    expect(row.log_days).toBe(0);
  });

  // pg-mem 不支援 COUNT(DISTINCT …) 且會**靜默算錯**(見 project-routes.js 的
  // /workflow-status 路由 logDays 子查詢處註解),
  // 故這條必須釘住:同一天的多個項次只能算一天,否則列表會顯示「已寫 3 天」
  // 而實際只有 2 天。
  test('同一天多個項次只算一天', async () => {
    const created = await createViaAward(app, token, { name: '日誌工程' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO daily_records (project_id, log_date, item_no, qty)
       VALUES ($1, '2026-01-26', '1', 3), ($1, '2026-01-26', '2', 4),
              ($1, '2026-01-27', '1', 5)`, [id]
    );
    const res = await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.find((r) => r.id === id).log_days).toBe(2);
  });

  // 搜尋走的是另一條 SQL 分支。少補這一條的話,一搜尋標記就全部消失,
  // 而承辦人最常用的正是搜尋。
  test('搜尋模式同樣帶這四個欄位', async () => {
    const created = await createViaAward(app, token, { name: '可搜尋工程' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path)
       VALUES ($1, 'budget_sheet', 'b.xlsx')`, [id]
    );
    const res = await request(app).get('/api/projects?q=可搜尋')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const row = res.body.find((r) => r.id === id);
    expect(row.has_budget).toBe(true);
    expect(row.has_kickoff).toBe(false);
    expect(row.contract_items).toBe(0);
    expect(row.log_days).toBe(0);
  });

  // 什麼都沒有的工程要回 false/0,不是 null 或缺欄位——前端用 `row.contract_items > 0`
  // 判定,undefined 會靜默變成 false 而看不出是「沒資料」還是「後端沒回」。
  test('無附件無項目的工程回 false 與 0,欄位不得缺漏', async () => {
    const created = await createViaAward(app, token, { name: '空工程' });
    const row = (await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${token}`).expect(200))
      .body.find((r) => r.id === created.body.id);
    expect(row.has_kickoff).toBe(false);
    expect(row.has_budget).toBe(false);
    expect(row.contract_items).toBe(0);
    expect(row.log_days).toBe(0);
  });
});

describe('工程狀態與狀態總表', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  const 前天 = () => {
    const d = new Date(); d.setDate(d.getDate() - 2);
    return d.toISOString().slice(0, 10);
  };
  const 後天 = () => {
    const d = new Date(); d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  };
  const board = (q = '') => request(app)
    .get(`/api/projects/status-board${q}`).set('Authorization', `Bearer ${token}`);

  // 狀態是推導的,不存欄位——存了就會有「日期改了狀態沒改」的不一致,
  // 而那種不一致沒有人會發現。
  test('沒有開工日 → 未開工', async () => {
    const c = await createViaAward(app, token, { name: '未開工案' });
    const res = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.status).toBe('未開工');
  });

  // 開工日填了未來的日期(已排定但還沒動工)不能算施工中
  test('開工日在未來 → 仍是未開工', async () => {
    const c = await createViaAward(app, token, { name: '排定案', start_date: 後天() });
    const res = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.status).toBe('未開工');
  });

  test('開工日已過且未填實際竣工日 → 施工中', async () => {
    const c = await createViaAward(app, token, { name: '施工案', start_date: 前天() });
    const res = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.status).toBe('施工中');
  });

  // 竣工看的是**實際**竣工日;契約竣工日只是預定,過了不代表完工
  test('契約竣工日已過但沒填實際竣工日 → 還是施工中', async () => {
    const c = await createViaAward(app, token, {
      name: '逾期案', start_date: 前天(), contract_completion_date: 前天(),
    });
    const res = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.status).toBe('施工中');
  });

  test('填了實際竣工日 → 已竣工', async () => {
    const c = await createViaAward(app, token, {
      name: '完工案', start_date: 前天(), actual_completion_date: 前天(),
    });
    const res = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.status).toBe('已竣工');
  });

  // 承辦人每天要盯的就是施工中那幾案,故預設只回這些
  test('狀態總表預設只回施工中', async () => {
    await createViaAward(app, token, { name: '施工案', start_date: 前天() });
    await createViaAward(app, token, { name: '未開工案' });
    await createViaAward(app, token, {
      name: '完工案', start_date: 前天(), actual_completion_date: 前天(),
    });
    const res = await board().expect(200);
    expect(res.body.筆數).toBe(1);
    expect(res.body.projects.map((p) => p.name)).toEqual(['施工案']);
  });

  test('狀態總表帶齊事務所編號、廠商、學校與兩個日期', async () => {
    const c = await createViaAward(app, token, { name: '施工案', start_date: 前天() });
    await request(app).put(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '施工案', start_date: 前天(), firm_doc_no: '呂-114-007' })
      .expect(200);
    const row = (await board().expect(200)).body.projects[0];
    expect(row.firm_doc_no).toBe('呂-114-007');
    expect(row).toHaveProperty('vendor_name');
    expect(row).toHaveProperty('school_name');
    expect(row).toHaveProperty('start_date');
    expect(row).toHaveProperty('contract_completion_date');
  });

  test('?status=全部 回全部工程', async () => {
    await createViaAward(app, token, { name: '施工案', start_date: 前天() });
    await createViaAward(app, token, { name: '未開工案' });
    const res = await board('?status=全部').expect(200);
    expect(res.body.筆數).toBe(2);
  });
});
