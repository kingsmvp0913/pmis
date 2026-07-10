process.env.JWT_SECRET = 'test-secret';

const os = require('os');
const fs = require('fs');
const path = require('path');

// 讀取檔落地根用暫存目錄,避免污染真 data/;須在 require registry 前設定
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-parser-test-'));
process.env.PMIS_DATA_DIR = TMP_DATA;

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { newDb } = require('pg-mem');
const db = require('../server/db');
const { registerRoutes: registerAuthRoutes } = require('../server/auth');
const { registerRoutes: registerVendorRoutes } = require('../server/vendor-routes');
const { registerRoutes: registerParserRoutes } = require('../server/parser-routes');
const registry = require('../server/parsers/registry');

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
  registerParserRoutes(app);
  const setup = await request(app).post('/api/auth/setup')
    .send({ username: 'admin', password: 'password1', display_name: '管理員' });
  return { app, token: setup.body.token };
}

// dummy 讀取檔 fixture 內容:回傳一個合法 module 字串。
// vendorKey 由呼叫端帶入(對應該廠商 id);selfTestReturn 控制 selfTest 結果。
function dummyParserSource(vendorKey, { selfTestReturn = true } = {}) {
  return `
module.exports = {
  meta: {
    vendorKey: '${vendorKey}',
    version: '1.0.0',
    targetFields: ['project_name', 'daily_amount'],
  },
  parse(filePath) {
    return {
      header: { project_name: 'DUMMY-PROJECT', source: filePath },
      dailyRows: [{ date: '2026-07-01', daily_amount: 1000 }],
    };
  },
  selfTest() {
    return ${selfTestReturn};
  },
};
`;
}

describe('parser routes', () => {
  let app, token, vendorId;

  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeApp());
    const v = await request(app).post('/api/vendors')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '測試廠商' });
    vendorId = v.body.id;
  });

  afterEach(async () => {
    // 每測試移除該廠商讀取檔,避免暫存目錄殘留影響其他測試
    try { registry.remove(String(vendorId)); } catch { /* noop */ }
    db._setPoolForTesting(null);
  });

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('安裝合法 dummy parser → 200 + status 顯示 installed/version/targetFields', async () => {
    const src = dummyParserSource(vendorId);
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), `${vendorId}.pmisparser.js`);
    expect(res.status).toBe(201);
    expect(res.body.installed).toBe(true);
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.targetFields).toEqual(['project_name', 'daily_amount']);
    expect(typeof res.body.installedAt).toBe('string');

    // GET status 一致
    const st = await auth(request(app).get(`/api/vendors/${vendorId}/parser`));
    expect(st.status).toBe(200);
    expect(st.body.installed).toBe(true);
    expect(st.body.version).toBe('1.0.0');
  });

  test('registry.getParser(id).parse() 回 fixture 預期結構(分派可用)', async () => {
    const src = dummyParserSource(vendorId);
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), `${vendorId}.pmisparser.js`);

    const mod = registry.getParser(String(vendorId));
    expect(mod).not.toBeNull();
    const out = mod.parse('/some/daily-log.xlsx');
    expect(out.header.project_name).toBe('DUMMY-PROJECT');
    expect(out.header.source).toBe('/some/daily-log.xlsx');
    expect(out.dailyRows).toHaveLength(1);
    expect(out.dailyRows[0].daily_amount).toBe(1000);
  });

  test('vendorKey 不符該廠商 → 拒絕(400)', async () => {
    // 讀取檔內 meta.vendorKey 故意用別的值
    const src = dummyParserSource(String(vendorId) + '999');
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), `${vendorId}.pmisparser.js`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/廠商鍵/);
    // 未安裝
    const st = await auth(request(app).get(`/api/vendors/${vendorId}/parser`));
    expect(st.body.installed).toBe(false);
  });

  test('selfTest 回 false 的 parser → 拒絕(400)', async () => {
    const src = dummyParserSource(vendorId, { selfTestReturn: false });
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), `${vendorId}.pmisparser.js`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/selfTest/);
  });

  test('非 admin 呼叫安裝 → 403', async () => {
    // 直接建一個 role='user' 的使用者並簽 token
    const { hashPassword } = require('../server/password');
    const hash = await hashPassword('password1');
    const { rows } = await db.query(
      "INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, 'user') RETURNING id",
      ['normaluser', hash, '一般使用者']
    );
    const userToken = jwt.sign({ userId: rows[0].id }, 'test-secret', { expiresIn: '7d' });

    const src = dummyParserSource(vendorId);
    const res = await request(app).post(`/api/vendors/${vendorId}/parser`)
      .set('Authorization', `Bearer ${userToken}`)
      .attach('parser', Buffer.from(src), `${vendorId}.pmisparser.js`);
    expect(res.status).toBe(403);
  });

  test('非 admin 呼叫移除 → 403', async () => {
    const { hashPassword } = require('../server/password');
    const hash = await hashPassword('password1');
    const { rows } = await db.query(
      "INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, 'user') RETURNING id",
      ['normaluser2', hash, '一般使用者2']
    );
    const userToken = jwt.sign({ userId: rows[0].id }, 'test-secret', { expiresIn: '7d' });

    const res = await request(app).delete(`/api/vendors/${vendorId}/parser`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
  });

  test('remove 後 status=not installed 且檔案不存在', async () => {
    const src = dummyParserSource(vendorId);
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), `${vendorId}.pmisparser.js`);
    const filePath = path.join(registry.PARSER_DIR, `${vendorId}.pmisparser.js`);
    expect(fs.existsSync(filePath)).toBe(true);

    const del = await auth(request(app).delete(`/api/vendors/${vendorId}/parser`));
    expect(del.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);

    const st = await auth(request(app).get(`/api/vendors/${vendorId}/parser`));
    expect(st.body.installed).toBe(false);
  });

  test('安裝更新覆蓋:第二次安裝新版 → status 反映新版本', async () => {
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(dummyParserSource(vendorId)), `${vendorId}.pmisparser.js`);

    // 換一個版本號的內容重新安裝
    const v2 = dummyParserSource(vendorId).replace("version: '1.0.0'", "version: '2.5.0'");
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(v2), `${vendorId}.pmisparser.js`);
    expect(res.status).toBe(201);
    expect(res.body.version).toBe('2.5.0');

    const mod = registry.getParser(String(vendorId));
    expect(mod.meta.version).toBe('2.5.0');
  });

  test('缺廠商 → 404', async () => {
    const st = await auth(request(app).get('/api/vendors/99999/parser'));
    expect(st.status).toBe(404);
  });
});

