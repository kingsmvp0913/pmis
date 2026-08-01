process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// OCR 不在測試中真的跑(spec §8),以固定輸出當 fixture
jest.mock('../server/kickoff-report', () => ({ readKickoffReport: jest.fn() }));
jest.mock('../server/award-notice', () => ({ readAwardNotice: jest.fn() }));
const { readKickoffReport } = require('../server/kickoff-report');
const { readAwardNotice } = require('../server/award-notice');

const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerKickoffRoutes } = require('../server/kickoff-routes');

const KICKOFF = {
  工程名稱: '南陽廁所整修', 契約編號: '1150113', 契約金額: 3122168,
  決標日期: '2026-03-18', 契約工期: { 天數: 150, 基準: '日曆天' },
  主辦機關: '雲林縣北港鎮南陽國民小學', 縣市: '雲林縣',
  契約規定開工日: '2026-03-18', 契約規定竣工日: '2026-08-14',
};
const AWARD = {
  工程名稱: '南陽廁所整修', 工程編號: '1150113', 契約金額: 3122168,
  決標日期: '115/03/18', 主辦機關: '雲林縣北港鎮南陽國民小學',
  履約地點: '雲林縣', 履約起迄: { 起: '115/03/18', 迄: '115/08/14' },
};

async function makeApp({ withAward = true } = {}) {
  const mem = newDb();
  db._setPoolForTesting(new (mem.adapters.createPg()).Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerKickoffRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(`INSERT INTO projects (name) VALUES ('南陽廁所整修') RETURNING id`);
  const id = rows[0].id;
  if (withAward) {
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path, original_name)
       VALUES ($1, 'award_notice', $2, 'a.pdf')`, [id, `uploads/proj_${id}/a.pdf`]);
  }
  return { app, token: setup.body.token, id };
}

beforeEach(() => jest.clearAllMocks());

test('未帶 token 回 401', async () => {
  const { app, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/kickoff-report/parse`).expect(401);
});

test('沒帶檔案回 400', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`).expect(400);
  expect(res.body.error).toMatch(/開工報告表/);
});

// id 形狀不合法會讓 PostgreSQL 丟型別錯誤被 catch 成 500,
// 承辦人會以為系統壞了(沿用 project-basics-routes 的 isProjectIdShape)
test('工程不存在回 404', async () => {
  const { app, token } = await makeApp();
  await request(app).post('/api/projects/abc/kickoff-report/parse')
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(404);
});

test('parse 回比對結果且不落檔', async () => {
  readKickoffReport.mockResolvedValue(KICKOFF);
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
  expect(res.body.hasAward).toBe(true);
  expect(res.body.rows.find((r) => r.欄位 === '工程名稱').狀態).toBe('match');
  // 純唯讀:parse 不得產生附件,否則有硬錯時會留下垃圾
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 舊案補登只需工程名稱(spec §8),沒有決標公告不得阻擋
test('無決標公告時仍可 parse,標記 hasAward false', async () => {
  readKickoffReport.mockResolvedValue(KICKOFF);
  const { app, token, id } = await makeApp({ withAward: false });
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
  expect(res.body.hasAward).toBe(false);
  expect(readAwardNotice).not.toHaveBeenCalled();
});

// 3/24 份不是開工報告表。硬湊欄位會讓承辦人以為系統看懂了。
test('非開工報告表回 400 明確訊息', async () => {
  const err = new Error('此檔無法辨識為開工報告表(缺少必要欄位標籤),請確認上傳的是開工報告表');
  err.code = 'NOT_KICKOFF_REPORT';
  readKickoffReport.mockRejectedValue(err);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/無法辨識為開工報告表/);
});

// OCR 內部錯誤細節(路徑、驅動訊息)不得回給前端
test('OCR 失敗回 500 且不洩漏內部訊息', async () => {
  readKickoffReport.mockRejectedValue(new Error('OCR 驅動失敗: C:\\Windows\\...'));
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/parse`)
    .set('Authorization', `Bearer ${token}`)
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(500);
  expect(res.body.error).not.toMatch(/Windows/);
});

// 有硬錯不得標記已核對(spec §5.1),且要一次列全
test('confirm 有硬錯回 400 並列出全部不符欄位', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const bad = { ...KICKOFF, 工程名稱: 'X', 契約編號: 'Y' };
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(bad))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields.sort()).toEqual(['契約編號', '工程名稱']);
  // 硬錯全是跨文件比對欄位:文案須維持指向決標公告,不得夾帶「表格」/「推導」字樣
  // (那是契約工期專屬的自洽性檢查,與本案無關)
  expect(res.body.error).toMatch(/決標公告/);
  expect(res.body.error).not.toMatch(/表格|推導/);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 契約工期比的是開工報告表自身(表列工期 vs 開工/竣工日推導值),不是決標公告——
// 唯一硬錯是契約工期時,文案不得叫承辦人去對決標公告發文,那是不相干的動作。
test('confirm 唯一硬錯是契約工期時,訊息指向表格自身而非決標公告', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  // 其餘欄位與 AWARD 一致(仍會 match),只讓契約工期的表列天數與推導值(150)兜不起來
  const bad = { ...KICKOFF, 契約工期: { 天數: 999, 基準: '日曆天' } };
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(bad))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields).toEqual(['契約工期']);
  expect(res.body.error).toMatch(/表格|開工報告表/);
  expect(res.body.error).not.toMatch(/決標公告/);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM project_attachments WHERE kind = 'kickoff_report'`);
  expect(rows[0].n).toBe(0);
});

// 混合案例:跨文件欄位與契約工期同時硬錯,兩種問題的處理方式不同,
// 文案不得只講其中一邊而讓另一邊看起來像同一類問題。
test('confirm 硬錯同時含跨文件欄位與契約工期時,訊息同時涵蓋兩種情況', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const bad = { ...KICKOFF, 工程名稱: 'X', 契約工期: { 天數: 999, 基準: '日曆天' } };
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(bad))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.fields.sort()).toEqual(['契約工期', '工程名稱']);
  expect(res.body.error).toMatch(/決標公告/);
  expect(res.body.error).toMatch(/表格|開工報告表/);
});

// 無硬錯 → 歸檔。歸檔即代表已核對(不另設狀態欄)。
test('confirm 無硬錯時歸檔為 kickoff_report', async () => {
  readAwardNotice.mockResolvedValue(AWARD);
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), '開工報告表.pdf').expect(200);
  expect(res.body.ok).toBe(true);
  const { rows } = await db.query(
    `SELECT kind, original_name FROM project_attachments WHERE project_id = $1 AND kind = 'kickoff_report'`,
    [id]);
  expect(rows).toHaveLength(1);
  expect(rows[0].original_name).toBe('開工報告表.pdf');
});

// 提示級不得阻擋:古坑平移 10 天是正常的
test('只有提示級差異時仍可歸檔', async () => {
  readAwardNotice.mockResolvedValue({ ...AWARD, 履約起迄: { 起: '115/03/08', 迄: '115/08/04' } });
  const { app, token, id } = await makeApp();
  await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', JSON.stringify(KICKOFF))
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(200);
});

// values 是前端送來的 JSON 字串,壞掉不得變成 500
test('values 非合法 JSON 回 400', async () => {
  const { app, token, id } = await makeApp();
  const res = await request(app).post(`/api/projects/${id}/kickoff-report/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .field('values', '{壞掉')
    .attach('kickoff_report', Buffer.from('%PDF-1.4'), 'k.pdf').expect(400);
  expect(res.body.error).toMatch(/確認值/);
});
