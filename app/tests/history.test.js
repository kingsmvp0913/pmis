process.env.JWT_SECRET = 'test-secret';

const os = require('os');
const fs = require('fs');
const path = require('path');

// 測試資料根用暫存目錄,避免污染真 data/;須在 require history-routes 前設定
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-hist-'));
process.env.PMIS_DATA_DIR = TMP_DATA;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerProjectRoutes } = require('../server/project-routes');
const { registerRoutes: registerSettingsRoutes } = require('../server/settings');
const {
  registerRoutes: registerHistoryRoutes,
  computeDeadline,
  buildSubmissionStatus,
  safeResolve,
  DATA_DIR,
  OUTPUT_DIR,
} = require('../server/history-routes');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeApp() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerProjectRoutes(app);
  registerSettingsRoutes(app);
  registerHistoryRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

// ── 純函式:deadline 計算 ──
describe('computeDeadline', () => {
  test('結算日 5、週期 2026-07 → 2026-07-05', () => {
    expect(computeDeadline('2026-07', 5)).toBe('2026-07-05');
  });
  test('結算日 10 → 補零到兩位', () => {
    expect(computeDeadline('2026-01', 10)).toBe('2026-01-10');
  });
  test('非法週期回 null', () => {
    expect(computeDeadline('2026/07', 5)).toBe(null);
  });
});

// ── 純函式:繳交狀態(Rule 9:逾期未繳必為紅、督導不影響每月綠紅) ──
describe('buildSubmissionStatus', () => {
  const now = new Date('2026-07-20T12:00:00'); // 已過 07 期 deadline(07-05)

  test('有 monthly 紀錄 = 已繳(綠 submitted)', () => {
    const list = buildSubmissionStatus({
      startYm: '2026-07', nowYm: '2026-07', settlementDay: 5, now, submittedMonthly: ['2026-07'],
    });
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('submitted');
  });

  test('已過 deadline 仍無紀錄 = 逾期未繳(紅 overdue)', () => {
    const list = buildSubmissionStatus({
      startYm: '2026-07', nowYm: '2026-07', settlementDay: 5, now, submittedMonthly: [],
    });
    expect(list[0].status).toBe('overdue');
  });

  test('尚未到期 = 中性(pending)', () => {
    // 當前 07-02,deadline 07-05 尚未到
    const early = new Date('2026-07-02T12:00:00');
    const list = buildSubmissionStatus({
      startYm: '2026-07', nowYm: '2026-07', settlementDay: 5, now: early, submittedMonthly: [],
    });
    expect(list[0].status).toBe('pending');
  });

  // 逾期臨界(台灣 GMT+8):結算日 00:00 一到即紅,前一刻仍中性
  test('結算日凌晨 00:00(台灣時區)整點即逾期(紅)', () => {
    const atMidnight = new Date('2026-07-05T00:00:00+08:00');
    const list = buildSubmissionStatus({
      startYm: '2026-07', nowYm: '2026-07', settlementDay: 5, now: atMidnight, submittedMonthly: [],
    });
    expect(list[0].status).toBe('overdue');
  });

  test('結算日前一刻(台灣 07-04 23:59:59)仍中性(pending)', () => {
    const justBefore = new Date('2026-07-04T23:59:59+08:00');
    const list = buildSubmissionStatus({
      startYm: '2026-07', nowYm: '2026-07', settlementDay: 5, now: justBefore, submittedMonthly: [],
    });
    expect(list[0].status).toBe('pending');
  });

  test('多月:早月逾期紅、當月未到期中性、已繳月綠', () => {
    const list = buildSubmissionStatus({
      startYm: '2026-05', nowYm: '2026-07', settlementDay: 5,
      now: new Date('2026-07-02T12:00:00'), // 07-05 未到
      submittedMonthly: ['2026-06'],
    });
    const byPeriod = Object.fromEntries(list.map(x => [x.period, x.status]));
    expect(byPeriod['2026-05']).toBe('overdue');   // 05-05 早已過
    expect(byPeriod['2026-06']).toBe('submitted');  // 有 monthly
    expect(byPeriod['2026-07']).toBe('pending');    // 07-05 未到
  });

  test('督導不列入 monthly 綠判定(僅 monthly period 才綠)', () => {
    // 該月只有督導、無 monthly,且已逾期 → 仍為紅
    const list = buildSubmissionStatus({
      startYm: '2026-07', nowYm: '2026-07', settlementDay: 5, now,
      submittedMonthly: [], // 督導不進 submittedMonthly
    });
    expect(list[0].status).toBe('overdue');
  });
});

