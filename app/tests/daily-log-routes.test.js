process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-sp3-'));
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// 讀取器與 Excel COM 都不在本檔的測試範圍:前者由 parser-*.test.js 涵蓋,
// 後者由 SP0 整合測涵蓋。這裡驗的是路由的把關與落庫。
jest.mock('../server/parsers/registry', () => ({ getParser: jest.fn() }));
jest.mock('../server/template-engine', () => ({ fillTemplate: jest.fn() }));

const registry = require('../server/parsers/registry');
const { fillTemplate } = require('../server/template-engine');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerDailyLogRoutes } = require('../server/daily-log-routes');

const day = (填報日期, rows) => ({
  header: {
    工程名稱: '測試工程', 填報日期, 星期: null, 天氣_上午: '晴', 天氣_下午: '晴',
    預定進度: 10, 實際進度: 10, 本日累計金額: null,
  },
  dailyRows: rows,
});
const r = (項次, 本日完成數量, extra = {}) => ({
  項次, 工程項目: `項目${項次}`, 單位: '式', 契約單價: 100, 契約數量: 10,
  本日完成數量, 本日完成金額: 本日完成數量 == null ? null : 本日完成數量 * 100,
  累計完成數量: 本日完成數量, ...extra,
});

// DATE 欄位轉 'YYYY-MM-DD'(理由同 daily-log-routes.js 的 toISODate)
const iso = (v) => (typeof v === 'string' ? v.slice(0, 10)
  : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`);

const feed = (days) => registry.getParser.mockReturnValue({ parseAll: async () => days });

async function makeApp({ withContract = true, withVendor = true, start = '2026-04-08' } = {}) {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerDailyLogRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });

  let vendorId = null;
  if (withVendor) {
    const { rows } = await db.query(`INSERT INTO vendors (name) VALUES ('某某營造') RETURNING id`);
    vendorId = rows[0].id;
  }
  const { rows: p } = await db.query(
    `INSERT INTO projects (name, vendor_id, start_date, award_amount, contract_completion_date)
     VALUES ('測試工程', $1, $2, 100000, '2026-12-31') RETURNING id`, [vendorId, start]);
  const id = p[0].id;
  if (withContract) {
    await db.query(
      `INSERT INTO contract_items (project_id, seq, item_no, name, unit, quantity, unit_price)
       VALUES ($1, 1, '1', '項目1', '式', 10, 100)`, [id]);
  }
  return { app, token: setup.body.token, id };
}

const post = (app, token, id, route) => request(app)
  .post(`/api/projects/${id}/daily-logs/${route}`)
  .set('Authorization', `Bearer ${token}`)
  .attach('daily_log', Buffer.from('%PDF-1.4'), '施工日誌.pdf');

beforeEach(() => {
  jest.clearAllMocks();
  fillTemplate.mockImplementation(async (dest, tmp) => {
    fs.writeFileSync(tmp, 'xlsm');
    return { ok: true, outPath: tmp };
  });
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/daily-logs/parse`).expect(401);
});

// 缺哪一份基準就明講缺哪一份——回籠統的「無法處理」會讓承辦人不知道要去補什麼
test('尚未建立契約詳細價目表時擋下並指出要先做什麼', async () => {
  const { app, token, id } = await makeApp({ withContract: false });
  feed([day('2026-04-08', [r('1', 1)])]);
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/契約詳細價目表/);
  expect(res.body.error).toMatch(/發包經費總表/);
});

test('沒有對應廠商讀取器時擋下', async () => {
  const { app, token, id } = await makeApp();
  registry.getParser.mockReturnValue(null);
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/讀取器/);
});

test('尚未填開工日期時擋下(沒有它就決定不了要寫哪一欄)', async () => {
  const { app, token, id } = await makeApp({ start: null });
  feed([day('2026-04-08', [r('1', 1)])]);
  const res = await post(app, token, id, 'parse').expect(400);
  expect(res.body.error).toMatch(/開工日期/);
});

