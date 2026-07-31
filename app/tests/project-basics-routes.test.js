process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-pbr-'));
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');

// Excel COM 不在單元測範圍(真正寫入由 Task 12 的整合測涵蓋);
// 這裡只驗「硬擋」與「解析→比對」的路由行為。
jest.mock('../server/template-engine', () => ({
  fillTemplate: jest.fn().mockResolvedValue({ ok: true, outPath: 'x' }),
}));
jest.mock('../server/award-notice', () => ({
  readAwardNotice: jest.fn(),
}));

const { readAwardNotice } = require('../server/award-notice');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerBasicsRoutes } = require('../server/project-basics-routes');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

async function makeApp() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  db._setPoolForTesting(new pg.Pool());
  await db.migrate();
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerBasicsRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  const { rows } = await db.query(
    `INSERT INTO vendors (name) VALUES ('玉森土木包工業') RETURNING id`
  );
  const { rows: srows } = await db.query(
    `INSERT INTO schools (name) VALUES ('雲林縣立宜梧國民中學') RETURNING id`
  );
  const { rows: prows } = await db.query(
    `INSERT INTO projects (project_no, name, vendor_id, school_id, award_amount)
     VALUES ('ywjh11504', '115年度宜梧國中老舊廁所整修工程', $1, $2, 3057698) RETURNING id`,
    [rows[0].id, srows[0].id]
  );
  return { app, token: setup.body.token, projectId: prows[0].id };
}

const FULL = {
  工程名稱: '115年度宜梧國中老舊廁所整修工程',
  監造單位: '呂罡銘建築師事務所',
  主辦機關: '雲林縣立宜梧國民中學',
  設計單位: '呂罡銘建築師事務所',
  承包廠商: '玉森土木包工業',
  契約金額: 3057698,
  契約工期: 120,
  開工日期: '2026-06-19',
  工程編號: 'ywjh11504',
};

describe('POST /api/projects/:id/award-notice', () => {
  test('解析成功回 parsed / project / diffs,主檔一致時全 match', async () => {
    const { app, token, projectId } = await makeApp();
    readAwardNotice.mockResolvedValueOnce({
      工程名稱: FULL.工程名稱, 主辦機關: FULL.主辦機關, 承包廠商: FULL.承包廠商,
      契約金額: 3057698, 工程編號: 'ywjh11504',
    });
    const res = await request(app).post(`/api/projects/${projectId}/award-notice`)
      .set('Authorization', `Bearer ${token}`)
      .attach('award_notice', Buffer.from('%PDF-1.4 fake'), 'a.pdf');
    expect(res.status).toBe(200);
    expect(res.body.diffs.every((d) => d.狀態 === 'match')).toBe(true);
    expect(res.body.project.承包廠商).toBe('玉森土木包工業');
  });

  test('掃描件回 400 並帶明確訊息,不回一堆 null 讓人誤以為解析過了', async () => {
    const { app, token, projectId } = await makeApp();
    const err = new Error('此決標公告為掃描件(PDF 內無可抽取文字),無法自動解析');
    err.code = 'SCANNED_PDF';
    readAwardNotice.mockRejectedValueOnce(err);
    const res = await request(app).post(`/api/projects/${projectId}/award-notice`)
      .set('Authorization', `Bearer ${token}`)
      .attach('award_notice', Buffer.from('scan'), 'a.pdf');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/掃描件/);
  });

  test('沒帶檔案回 400', async () => {
    const { app, token, projectId } = await makeApp();
    const res = await request(app).post(`/api/projects/${projectId}/award-notice`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  test('工程不存在回 404', async () => {
    const { app, token } = await makeApp();
    readAwardNotice.mockResolvedValueOnce({});
    const res = await request(app).post('/api/projects/99999/award-notice')
      .set('Authorization', `Bearer ${token}`)
      .attach('award_notice', Buffer.from('x'), 'a.pdf');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/projects/:id/basics — 硬擋', () => {
  test('有欄位未裁決/未填時 400,並列出全部缺項而非只報第一個', async () => {
    // 只報第一個會讓承辦人來回送好幾次;spec §9 要求一次列全
    const { app, token, projectId } = await makeApp();
    const values = { ...FULL };
    delete values.開工日期;
    delete values.契約工期;
    const res = await request(app).post(`/api/projects/${projectId}/basics`)
      .set('Authorization', `Bearer ${token}`).send({ values });
    expect(res.status).toBe(400);
    expect(res.body.fields.sort()).toEqual(['契約工期', '開工日期']);
  });

  test('空字串視同未填', async () => {
    const { app, token, projectId } = await makeApp();
    const res = await request(app).post(`/api/projects/${projectId}/basics`)
      .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL, 工程編號: '' } });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['工程編號']);
  });

  test('硬擋時不得建立報表檔(未通過審核就落檔會留下半套資料)', async () => {
    const { app, token, projectId } = await makeApp();
    await request(app).post(`/api/projects/${projectId}/basics`)
      .set('Authorization', `Bearer ${token}`).send({ values: {} });
    expect(fs.existsSync(path.join(TMP, 'reports', `project_${projectId}`))).toBe(false);
  });
});

describe('POST /api/projects/:id/basics — 專案不存在', () => {
  // 不先查專案就 ensureWorkbook,會替一個不存在的工程建出常駐報表檔,
  // 而後續 UPDATE 影響 0 列——承辦人收到 200 以為成功,實際只留下孤兒檔案。
  test('工程不存在回 404,且不得建立報表目錄', async () => {
    const { app, token } = await makeApp();
    const res = await request(app).post('/api/projects/99999/basics')
      .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL } });
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(TMP, 'reports', 'project_99999'))).toBe(false);
  });

  // projects.id 是 SERIAL,非整數 id 永遠比不到任何一列,是用戶端打錯路徑而非伺服器故障;
  // 直接把它送進 ensureWorkbook/SQL 會炸成 500,讓真正的伺服器錯誤淹沒在雜訊裡。
  test('非整數 id 回 404 而非 500', async () => {
    const { app, token } = await makeApp();
    const res = await request(app).post('/api/projects/abc/basics')
      .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL } });
    expect(res.status).toBe(404);
  });
});
