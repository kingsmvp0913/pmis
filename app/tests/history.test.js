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
    const p = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '測試工程', start_date: '2026-07-01' });
    projectId = p.body.id;
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
