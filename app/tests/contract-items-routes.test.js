process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-sp2-'));
// ⚠️ 必須在 require 之前:history-routes 與 report-workbook 在 module load 時
// 就把資料根算好,晚一步設定會把附件與報表寫進正式 data/。
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// 不真的讀 Excel 檔:fixture 是從實檔抽出的 JSON(見 scripts/make-budget-fixtures.js)。
jest.mock('../server/budget-sheet', () => {
  const actual = jest.requireActual('../server/budget-sheet');
  return { ...actual, readSheets: jest.fn() };
});
// 不真的開 Excel COM:寫入層由 SP0 的整合測負責
jest.mock('../server/template-engine', () => ({
  fillTemplate: jest.fn().mockResolvedValue({ ok: true, outPath: 'x' }),
}));

const { readSheets } = require('../server/budget-sheet');
const { fillTemplate } = require('../server/template-engine');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerContractItemRoutes } = require('../server/contract-items-routes');

const fx = (key) => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'budget', `${key}.json`), 'utf8')).sheets;

// 讓 readSheets 依「第幾次呼叫」回不同 fixture,對應多檔上傳的順序
const feed = (...keys) => {
  readSheets.mockReset();
  for (const k of keys) readSheets.mockReturnValueOnce(fx(k));
};

async function makeApp({ award = 1036370 } = {}) {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerContractItemRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(
    `INSERT INTO projects (name, award_amount) VALUES ('測試工程', $1) RETURNING id`, [award]);
  return { app, token: setup.body.token, id: rows[0].id };
}

const attach = (req, names) => {
  for (const n of names) req.attach('budget_sheets', Buffer.from('x'), n);
  return req;
};

// fillTemplate 的契約是「把結果寫到 tmp」,路由接著 renameSync 換掉本尊。
// mock 不產生那個檔的話,測到的會是 ENOENT 而不是被測的行為。
beforeEach(() => {
  jest.clearAllMocks();
  fillTemplate.mockImplementation(async (dest, tmp) => {
    fs.writeFileSync(tmp, 'xlsm');
    return { ok: true, outPath: tmp };
  });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── parse ──────────────────────────────────────────────────

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/contract-items/parse`).expect(401);
});

test('沒帶檔案回 400', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`).expect(400);
  expect(res.body.error).toMatch(/發包經費總表/);
});

// 決標金額是挑表的唯一客觀判準。沒有它就只能靠分頁名稱猜,而實測那樣會 100%
// 挑到舊底稿殘留的那張。
test('工程沒有決標金額時擋下並說明原因', async () => {
  const { app, token, id } = await makeApp({ award: null });
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['a.xls']).expect(400);
  expect(res.body.error).toMatch(/決標金額/);
});

test('單張命中時直接回選定結果', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['大美.xlsm']).expect(200);
  expect(res.body.selected.合計).toBe(1036370);
  expect(res.body.selected.matched[0].file).toBe('大美.xlsm');
  expect(res.body.selected.items.length).toBe(30);
  // parse 純唯讀:有卡控問題時若已落庫,系統裡就會留下一份沒人確認過的價目表
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('跨兩檔相加命中時兩張都回傳', async () => {
  const { app, token, id } = await makeApp({ award: 1684045 });
  feed('chongxing-toilet', 'chongxing-sewage');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['廁所.xls', '汙水.xls']).expect(200);
  expect(res.body.selected.matched).toHaveLength(2);
  expect(res.body.selected.合計).toBe(1684045);
});

// 對不上時系統挑哪一張都可能是錯的,要把候選攤開讓承辦人自己看
test('對不上決標金額時回候選清單而非硬選一張', async () => {
  const { app, token, id } = await makeApp({ award: 999999 });
  feed('nanyang');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['南陽.xls']).expect(200);
  expect(res.body.selected).toBe(null);
  expect(res.body.candidates.map((c) => c.合計).sort((a, b) => a - b))
    .toEqual([1587660, 3122168]);
});

