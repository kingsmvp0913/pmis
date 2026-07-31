process.env.JWT_SECRET = 'test-secret';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-pbr-'));
process.env.PMIS_DATA_DIR = TMP;

const express = require('express');
const request = require('supertest');
const XLSX = require('xlsx');
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

// 會真的落檔的測試一律另開一個專案:與「硬擋時不得建立報表檔」共用 project_<id>
// 目錄會讓兩者依執行順序互相污染。
async function addProject(baseId) {
  const base = (await db.query('SELECT * FROM projects WHERE id = $1', [baseId])).rows[0];
  const { rows } = await db.query(
    `INSERT INTO projects (project_no, name, vendor_id, school_id, award_amount)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['ywjh11504b', '第二件工程', base.vendor_id, base.school_id, 3057698]
  );
  return rows[0].id;
}

// Excel COM 與檔案搬移不在單元測範圍:把 rename 與讀回也擋掉,才驗得到「讀回 B9 → 回寫主檔」
// 這段business logic。b9 由各測試指定,用來模擬正常值與公式錯誤格。
function mockWorkbookIO(b9) {
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {});
  const read = jest.spyOn(XLSX, 'readFile').mockReturnValue({ Sheets: { 工程基本資料: { B9: b9 } } });
  return () => { rename.mockRestore(); read.mockRestore(); };
}

// pg 依驅動可能把 DATE 回成 Date 或字串,測試只關心日曆上的那一天
const isoDay = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10));

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

describe('POST /api/projects/:id/basics — 值的格式', () => {
  // 格式不合法的值送進 UPDATE 會讓 PostgreSQL 丟 22P02,而此時 .xlsm 已經 rename 定案、
  // 沒有補償機制 → 「報表已改、主檔沒改」的半套狀態。故格式必須在落檔前擋下。
  test('格式不合法與未填併在同一份 fields,一次列全', async () => {
    const { app, token, projectId } = await makeApp();
    const res = await request(app).post(`/api/projects/${projectId}/basics`)
      .set('Authorization', `Bearer ${token}`)
      .send({ values: { ...FULL, 契約金額: '3,057,698', 開工日期: '2026/06/19', 契約工期: '一百二十' } });
    expect(res.status).toBe(400);
    expect(res.body.fields.sort()).toEqual(['契約工期', '契約金額', '開工日期'].sort());
  });
});

describe('POST /api/projects/:id/basics — 成功路徑', () => {
  test('回 200 與完工期限,7 欄回寫主檔,且 vendor_id/school_id 不被改綁', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const before = (await db.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
    // 46311 = 開工 2026-06-19(46192)+ 契約工期 120 - 1,即範本 B9 的 =B8+B7-1
    const restore = mockWorkbookIO({ t: 'n', v: 46311 });
    try {
      const res = await request(app).post(`/api/projects/${id}/basics`)
        .set('Authorization', `Bearer ${token}`)
        .send({ values: { ...FULL, 工程名稱: '改過的工程名稱' } });
      expect(res.status).toBe(200);
      expect(res.body.完工期限).toBe('2026-10-16');

      const after = (await db.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
      // 承包廠商/主辦機關即使被裁決成新值也只更新報表值,不動外鍵(spec §5.3)
      expect(after.vendor_id).toBe(before.vendor_id);
      expect(after.school_id).toBe(before.school_id);
      // 該寫的 7 欄
      expect(after.project_no).toBe(FULL.工程編號);
      expect(after.name).toBe('改過的工程名稱');
      expect(Number(after.award_amount)).toBe(FULL.契約金額);
      expect(isoDay(after.start_date)).toBe('2026-06-19');
      expect(isoDay(after.contract_completion_date)).toBe('2026-10-16');
      expect(after.supervisor_firm).toBe(FULL.監造單位);
      expect(after.designer_firm).toBe(FULL.設計單位);
    } finally { restore(); }
  });

  test('B9 是公式錯誤格時不得回 200、不得回寫主檔(錯誤碼會被當成 1900 年的日期)', async () => {
    // SheetJS 對 #VALUE! 回 { t:'e', v:15 };只看 v != null 的話 excelSerialToISO(15)
    // 會回 '1900-01-15' 並照寫進 contract_completion_date —— 假成功 + 髒資料。
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const before = (await db.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
    const restore = mockWorkbookIO({ t: 'e', v: 15 });
    try {
      const res = await request(app).post(`/api/projects/${id}/basics`)
        .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL } });
      expect(res.status).not.toBe(200);
      const after = (await db.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
      expect(after.contract_completion_date == null).toBe(true);
      expect(after.name).toBe(before.name);
    } finally { restore(); }
  });

  test('寫入失敗時不留暫存檔、原檔完好,且錯誤訊息不外洩伺服器內部細節', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const { fillTemplate } = require('../server/template-engine');
    // 模擬 COM 寫到一半失敗:tmp 已產生但 job 未完成
    fillTemplate.mockImplementationOnce(async (dest, tmp) => {
      fs.writeFileSync(tmp, '半寫的活頁簿');
      throw new Error(`Excel 驅動重試 3 次仍失敗:輸出 ${tmp}`);
    });
    const res = await request(app).post(`/api/projects/${id}/basics`)
      .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL } });
    expect(res.status).toBe(500);
    const dir = path.join(TMP, 'reports', `project_${id}`);
    expect(fs.readdirSync(dir)).toEqual(['監造報表.xlsm']);
    expect(res.body.error).not.toMatch(/Excel|xlsm|tmp-/);
  });
});
