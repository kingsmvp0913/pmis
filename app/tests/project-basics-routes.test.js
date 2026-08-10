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
    // award_amount 刻意不等於 FULL.契約金額:兩者相同的話,把 award_amount 從 UPDATE 的
    // SET 拿掉,成功路徑測試仍會綠(before/after 看不出差別),這欄就等於沒有測試守著。
    `INSERT INTO projects (project_no, name, vendor_id, school_id, award_amount)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['ywjh11504b', '第二件工程', base.vendor_id, base.school_id, 1]
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

describe('SP1 兩支端點的 verifyToken', () => {
  // 這兩支是 repo 裡唯一同時會寫檔案系統(監造報表 .xlsm)又會回寫工程主檔的端點,
  // verifyToken 是它們唯一的門。掛法目前正確(verifyToken 排在 multer 之前,未帶 token
  // 連檔案都不會被收下),但沒有測試釘住的話,任何人重排 middleware 都會靜默開洞。
  test('award-notice 未帶 token 回 401', async () => {
    const { app, projectId } = await makeApp();
    const res = await request(app).post(`/api/projects/${projectId}/award-notice`)
      .attach('award_notice', Buffer.from('%PDF-1.4 fake'), 'a.pdf');
    expect(res.status).toBe(401);
  });

  test('basics 未帶 token 回 401', async () => {
    const { app, projectId } = await makeApp();
    const res = await request(app).post(`/api/projects/${projectId}/basics`)
      .send({ values: { ...FULL } });
    expect(res.status).toBe(401);
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

  // Number(' ') 與 Number([]) 都是 0(有限數)會被放行,但 pg 的 prepareValue 送出的是
  // ' ' / '{}',PostgreSQL 對 numeric 欄位丟 22P02 —— 而那發生在 renameSync 之後,
  // 又是一次「報表已改、主檔沒改」。空白與空陣列必須跟千分位一樣在落檔前擋下。
  test.each([[' '], [[]], ['3,057,698'], ['']])(
    '契約金額 %j 一律擋進 fields,不得走到 UPDATE 才炸',
    async (bad) => {
      const { app, token, projectId } = await makeApp();
      const res = await request(app).post(`/api/projects/${projectId}/basics`)
        .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL, 契約金額: bad } });
      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual(['契約金額']);
    });

  // 型別穿透:驗證器若只看「值轉成數字/字串之後是什麼」,非純量會整個穿過去 ——
  // String(['3057698']) 是 '3057698'、Number(true) 是 1,兩者都「看起來合法」。
  // 後果分兩種,都在 renameSync 之後才發作,也就是「報表已改、主檔沒改」的半套狀態:
  //   ① 陣列:pg 的 prepareValue 送出 '{3057698}',numeric/date 欄位丟 22P02 → 500。
  //   ② true:契約工期寫進 B7,B9 算出「開工日 + 1 - 1」剛好過下界檢查 → 回 200,
  //      承辦人以為成功,主檔的完工期限卻是錯的(比 500 更難察覺)。
  // 故三個型別化欄位必須先驗「值本身是不是純量」,而不是驗它轉完長什麼樣。
  test.each([
    ['契約金額', ['3057698']],
    ['契約金額', true],
    ['契約金額', {}],
    ['契約工期', ['120']],
    ['契約工期', true],
    ['契約工期', {}],
    ['開工日期', ['2026-06-19']],
    ['開工日期', true],
    ['開工日期', {}],
  ])('%s 收到非純量 %j 必須擋進 fields(型別穿透會在 renameSync 之後才炸)',
    async (欄位, bad) => {
      const { app, token, projectId } = await makeApp();
      const res = await request(app).post(`/api/projects/${projectId}/basics`)
        .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL, [欄位]: bad } });
      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual([欄位]);
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

  test('每個請求的暫存檔名必須唯一 —— finally 的清除是跨請求可見的副作用', async () => {
    // 同專案的兩個請求若共用同一個 tmp 路徑:A 的 finally 在 await UPDATE 之後才跑,
    // 會刪掉 B 已寫完、還沒 rename 的 tmp,讓 B 的 renameSync ENOENT → 無辜的 500。
    // 真正的競態要靠 UPDATE 卡住才重現(單元測沒有那個掛鉤),故直接驗不變量本身:
    // 兩次請求拿到的 tmp 路徑不得相同。
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const { fillTemplate } = require('../server/template-engine');
    const seen = [];
    const capture = async (dest, tmp) => { seen.push(tmp); fs.writeFileSync(tmp, 'x'); };
    fillTemplate.mockImplementationOnce(capture).mockImplementationOnce(capture);
    const restore = mockWorkbookIO({ t: 'n', v: 46311 });
    try {
      const send = () => request(app).post(`/api/projects/${id}/basics`)
        .set('Authorization', `Bearer ${token}`).send({ values: { ...FULL } });
      await send();
      await send();
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toBe(seen[1]);
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

// 開工報告表上「日曆天」與「工作天」是並列的兩個選項,OCR 分不出勾了哪一個
// (24 份實測有 17 份文字裡兩個詞同時出現),故由承辦人自己選、系統存起來。
describe('POST /api/projects/:id/basics — 契約工期基準', () => {
  const 送出 = async (app, token, id, 基準) => {
    const restore = mockWorkbookIO({ t: 'n', v: 46311 });
    try {
      return await request(app).post(`/api/projects/${id}/basics`)
        .set('Authorization', `Bearer ${token}`)
        .send({ values: { ...FULL, ...(基準 === undefined ? {} : { 契約工期基準: 基準 }) } });
    } finally { restore(); }
  };

  test('選了工作天要存得住', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const res = await 送出(app, token, id, '工作天');
    expect(res.status).toBe(200);
    expect(res.body.契約工期基準).toBe('工作天');
    const after = (await db.query('SELECT duration_basis FROM projects WHERE id = $1', [id])).rows[0];
    expect(after.duration_basis).toBe('工作天');
  });

  // 判不出來時留空是正常狀態,不可因此把一份本來寫得進去的報表整份卡住
  test('沒帶基準仍可寫入,欄位留 null', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const res = await 送出(app, token, id, undefined);
    expect(res.status).toBe(200);
    expect(res.body.契約工期基準).toBe(null);
    const after = (await db.query('SELECT duration_basis FROM projects WHERE id = $1', [id])).rows[0];
    expect(after.duration_basis == null).toBe(true);
  });

  // 前端送什麼後端都不能照收:只有這兩個值有意義
  test('不是日曆天/工作天的值一律當成未指定', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    const res = await 送出(app, token, id, '曆天');
    expect(res.status).toBe(200);
    expect(res.body.契約工期基準).toBe(null);
  });
});

// 開工報告表上的竣工日是廠商/機關已經算好的,系統只驗算不重算。範本的
// B9 = B8+B7-1 是**日曆天**算法,對工作天的案子會算出偏早的日期。
describe('POST /api/projects/:id/basics — 工作天不可用 B9 覆蓋竣工日', () => {
  test('工作天:不覆蓋主檔既有的竣工日,並回報未寫入', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    // 先讓主檔有一個「開工報告表讀到的」竣工日
    await db.query('UPDATE projects SET contract_completion_date = $1 WHERE id = $2',
      ['2026-12-25', id]);
    const restore = mockWorkbookIO({ t: 'n', v: 46311 });   // B9 會算出 2026-10-16
    try {
      const res = await request(app).post(`/api/projects/${id}/basics`)
        .set('Authorization', `Bearer ${token}`)
        .send({ values: { ...FULL, 契約工期基準: '工作天' } });
      expect(res.status).toBe(200);
      expect(res.body.已寫入竣工日).toBe(false);
      const after = (await db.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
      expect(isoDay(after.contract_completion_date)).toBe('2026-12-25');   // 沒被 B9 蓋掉
    } finally { restore(); }
  });

  test('日曆天:照舊用 B9 覆蓋', async () => {
    const { app, token, projectId } = await makeApp();
    const id = await addProject(projectId);
    await db.query('UPDATE projects SET contract_completion_date = $1 WHERE id = $2',
      ['2026-12-25', id]);
    const restore = mockWorkbookIO({ t: 'n', v: 46311 });
    try {
      const res = await request(app).post(`/api/projects/${id}/basics`)
        .set('Authorization', `Bearer ${token}`)
        .send({ values: { ...FULL, 契約工期基準: '日曆天' } });
      expect(res.status).toBe(200);
      expect(res.body.已寫入竣工日).toBe(true);
      const after = (await db.query('SELECT * FROM projects WHERE id = $1', [id])).rows[0];
      expect(isoDay(after.contract_completion_date)).toBe('2026-10-16');
    } finally { restore(); }
  });
});