test('檔案沒有任何明細分頁時明確說明', async () => {
  const { app, token, id } = await makeApp();
  feed('taichung-nodetail');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['臺中.xlsm']).expect(400);
  expect(res.body.error).toMatch(/沒有.*明細|施工項目/);
});

// ── confirm ────────────────────────────────────────────────

const confirm = (app, token, id, files, picks) =>
  attach(request(app).post(`/api/projects/${id}/contract-items/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('picks', JSON.stringify(picks)), files);

test('確認後寫入報表並落庫', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  const res = await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }])
    .expect(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.count).toBe(30);
  expect(fillTemplate).toHaveBeenCalledTimes(1);

  const { rows } = await db.query(
    'SELECT item_no, name, quantity, unit_price FROM contract_items WHERE project_id = $1 ORDER BY seq',
    [id]);
  expect(rows).toHaveLength(30);
  expect(rows[0].item_no).toBe('1');
  expect(rows[rows.length - 1].item_no).toBe('陸'); // 費用項目排在最後
});

// 前端只送「選了哪幾張分頁」,項目一律由後端重新解析。信任前端送來的項目等於
// 讓任何人繞過卡控直接寫進契約價目表。
test('確認時重新解析檔案,不吃前端送來的項目', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  expect(readSheets).toHaveBeenCalled();
});

test('選定的組合合計對不上決標金額時擋下', async () => {
  const { app, token, id } = await makeApp({ award: 3122168 });
  feed('nanyang');
  const res = await confirm(app, token, id, ['南陽.xls'], [{ file: '南陽.xls', name: '詳細價目表' }])
    .expect(400);
  expect(res.body.error).toMatch(/決標金額/);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('指定不存在的分頁時擋下', async () => {
  const { app, token, id } = await makeApp();
  feed('damei');
  const res = await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '不存在的分頁' }])
    .expect(400);
  expect(res.body.error).toMatch(/分頁/);
});

// 重傳時整張覆蓋,舊的項目紀錄不能留著——留著的話下次比差異會拿到兩個版本混在一起
test('重傳時覆蓋既有項目紀錄', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM contract_items WHERE project_id = $1', [id]);
  expect(rows[0].n).toBe(30);
});

// 廠商會改舊項目,不是只會加新項目。覆蓋前要讓承辦人看到改了什麼。
test('已有價目表時 parse 回傳差異', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  // 第二次拿另一份(項目完全不同)來比
  await db.query('UPDATE contract_items SET unit_price = 1 WHERE seq = 1 AND project_id = $1', [id]);
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['大美.xlsm']).expect(200);
  expect(res.body.diff.changed).toHaveLength(1);
});

test('第一次建立時差異為全新增', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  const res = await attach(request(app).post(`/api/projects/${id}/contract-items/parse`)
    .set('Authorization', `Bearer ${token}`), ['大美.xlsm']).expect(200);
  expect(res.body.diff.added).toHaveLength(30);
  expect(res.body.diff.removed).toHaveLength(0);
});

// Excel COM 失敗時不得留下一份「DB 說有、報表沒有」的價目表
test('寫入報表失敗時不落庫', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  fillTemplate.mockRejectedValueOnce(new Error('Excel 驅動重試 3 次仍失敗'));
  const res = await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }])
    .expect(500);
  expect(res.body.error).not.toMatch(/Excel 驅動/); // 內部細節不外洩
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM contract_items');
  expect(rows[0].n).toBe(0);
});

test('來源檔歸檔為 budget_sheet 且重傳只留最新', async () => {
  const { app, token, id } = await makeApp({ award: 1036370 });
  feed('damei');
  await confirm(app, token, id, ['大美.xlsm'], [{ file: '大美.xlsm', name: '詳細價目表' }]).expect(200);
  feed('damei');
  await confirm(app, token, id, ['大美修正.xlsm'], [{ file: '大美修正.xlsm', name: '詳細價目表' }]).expect(200);
  const { rows } = await db.query(
    `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'budget_sheet'`,
    [id]);
  expect(rows.map((r) => r.original_name)).toEqual(['大美修正.xlsm']);
});