test('parse 回驗證結果與差異,且不落庫', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)]), day('2026-04-09', [r('1', 2, { 累計完成數量: 5 })])]);
  const res = await post(app, token, id, 'parse').expect(200);
  expect(res.body.天數).toBe(2);
  expect(res.body.errors).toEqual([]);
  expect(res.body.diff.added).toHaveLength(2);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
  expect(rows[0].n).toBe(0);
});

// 硬錯整份擋下(2026-08-05 裁決):只跳過有問題的那幾天,報表會停在「進度不完整」
// 的狀態,而累計金額與完成百分比都是公式自算——數字會是錯的,但看起來完全正常。
test('有硬錯時整份不寫入', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3, { 契約數量: null })])]); // A7
  const res = await post(app, token, id, 'confirm').expect(400);
  expect(res.body.errors.map((e) => e.code)).toContain('A7');
  expect(fillTemplate).not.toHaveBeenCalled();
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
  expect(rows[0].n).toBe(0);
});

test('無硬錯時寫入報表並落庫', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)]), day('2026-04-09', [r('1', 2, { 累計完成數量: 5 })])]);
  const res = await post(app, token, id, 'confirm').expect(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.天數).toBe(2);
  expect(fillTemplate).toHaveBeenCalledTimes(1);
  const { rows } = await db.query(
    `SELECT log_date, item_no, qty FROM daily_records
      WHERE project_id = $1 ORDER BY log_date`, [id]);
  expect(rows.map((x) => iso(x.log_date))).toEqual(['2026-04-08', '2026-04-09']);
});

// 「後面才發現前面錯了」是真實流程:同一天重送修正版要能蓋掉舊值
test('重送同一天時覆蓋舊紀錄', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-04-08', [r('1', 8)])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    'SELECT qty FROM daily_records WHERE project_id = $1', [id]);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].qty)).toBe(8);
});

// 分批提交是常態:第二批不含第一批的日期,不能把已寫入的進度清掉
test('送新的一批不會清掉先前批次的日期', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-05-06', [r('1', 2, { 累計完成數量: 5 })])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    `SELECT log_date FROM daily_records
      WHERE project_id = $1 ORDER BY log_date`, [id]);
  expect(rows.map((x) => iso(x.log_date))).toEqual(['2026-04-08', '2026-05-06']);
});

// 第二次上傳時要看得到「哪一天的哪一項從多少改成多少」,不能只說「已更新」
test('parse 對已寫入的日期回報逐項變更', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-04-08', [r('1', 9)])]);
  const res = await post(app, token, id, 'parse').expect(200);
  expect(res.body.diff.changed).toEqual([
    { 日期: '2026-04-08', 項次: '1', 舊: 3, 新: 9 },
  ]);
});

// Excel COM 失敗時不得留下「DB 說有、報表沒有」的紀錄
test('寫入報表失敗時不落庫', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  fillTemplate.mockRejectedValueOnce(new Error('Excel 驅動重試 3 次仍失敗'));
  const res = await post(app, token, id, 'confirm').expect(500);
  expect(res.body.error).not.toMatch(/Excel 驅動/);
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM daily_records');
  expect(rows[0].n).toBe(0);
});

test('來源日誌歸檔為 daily_log', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    `SELECT original_name FROM project_attachments WHERE project_id = $1 AND kind = 'daily_log'`,
    [id]);
  expect(rows).toHaveLength(1);
});

// 施工日誌是分批累積的,每一批都留著才有完整的來源憑據——不可比照開工報告表覆蓋
test('第二批日誌不覆蓋第一批的附件', async () => {
  const { app, token, id } = await makeApp();
  feed([day('2026-04-08', [r('1', 3)])]);
  await post(app, token, id, 'confirm').expect(200);
  feed([day('2026-05-06', [r('1', 2, { 累計完成數量: 5 })])]);
  await post(app, token, id, 'confirm').expect(200);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE project_id = $1 AND kind = 'daily_log'`,
    [id]);
  expect(rows[0].n).toBe(2);
});
