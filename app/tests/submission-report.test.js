process.env.JWT_SECRET = 'test-secret';

const os = require('os');
const fs = require('fs');
const path = require('path');

// 測試資料根用暫存目錄:history-routes 的 DATA_DIR 與 registry 的 PARSER_DIR
// 皆讀 PMIS_DATA_DIR,須在 require 前設定,避免污染真 data/。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-subrep-'));
process.env.PMIS_DATA_DIR = TMP_DATA;

const express = require('express');
const request = require('supertest');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const registry = require('../server/parsers/registry');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerProjectRoutes } = require('../server/project-routes');
const { registerRoutes: registerVendorRoutes } = require('../server/vendor-routes');
const { registerRoutes: registerSettingsRoutes } = require('../server/settings');
const {
  registerRoutes: registerHistoryRoutes,
  DATA_DIR,
} = require('../server/history-routes');

const VENDOR_KEY = '金大營造有限公司';
const JINDA_SRC = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'jinda.pmisparser.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'jinda.pdf');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function makeApp() {
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  registerVendorRoutes(app);
  registerProjectRoutes(app);
  registerSettingsRoutes(app);
  registerHistoryRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

describe('POST /submissions 串接監造報表產生', () => {
  let app, token;

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  // 建 vendor + project(綁 vendor),回 projectId。
  async function makeProjectWithVendor(vendorName) {
    const v = await auth(request(app).post('/api/vendors')).send({ name: vendorName });
    const p = await auth(request(app).post('/api/projects'))
      .send({ name: '竹崎圍牆工程', vendor_id: v.body.id, start_date: '2026-04-01' });
    return p.body.id;
  }

  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeApp());
    // 每測試前清掉讀取器,避免互相污染。
    registry.remove(VENDOR_KEY);
  });
  afterEach(() => {
    db._setPoolForTesting(null);
    registry.remove(VENDOR_KEY);
  });

  test('有讀取器 → 產生報表:report_generated=true、實體檔存在、download 200', async () => {
    // 裝 jinda 讀取器(meta.vendorKey = 金大營造有限公司)。
    const inst = registry.install(fs.readFileSync(JINDA_SRC), VENDOR_KEY);
    expect(inst.ok).toBe(true);

    const projectId = await makeProjectWithVendor(VENDOR_KEY);

    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly')
      .field('period', '2026-04')
      .attach('daily_log', FIXTURE);

    expect(res.status).toBe(201);
    expect(res.body.report_generated).toBe(true);
    expect(res.body.report_path).toBeTruthy();
    // 實體檔存在。
    const abs = path.join(DATA_DIR, res.body.report_path);
    expect(fs.existsSync(abs)).toBe(true);
    // DB 已回填 report_path。
    expect(res.body.report_path).toMatch(/^output\/proj_/);

    // download report 回 200,且回的是 xlsx 檔(有內容)。
    const dl = await auth(request(app).get(`/api/submissions/${res.body.id}/download/report`))
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.body.length).toBeGreaterThan(0);
  }, 30000);

  test('無讀取器 → 明確回報:report_generated=false + reason,紀錄仍建、download report 409', async () => {
    const projectId = await makeProjectWithVendor('沒有讀取器的廠商');

    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly')
      .field('period', '2026-04')
      .attach('daily_log', FIXTURE);

    expect(res.status).toBe(201);          // 紀錄仍建立
    expect(res.body.id).toBeTruthy();
    expect(res.body.report_generated).toBe(false);
    expect(res.body.reason).toContain('尚未安裝讀取器');
    expect(res.body.report_path == null).toBe(true);

    // 紀錄確實在。
    const hist = await auth(request(app).get(`/api/projects/${projectId}/history`));
    expect(hist.body.records).toHaveLength(1);

    // download report 回 409(尚未產生)。
    const dl = await auth(request(app).get(`/api/submissions/${res.body.id}/download/report`));
    expect(dl.status).toBe(409);
  }, 30000);

  test('解析失敗 → 紀錄仍保留、report_generated=false、不 500', async () => {
    // 裝讀取器,但上傳非 PDF 內容 → 讀取器解析丟錯或無天數。
    registry.install(fs.readFileSync(JINDA_SRC), VENDOR_KEY);
    const projectId = await makeProjectWithVendor(VENDOR_KEY);

    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly')
      .field('period', '2026-04')
      .attach('daily_log', Buffer.from('this is not a pdf'), 'bad.txt');

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.report_generated).toBe(false);
    expect(typeof res.body.reason).toBe('string');
    expect(res.body.report_path == null).toBe(true);
    // 紀錄仍在。
    const hist = await auth(request(app).get(`/api/projects/${projectId}/history`));
    expect(hist.body.records).toHaveLength(1);
  }, 30000);

  test('download report:kind=official_doc 維持 409(公文待範本)', async () => {
    registry.install(fs.readFileSync(JINDA_SRC), VENDOR_KEY);
    const projectId = await makeProjectWithVendor(VENDOR_KEY);
    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-04').attach('daily_log', FIXTURE);
    const doc = await auth(request(app).get(`/api/submissions/${res.body.id}/download/official_doc`));
    expect(doc.status).toBe(409);
  }, 30000);
});