// ── 路由 ──
describe('history routes', () => {
  let app, token, projectId;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeApp());
    // 直接 INSERT 而不打建案 API:建案入口已收斂成「必須上傳決標公告」,而本檔
    // 測的是繳交紀錄,工程只是前置條件(理由同 submission-report.test.js)。
    const { rows } = await db.query(
      `INSERT INTO projects (name, start_date) VALUES ('測試工程', '2026-07-01') RETURNING id`);
    projectId = rows[0].id;
  });
  afterEach(() => db._setPoolForTesting(null));

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('上傳建立 monthly 紀錄,deadline 依結算日計算', async () => {
    // 結算日設 10 → 週期 2026-07 deadline = 2026-07-10
    await auth(request(app).put('/api/settings/settlement-day')).send({ settlement_day: 10 });
    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly')
      .field('period', '2026-07')
      .attach('daily_log', Buffer.from('log content'), 'log.txt');
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('monthly');
    expect(String(res.body.deadline).slice(0, 10)).toBe('2026-07-10');
    expect(res.body.daily_log_path).toMatch(/^uploads\/proj_/);
    // 實體檔存在
    expect(fs.existsSync(path.join(DATA_DIR, res.body.daily_log_path))).toBe(true);
  });

  test('督導 = 額外多插一筆(不覆蓋每月)', async () => {
    await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-07')
      .attach('daily_log', Buffer.from('m'), 'm.txt');
    await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'supervision').field('period', '2026-07')
      .attach('daily_log', Buffer.from('s'), 's.txt');
    const hist = await auth(request(app).get(`/api/projects/${projectId}/history`));
    expect(hist.body.records).toHaveLength(2);
    const types = hist.body.records.map(r => r.type).sort();
    expect(types).toEqual(['monthly', 'supervision']);
  });

  test('history:已繳月為綠(submitted)', async () => {
    await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-07')
      .attach('daily_log', Buffer.from('m'), 'm.txt');
    const hist = await auth(request(app).get(`/api/projects/${projectId}/history`));
    const jul = hist.body.status.find(s => s.period === '2026-07');
    expect(jul.status).toBe('submitted');
  });

  test('report / official_doc 下載回 409(尚未產出)', async () => {
    const up = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-07')
      .attach('daily_log', Buffer.from('m'), 'm.txt');
    const sid = up.body.id;
    const rep = await auth(request(app).get(`/api/submissions/${sid}/download/report`));
    expect(rep.status).toBe(409);
    const doc = await auth(request(app).get(`/api/submissions/${sid}/download/official_doc`));
    expect(doc.status).toBe(409);
  });

  test('daily_log 下載成功回檔內容', async () => {
    const up = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-07')
      .attach('daily_log', Buffer.from('hello-log'), 'm.txt');
    const dl = await auth(request(app).get(`/api/submissions/${up.body.id}/download/daily_log`));
    expect(dl.status).toBe(200);
    expect(dl.text).toBe('hello-log');
  });

  test('刪除紀錄後實體檔確實不存在', async () => {
    const up = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-07')
      .attach('daily_log', Buffer.from('m'), 'm.txt');
    const abs = path.join(DATA_DIR, up.body.daily_log_path);
    expect(fs.existsSync(abs)).toBe(true);
    const del = await auth(request(app).delete(`/api/submissions/${up.body.id}`));
    expect(del.status).toBe(200);
    expect(fs.existsSync(abs)).toBe(false);
    const hist = await auth(request(app).get(`/api/projects/${projectId}/history`));
    expect(hist.body.records).toHaveLength(0);
  });

  test('缺工程回 404', async () => {
    const res = await auth(request(app).get('/api/projects/99999/history'));
    expect(res.status).toBe(404);
  });
});