// ── 純函式:validateModule ──
describe('registry.validateModule', () => {
  test('合法 module → ok', () => {
    const mod = {
      meta: { vendorKey: '7', version: '1.0.0', targetFields: ['a'] },
      parse() { return { header: {}, dailyRows: [] }; },
      selfTest() { return true; },
    };
    expect(registry.validateModule(mod, '7')).toEqual({ ok: true });
  });

  test('vendorKey 不符 → 拒絕', () => {
    const mod = {
      meta: { vendorKey: '7', version: '1.0.0', targetFields: [] },
      parse() {},
    };
    const r = registry.validateModule(mod, '8');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/廠商鍵/);
  });

  test('無 selfTest → 視為通過', () => {
    const mod = {
      meta: { vendorKey: '7', version: '1.0.0', targetFields: [] },
      parse() {},
    };
    expect(registry.validateModule(mod, '7').ok).toBe(true);
  });

  test('selfTest 回 false → 拒絕', () => {
    const mod = {
      meta: { vendorKey: '7', version: '1.0.0', targetFields: [] },
      parse() {},
      selfTest() { return false; },
    };
    expect(registry.validateModule(mod, '7').ok).toBe(false);
  });

  test('缺 parse → 拒絕', () => {
    const mod = { meta: { vendorKey: '7', version: '1.0.0', targetFields: [] } };
    expect(registry.validateModule(mod, '7').ok).toBe(false);
  });

  test('targetFields 非陣列 → 拒絕', () => {
    const mod = {
      meta: { vendorKey: '7', version: '1.0.0', targetFields: 'nope' },
      parse() {},
    };
    expect(registry.validateModule(mod, '7').ok).toBe(false);
  });
});
