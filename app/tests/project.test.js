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

/**
 * 一份最小的契約詳細價目表:主體 1,000,000 + 保險費 3,000 + 營業稅 50,000
 * = 發包工程費 1,053,000,建造費用 1,000,000。
 * 直接寫 DB 而不走 SP2 路由:那條路要真的開 Excel COM,而這裡要驗的是設計費的算式。
 */
async function insertItems(projectId, { 保險費名稱 = '營造綜合保險費' } = {}) {
  const rows = [
    ['1', '主體工程', 1, 1000000],
    ['伍', 保險費名稱, 1, 3000],
    ['陸', '營業稅((壹~伍)*5%)', 1, 50000],
  ];
  for (let i = 0; i < rows.length; i++) {
    await db.query(
      `INSERT INTO contract_items (project_id, seq, item_no, name, unit, quantity, unit_price)
       VALUES ($1, $2, $3, $4, '式', $5, $6)`,
      [projectId, i + 1, rows[i][0], rows[i][1], rows[i][2], rows[i][3]]
    );
  }
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

  // ⚠️ 百分比法乘的是**建造費用**(發包工程費−保險費−營業稅),不是決標金額。
  // 49 案實測建造費用是決標金額的 94.6%~95.1%,拿決標金額算會一律多收約 5%
  // ——這是計費規則,直接影響請款金額。
  test('pct 以建造費用 × % 並 half-up,不是拿決標金額算', () => {
    // 建造費用 1,234,567 × 2.5% = 30864.175 → 30864
    const p = { design_fee_type: 'pct', award_amount: 9999999, design_fee_pct: 2.5 };
    expect(computeDesignFeeActual(p, 1234567).design_fee_actual).toBe(30864);
    // 決標金額比建造費用大得多,若實作退回用它算,上面那個數就會變成 249999
  });

  test('pct 進位邊界 half-up(非銀行家)', () => {
    // 100 × 2.5% = 2.5 → 3
    const r = computeDesignFeeActual({ design_fee_type: 'pct', award_amount: 100, design_fee_pct: 2.5 }, 100);
    expect(r.design_fee_actual).toBe(3);
  });

  test('pct 但決標金額未填 → null + unbid', () => {
    const r = computeDesignFeeActual({ design_fee_type: 'pct', award_amount: null, design_fee_pct: 3 }, 100);
    expect(r.design_fee_actual).toBe(null);
    expect(r.unbid).toBe(true);
  });

  // 算不出建造費用時**不可以退回用決標金額硬算**——那正是原本錯的那個數,
  // 而且錯得看起來完全正常(金額合理、沒有任何錯誤訊息)。
  test('pct 但建造費用算不出來 → null + needs_items,不退回決標金額', () => {
    const r = computeDesignFeeActual({ design_fee_type: 'pct', award_amount: 1000000, design_fee_pct: 3 }, null);
    expect(r.design_fee_actual).toBe(null);
    expect(r.needs_items).toBe(true);
    expect(r.unbid).toBe(false);
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

  // 建造費用要由契約詳細價目表算出,建案當下一定還沒有——此時給 null 並講出
  // 缺什麼,而不是拿決標金額硬算一個看起來很正常的數字出來。
  test('建立工程(pct)時還沒有價目表 → 設計費待補,不拿決標金額硬算', async () => {
    const res = await createViaAward(app, token, {
      name: '操場工程', award_amount: 1234567,
      design_fee_type: 'pct', design_fee_pct: 2.5,
    });
    expect(res.status).toBe(201);
    expect(res.body.design_fee_actual).toBe(null);
    expect(res.body.design_fee_needs_items).toBe(true);
  });

  // 建造費用 = 發包工程費 − 保險費 − 營業稅。用名稱認保險費與營業稅
  // (49 案實測各恰好一列);複價由數量×單價重算(DB 不存複價)。
  test('有了價目表之後,pct 設計費以建造費用計算', async () => {
    const created = await createViaAward(app, token, {
      name: '操場工程', award_amount: 1053000,
      design_fee_type: 'pct', design_fee_pct: 2.5,
    });
    await insertItems(created.body.id);
    const got = await auth(request(app).get(`/api/projects/${created.body.id}`));
    // 發包工程費 1,053,000 − 保險費 3,000 − 營業稅 50,000 = 1,000,000
    expect(got.body.design_fee_base).toBe(1000000);
    expect(got.body.design_fee_actual).toBe(25000); // 1,000,000 × 2.5%
    expect(got.body.design_fee_needs_items).toBe(false);
  });

  // 認不出保險費/營業稅時寧可算不出來:少扣一項會讓設計費偏高,而那個偏高的
  // 數字看起來完全正常,沒有人會發現。
  test('價目表裡認不出保險費或營業稅 → 設計費待補', async () => {
    const created = await createViaAward(app, token, {
      name: '操場工程', award_amount: 1053000,
      design_fee_type: 'pct', design_fee_pct: 2.5,
    });
    await insertItems(created.body.id, { 保險費名稱: '雜項費用' });
    const got = await auth(request(app).get(`/api/projects/${created.body.id}`));
    expect(got.body.design_fee_actual).toBe(null);
    expect(got.body.design_fee_needs_items).toBe(true);
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
    await insertItems(created.body.id);
    const upd = await auth(request(app).put(`/api/projects/${created.body.id}`)).send({
      name: '工程A', award_amount: 1053000, design_fee_type: 'pct', design_fee_pct: 10
    });
    expect(upd.status).toBe(200);
    expect(upd.body.design_fee_actual).toBe(100000); // 建造費用 1,000,000 × 10%
  });

  // 承辦人平常找檔案用的是**事務所編號**,不是契約編號(使用者清單第 19 項),
  // 所以那個編號也必須搜得到——搜不到就等於這個欄位只能用眼睛在列表上找。
  test('搜尋 ?q= 依名稱、工程編號或事務所編號過濾', async () => {
    await createViaAward(app, token, { name: '操場工程', project_no: 'P-100', firm_doc_no: '11401' });
    await createViaAward(app, token, { name: '校舍整修', project_no: 'P-200', firm_doc_no: '11402' });
    const byName = await auth(request(app).get('/api/projects?q=操場'));
    expect(byName.body).toHaveLength(1);
    const byNo = await auth(request(app).get('/api/projects?q=P-200'));
    expect(byNo.body).toHaveLength(1);
    expect(byNo.body[0].name).toBe('校舍整修');
    const byFirmNo = await auth(request(app).get('/api/projects?q=11401'));
    expect(byFirmNo.body).toHaveLength(1);
    expect(byFirmNo.body[0].name).toBe('操場工程');
  });

  // 列表與狀態總表都依事務所編號排序(使用者清單第 21 項)。沒填編號的排最後
  // ——不能讓它們卡在中間,那會讓「照編號一路往下看」這件事直接失效。
  test('列表依事務所編號排序,沒填的排最後', async () => {
    await createViaAward(app, token, { name: 'C 案', firm_doc_no: '11403' });
    await createViaAward(app, token, { name: '沒編號的案' });
    await createViaAward(app, token, { name: 'A 案', firm_doc_no: '11401' });
    const res = await auth(request(app).get('/api/projects'));
    expect(res.body.map((p) => p.name)).toEqual(['A 案', 'C 案', '沒編號的案']);
  });

  test('狀態總表也依事務所編號排序', async () => {
    await createViaAward(app, token, { name: 'C 案', firm_doc_no: '11403' });
    await createViaAward(app, token, { name: 'A 案', firm_doc_no: '11401' });
    const res = await auth(request(app).get('/api/projects/status-board?status=全部'));
    expect(res.body.projects.map((p) => p.name)).toEqual(['A 案', 'C 案']);
  });

  // 一張決標含多個標的(橋頭國小＋許厝分校、重興廁所＋汙水…)在總表上是兩列,
  // 看起來像兩個不相干的案子,而每一列的金額只是該標的的金額。
  test('同一張決標的多個標的要標出來,單一標的不標', async () => {
    await createViaAward(app, token, { name: '橋頭國小廁所', project_no: 'A1150507' });
    await createViaAward(app, token, { name: '許厝分校廁所', project_no: 'A1150507' });
    await createViaAward(app, token, { name: '單一標的案', project_no: 'A1150999' });
    const res = await auth(request(app).get('/api/projects/status-board?status=全部'));
    const by = Object.fromEntries(res.body.projects.map((p) => [p.name, p.同決標標的數]));
    expect(by['橋頭國小廁所']).toBe(2);
    expect(by['許厝分校廁所']).toBe(2);
    expect(by['單一標的案']).toBe(1);
  });

  // 統計要在**過濾之前**做:一個標的完工、另一個施工中時只看得到一列,
  // 而那一列仍該顯示「2 個標的之一」——否則承辦人以為這案就這一個。
  test('另一個標的被狀態篩掉時,仍要標出總標的數', async () => {
    await createViaAward(app, token, {
      name: '施工中標的', project_no: 'B1150001', start_date: '2020-01-01',
    });
    await createViaAward(app, token, {
      name: '已完工標的', project_no: 'B1150001',
      start_date: '2020-01-01', actual_completion_date: '2020-06-01',
    });
    const res = await auth(request(app).get('/api/projects/status-board?status=施工中'));
    const 列 = res.body.projects.filter((p) => p.project_no === 'B1150001');
    expect(列).toHaveLength(1);
    expect(列[0].name).toBe('施工中標的');
    expect(列[0].同決標標的數).toBe(2);
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

// 一個工程常同時投營造綜合保險與意外責任險等數種,原本 projects.insurance_type_id
// 是單一 FK,承辦人只能挑一個填、其餘沒有地方記。
describe('工程投保險種(多選)', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  async function 建險種(n) {
    const { rows: ins } = await db.query(`INSERT INTO insurers (name) VALUES ('新光產物') RETURNING id`);
    const ids = [];
    for (let i = 1; i <= n; i++) {
      const { rows } = await db.query(
        'INSERT INTO insurance_types (insurer_id, name) VALUES ($1, $2) RETURNING id',
        [ins[0].id, `險種${i}`]);
      ids.push(rows[0].id);
    }
    return { insurerId: ins[0].id, typeIds: ids };
  }
  const put = (id, body) => request(app).put(`/api/projects/${id}`)
    .set('Authorization', `Bearer ${token}`).send({ name: '工程', ...body });

  test('存得下多個險種,讀得回來', async () => {
    const { typeIds } = await 建險種(3);
    const c = await createViaAward(app, token, { name: '工程' });
    const res = await put(c.body.id, { insurance_type_ids: [typeIds[0], typeIds[2]] }).expect(200);
    expect(res.body.insurance_type_ids.sort()).toEqual([typeIds[0], typeIds[2]].sort());
    const got = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(got.body.insurance_type_ids.sort()).toEqual([typeIds[0], typeIds[2]].sort());
  });

  test('整批取代:再送一次只留新的那組', async () => {
    const { typeIds } = await 建險種(3);
    const c = await createViaAward(app, token, { name: '工程' });
    await put(c.body.id, { insurance_type_ids: [typeIds[0], typeIds[1]] }).expect(200);
    const res = await put(c.body.id, { insurance_type_ids: [typeIds[2]] }).expect(200);
    expect(res.body.insurance_type_ids).toEqual([typeIds[2]]);
  });

  test('送空陣列 = 全部取消投保', async () => {
    const { typeIds } = await 建險種(2);
    const c = await createViaAward(app, token, { name: '工程' });
    await put(c.body.id, { insurance_type_ids: typeIds }).expect(200);
    const res = await put(c.body.id, { insurance_type_ids: [] }).expect(200);
    expect(res.body.insurance_type_ids).toEqual([]);
  });

  // PUT 是整筆取代,而別處(如開工報告表補寫主檔)送的 body 本來就沒有這個欄位。
  // 一律當成清空會把承辦人選好的險種靜默清掉。
  test('沒帶這個欄位時不動既有險種', async () => {
    const { typeIds } = await 建險種(2);
    const c = await createViaAward(app, token, { name: '工程' });
    await put(c.body.id, { insurance_type_ids: typeIds }).expect(200);
    const res = await put(c.body.id, {}).expect(200);
    expect(res.body.insurance_type_ids.sort()).toEqual(typeIds.sort());
  });

  test('重複送同一個 id 不會在表裡留兩列', async () => {
    const { typeIds } = await 建險種(1);
    const c = await createViaAward(app, token, { name: '工程' });
    const res = await put(c.body.id, { insurance_type_ids: [typeIds[0], typeIds[0]] }).expect(200);
    expect(res.body.insurance_type_ids).toEqual([typeIds[0]]);
  });

  // 升級前用單一 FK 存的資料要自動搬進新表,否則承辦人一進畫面會發現險種不見了
  test('舊的單一險種資料在 migrate 時搬進多選表', async () => {
    const { typeIds } = await 建險種(1);
    const c = await createViaAward(app, token, { name: '舊案' });
    await db.query('UPDATE projects SET insurance_type_id = $1 WHERE id = $2', [typeIds[0], c.body.id]);
    await db.migrate();               // 重跑 migrate 模擬升級
    const got = await request(app).get(`/api/projects/${c.body.id}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(got.body.insurance_type_ids).toEqual([typeIds[0]]);
  });

  // 搬移要冪等:migrate 每次啟動都跑,重複插入會讓險種一次比一次多
  test('migrate 重跑不會重複搬', async () => {
    const { typeIds } = await 建險種(1);
    const c = await createViaAward(app, token, { name: '舊案' });
    await db.query('UPDATE projects SET insurance_type_id = $1 WHERE id = $2', [typeIds[0], c.body.id]);
    await db.migrate();
    await db.migrate();
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM project_insurance_types WHERE project_id = $1', [c.body.id]);
    expect(rows[0].n).toBe(1);
  });
});

// ── 複製工程(一張決標拆多個標的)────────────────────────────
// 2026-08-13 已裁決維持「一標的一工程」,缺的只是「第二個工程要重打一次共同欄位」。
describe('POST /api/projects/:id/duplicate', () => {
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  test('共同欄位都帶過去,名稱換成新的', async () => {
    const { app, token } = await makeAppWithToken();
    const made = await createViaAward(app, token, { name: '重興國小廁所', award_amount: 1684045 });
    const id = made.body.id;
    await db.query(
      `UPDATE projects SET start_date = '2026-07-21', contract_completion_date = '2026-12-27',
              duration_days = 160, duration_basis = '日曆天',
              supervisor_firm = '呂罡銘建築師事務所', firm_doc_no = 'F-001',
              actual_completion_date = '2026-12-01' WHERE id = $1`, [id]);

    const res = await request(app).post(`/api/projects/${id}/duplicate`)
      .set('Authorization', `Bearer ${token}`).send({ name: '重興國小汙水' }).expect(200);

    const p = res.body.project;
    expect(p.name).toBe('重興國小汙水');
    expect(p.id).not.toBe(id);
    const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [p.id]);
    const n = rows[0];
    // 決標帶來的共同欄位要跟著走
    expect(n.project_no).toBe(made.body.project_no);
    expect(n.duration_days).toBe(160);
    expect(n.duration_basis).toBe('日曆天');
    expect(n.supervisor_firm).toBe('呂罡銘建築師事務所');
    expect(n.start_date.toISOString().slice(0, 10)).toBe('2026-07-21');
    // 各自的東西不可複製:實際完工日與事務所自己的歸檔編號都是一案一個
    expect(n.actual_completion_date).toBeNull();
    expect(n.firm_doc_no).toBeNull();
  });

  // 承辦人選的流程是「上傳附件後自己拆金額」,所以照抄總額——但要當場講明白,
  // 忘了拆的話要到價目表那關才會被擋,而那句訊息說的是「合計對不上」。
  test('決標金額照抄總額,並回一句提醒要改', async () => {
    const { app, token } = await makeAppWithToken();
    const made = await createViaAward(app, token, { name: '重興國小廁所', award_amount: 1684045 });
    const res = await request(app).post(`/api/projects/${made.body.id}/duplicate`)
      .set('Authorization', `Bearer ${token}`).send({ name: '重興國小汙水' }).expect(200);
    const { rows } = await db.query('SELECT award_amount FROM projects WHERE id = $1', [res.body.project.id]);
    expect(Number(rows[0].award_amount)).toBe(1684045);
    expect(res.body.提醒).toMatch(/1,684,045/);
    expect(res.body.提醒).toMatch(/本標的的金額/);
  });

  // 明細正是兩個標的不同的地方,複製過去會讓承辦人以為已經做過
  test('契約項目與施工日誌一律不複製', async () => {
    const { app, token } = await makeAppWithToken();
    const made = await createViaAward(app, token, { name: '重興國小廁所' });
    await insertItems(made.body.id);
    const res = await request(app).post(`/api/projects/${made.body.id}/duplicate`)
      .set('Authorization', `Bearer ${token}`).send({ name: '重興國小汙水' }).expect(200);
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM contract_items WHERE project_id = $1', [res.body.project.id]);
    expect(rows[0].n).toBe(0);
  });

  test('決標公告附件跟著複製過去', async () => {
    const { app, token } = await makeAppWithToken();
    const made = await createViaAward(app, token, { name: '重興國小廁所' });
    const res = await request(app).post(`/api/projects/${made.body.id}/duplicate`)
      .set('Authorization', `Bearer ${token}`).send({ name: '重興國小汙水' }).expect(200);
    const { rows } = await db.query(
      `SELECT kind FROM project_attachments WHERE project_id = $1`, [res.body.project.id]);
    expect(rows.map((r) => r.kind)).toContain('award_notice');
    expect(res.body.attachment_warning).toBeNull();
  });

  test('名稱沒填或與原工程相同時擋下', async () => {
    const { app, token } = await makeAppWithToken();
    const made = await createViaAward(app, token, { name: '重興國小廁所' });
    const url = `/api/projects/${made.body.id}/duplicate`;
    const a = await request(app).post(url).set('Authorization', `Bearer ${token}`)
      .send({ name: '  ' }).expect(400);
    expect(a.body.error).toMatch(/名稱/);
    const b = await request(app).post(url).set('Authorization', `Bearer ${token}`)
      .send({ name: '重興國小廁所' }).expect(400);
    expect(b.body.error).toMatch(/分不出來/);
  });

  test('同案號同名的工程已存在時擋下', async () => {
    const { app, token } = await makeAppWithToken();
    const made = await createViaAward(app, token, { name: '重興國小廁所' });
    const url = `/api/projects/${made.body.id}/duplicate`;
    await request(app).post(url).set('Authorization', `Bearer ${token}`)
      .send({ name: '重興國小汙水' }).expect(200);
    const again = await request(app).post(url).set('Authorization', `Bearer ${token}`)
      .send({ name: '重興國小汙水' }).expect(400);
    expect(again.body.error).toMatch(/已有同案號同名/);
  });

  test('未帶 token 回 401、工程不存在回 404', async () => {
    const { app, token } = await makeAppWithToken();
    await request(app).post('/api/projects/1/duplicate').send({ name: 'x' }).expect(401);
    await request(app).post('/api/projects/999999/duplicate')
      .set('Authorization', `Bearer ${token}`).send({ name: 'x' }).expect(404);
  });
});