describe('safeResolve(防 Path Traversal)', () => {
  test('正常相對路徑 → 解析為 DATA_DIR 內的絕對路徑', () => {
    const abs = safeResolve('uploads/proj_1/x.pdf');
    expect(abs).toBe(path.join(DATA_DIR, 'uploads', 'proj_1', 'x.pdf'));
  });

  test('../ 逃逸 → null', () => {
    expect(safeResolve('../secret.txt')).toBeNull();
    expect(safeResolve('uploads/../../../secret.txt')).toBeNull();
  });

  test('絕對路徑逃逸 → null', () => {
    // 以 DATA_DIR 所在磁碟根組出絕對路徑(避免反斜線字面跳脫問題);位於根目錄故在 DATA_DIR 之外
    const outside = path.join(path.parse(DATA_DIR).root, 'pmis-evil.txt');
    expect(path.isAbsolute(outside)).toBe(true);
    expect(safeResolve(outside)).toBeNull();
  });

  test('空值 → null', () => {
    expect(safeResolve('')).toBeNull();
    expect(safeResolve(null)).toBeNull();
    expect(safeResolve(undefined)).toBeNull();
  });
});

describe('POST /api/submissions/:id/official-doc', () => {
  // 與「history routes」describe 同樣的模式:每一測試都要獨立的 pg-mem pool,
  // 否則 db.query 會落回真的 pg.Pool(brief 原始程式碼漏了這段,補上避免撞真資料庫)。
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  // 建一組「可以產公文」的完整資料:事務所 + 學校 + 廠商 + 工程 + 繳交紀錄 + 該期日誌
  async function seed(token, app, opts = {}) {
    await db.query(
      `INSERT INTO firms (name, address, phone, fax, contact, email)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['呂罡銘建築師事務所', '403台中市西區中華路一段7號3樓', '04-22238088',
       '04-22230988', '呂罡銘', 'arch.kmlu@gmail.com']
    );
    const { rows: sch } = await db.query(
      'INSERT INTO schools (name) VALUES ($1) RETURNING id', ['臺中市西區大勇國民小學']);
    const { rows: ven } = await db.query(
      'INSERT INTO vendors (name) VALUES ($1) RETURNING id', ['摯東營造有限公司']);
    const supervisorFirm = 'supervisorFirm' in opts ? opts.supervisorFirm : '呂罡銘建築師事務所';
    const { rows: proj } = await db.query(
      `INSERT INTO projects (name, school_id, vendor_id, start_date, supervisor_firm)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      ['114學年度南棟教室西側廁所整修工程', sch[0].id, ven[0].id, '2026-01-26', supervisorFirm]);
    const { rows: sub } = await db.query(
      `INSERT INTO submission_history (project_id, period, type) VALUES ($1,$2,'monthly') RETURNING id`,
      [proj[0].id, '2026-06']);
    if (!opts.noDailyRecords) {
      await db.query(
        `INSERT INTO daily_records (project_id, log_date, item_no, qty) VALUES ($1,$2,$3,$4)`,
        [proj[0].id, '2026-06-15', '1', 1]);
    }
    return { projectId: proj[0].id, submissionId: sub[0].id };
  }

  const BODY = {
    our_doc_no: '銘第4131-5070112號',
    our_doc_date: '2026-07-01',
    vendor_doc_no: '摯勇字第1150701001號',
    vendor_doc_date: '2026-07-01',
    copies: '乙',
  };

  test('產出後檔案存在,且下載端點由 409 變 200', async () => {
    const { app, token } = await makeApp();
    const { submissionId } = await seed(token, app);
    const res = await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token).send(BODY);
    expect(res.status).toBe(200);

    const dl = await request(app).get(`/api/submissions/${submissionId}/download/official_doc`)
      .set('Authorization', 'Bearer ' + token);
    expect(dl.status).toBe(200);
  });

  // 樣本三份裡三份的我方日期都等於廠商日期,寫成嚴格大於整套當場不能用
  test('我方日期 = 廠商日期 → 放行', async () => {
    const { app, token } = await makeApp();
    const { submissionId } = await seed(token, app);
    const res = await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...BODY, our_doc_date: '2026-06-30', vendor_doc_date: '2026-06-30' });
    expect(res.status).toBe(200);
  });

  // 只驗回應碼會漏掉「擋了但檔案已經產出去」;只驗 DB 欄位是代理指標,不是磁碟狀態
  // (若日後有人把「寫檔」與「UPDATE DB」順序顛倒,只驗 DB 的測試照樣綠)。
  test('我方日期早於廠商日期 → 400 且不留下檔案', async () => {
    const { app, token } = await makeApp();
    const { projectId, submissionId } = await seed(token, app);
    // 每個測試各自起一個全新的 pg-mem pool,id 會從頭編號,故不同測試之間 projectId/
    // submissionId 常常重複;但 OUTPUT_DIR 是整個測試檔共用同一個暫存目錄不會被清空,
    // 先確保目標路徑乾淨,才不會誤把別支測試留下的舊檔當成「這次請求寫出來的」。
    const abs = path.join(OUTPUT_DIR, `proj_${projectId}`, `2026-06_公文_${submissionId}.docx`);
    fs.rmSync(abs, { force: true });

    const res = await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...BODY, our_doc_date: '2026-06-29', vendor_doc_date: '2026-06-30' });
    expect(res.status).toBe(400);

    const { rows } = await db.query(
      'SELECT official_doc_path FROM submission_history WHERE id = $1', [submissionId]);
    expect(rows[0].official_doc_path).toBeFalsy();

    expect(fs.existsSync(abs)).toBe(false);
  });

  // 公文正文寫「檢送施工日誌」,沒有日誌卻發文 = 發出一份不實的函
  test('該期沒有任何施工日誌 → 400', async () => {
    const { app, token } = await makeApp();
    const { submissionId } = await seed(token, app, { noDailyRecords: true });
    const res = await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token).send(BODY);
    expect(res.status).toBe(400);
  });

  // 文號填錯要能重來,一期一份公文,舊的沒有保留價值
  test('重產覆蓋同一列,欄位值一併更新', async () => {
    const { app, token } = await makeApp();
    const { submissionId } = await seed(token, app);
    await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token).send(BODY);
    await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token)
      .send({ ...BODY, our_doc_no: '銘第9999-5070112號' });

    const { rows } = await db.query(
      'SELECT our_doc_no FROM submission_history WHERE id = $1', [submissionId]);
    expect(rows[0].our_doc_no).toBe('銘第9999-5070112號');
  });

  // 建案時 projects.supervisor_firm 不會自動寫入(project-routes.js 的 COLUMNS 沒有這欄),
  // 只靠承辦人另外進基本資料頁存檔才有值。沒有 settings 預設 fallback 時應擋下,
  // 而不是靜默產出一份信頭全空的公文。
  test('工程與系統皆無監造單位 → 400,不產出空白信頭的公文', async () => {
    const { app, token } = await makeApp();
    const { submissionId } = await seed(token, app, { supervisorFirm: null });
    const res = await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token).send(BODY);
    expect(res.status).toBe(400);

    const { rows } = await db.query(
      'SELECT official_doc_path FROM submission_history WHERE id = $1', [submissionId]);
    expect(rows[0].official_doc_path).toBeFalsy();
  });

  // 工程層沒填但 settings 有系統預設 → 吊預設值放行(既有慣例:專案層有值用專案層,空則吊 settings 預設)。
  test('工程無監造單位但 settings 有預設 → 吊預設值放行', async () => {
    const { app, token } = await makeApp();
    const { submissionId } = await seed(token, app, { supervisorFirm: null });
    await request(app).put('/api/settings/firms')
      .set('Authorization', 'Bearer ' + token)
      .send({ supervisor_firm: '呂罡銘建築師事務所' });
    const res = await request(app).post(`/api/submissions/${submissionId}/official-doc`)
      .set('Authorization', 'Bearer ' + token).send(BODY);
    expect(res.status).toBe(200);
  });
});
