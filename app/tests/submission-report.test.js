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
  // 直接 INSERT 而不打建案 API:建案入口已收斂成「必須上傳決標公告」,本檔測的是
  // 繳交紀錄與報表產生,工程只是前置條件——為了它去湊一份決標公告與五個必填欄位,
  // 只會讓這些測試綁上一條與被測行為無關的規則。
  async function makeProjectWithVendor(vendorName) {
    const v = await auth(request(app).post('/api/vendors')).send({ name: vendorName });
    const { rows } = await db.query(
      `INSERT INTO projects (name, vendor_id, start_date)
       VALUES ('竹崎圍牆工程', $1, '2026-04-01') RETURNING id`, [v.body.id]);
    return rows[0].id;
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

  // 舊的「上傳施工日誌即自動產監造報表」已於 2026-08-05 退役:那條路線從零手刻
  // xlsx、完全不跑 SP3 的 42 條驗證,與新路線並存時承辦人看不出兩顆按鈕的差別,
  // 按錯就產出一份沒驗證過的報表。這裡改為釘住「只登錄繳交、不再產報表」。
  test('上傳施工日誌只登錄繳交紀錄,不再自動產報表', async () => {
    const projectId = await makeProjectWithVendor('金大營造有限公司');
    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-04')
      .attach('daily_log', FIXTURE);
    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(Number));
    expect(res.body.daily_log_path).toBeTruthy();
    // 回應不得再帶產報表的欄位——留著會讓前端以為還有那條路徑
    expect(res.body.report_generated).toBeUndefined();
    expect(res.body.report_path).toBeFalsy();
  });

  // 沒有讀取器也不該影響繳交登錄:報表已不在這條路徑上
  test('廠商沒有讀取器時仍能登錄繳交', async () => {
    const projectId = await makeProjectWithVendor('查無此廠商');
    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-04')
      .attach('daily_log', FIXTURE);
    expect(res.status).toBe(201);
    expect(res.body.report_generated).toBeUndefined();
  });

  test('download report:kind=official_doc 維持 409(公文待範本)', async () => {
    registry.install(fs.readFileSync(JINDA_SRC), VENDOR_KEY);
    const projectId = await makeProjectWithVendor(VENDOR_KEY);
    const res = await auth(request(app).post(`/api/projects/${projectId}/submissions`))
      .field('type', 'monthly').field('period', '2026-04').attach('daily_log', FIXTURE);
    const doc = await auth(request(app).get(`/api/submissions/${res.body.id}/download/official_doc`));
    expect(doc.status).toBe(409);
  }, 30000);
});
