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
// vendorKey 由呼叫端帶入(現為廠商「名稱」字串);selfTestReturn 控制 selfTest 結果。
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
  let app, token, vendorId, vendorName;

  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeApp());
    vendorName = '測試廠商';
    const v = await request(app).post('/api/vendors')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: vendorName });
    vendorId = v.body.id;
  });

  afterEach(async () => {
    // 每測試移除該廠商讀取檔(以名稱為 key),避免暫存目錄殘留影響其他測試
    try { registry.remove(vendorName); } catch { /* noop */ }
    db._setPoolForTesting(null);
  });

  function auth(req) { return req.set('Authorization', `Bearer ${token}`); }

  test('安裝合法 dummy parser → 200 + status 顯示 installed/version/targetFields', async () => {
    const src = dummyParserSource(vendorName);
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), 'p.pmisparser.js');
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

  test('registry.getParser(name).parse() 回 fixture 預期結構(分派可用)', async () => {
    const src = dummyParserSource(vendorName);
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), 'p.pmisparser.js');

    const mod = registry.getParser(vendorName);
    expect(mod).not.toBeNull();
    const out = mod.parse('/some/daily-log.xlsx');
    expect(out.header.project_name).toBe('DUMMY-PROJECT');
    expect(out.header.source).toBe('/some/daily-log.xlsx');
    expect(out.dailyRows).toHaveLength(1);
    expect(out.dailyRows[0].daily_amount).toBe(1000);
  });

  test('vendorKey 不符該廠商 → 拒絕(400)', async () => {
    // 讀取檔內 meta.vendorKey 故意用別家名稱
    const src = dummyParserSource('別家廠商');
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), 'p.pmisparser.js');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/廠商鍵/);
    // 未安裝
    const st = await auth(request(app).get(`/api/vendors/${vendorId}/parser`));
    expect(st.body.installed).toBe(false);
  });

  test('selfTest 回 false 的 parser → 拒絕(400)', async () => {
    const src = dummyParserSource(vendorName, { selfTestReturn: false });
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), 'p.pmisparser.js');
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

    const src = dummyParserSource(vendorName);
    const res = await request(app).post(`/api/vendors/${vendorId}/parser`)
      .set('Authorization', `Bearer ${userToken}`)
      .attach('parser', Buffer.from(src), 'p.pmisparser.js');
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
    const src = dummyParserSource(vendorName);
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(src), 'p.pmisparser.js');
    // 落地檔名 = 廠商名稱安全化(此名無危險字元 → 原名)
    const filePath = path.join(registry.PARSER_DIR, `${vendorName}.pmisparser.js`);
    expect(fs.existsSync(filePath)).toBe(true);

    const del = await auth(request(app).delete(`/api/vendors/${vendorId}/parser`));
    expect(del.status).toBe(200);
    expect(fs.existsSync(filePath)).toBe(false);

    const st = await auth(request(app).get(`/api/vendors/${vendorId}/parser`));
    expect(st.body.installed).toBe(false);
  });

  test('安裝更新覆蓋:第二次安裝新版 → status 反映新版本', async () => {
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(dummyParserSource(vendorName)), 'p.pmisparser.js');

    // 換一個版本號的內容重新安裝
    const v2 = dummyParserSource(vendorName).replace("version: '1.0.0'", "version: '2.5.0'");
    const res = await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(v2), 'p.pmisparser.js');
    expect(res.status).toBe(201);
    expect(res.body.version).toBe('2.5.0');

    const mod = registry.getParser(vendorName);
    expect(mod.meta.version).toBe('2.5.0');
  });

  test('缺廠商 → 404', async () => {
    const st = await auth(request(app).get('/api/vendors/99999/parser'));
    expect(st.status).toBe(404);
  });

  // ── GET /api/parsers 總覽 ──
  test('GET /api/parsers:列出各廠商狀態 + 孤兒讀取器', async () => {
    // 建第二家(有讀取器)與第三家(無讀取器)
    const v2 = await auth(request(app).post('/api/vendors')).send({ name: '甲營造' });
    await auth(request(app).post('/api/vendors')).send({ name: '乙營造' });

    // 給「測試廠商」與「甲營造」各裝一支讀取器
    await auth(request(app).post(`/api/vendors/${vendorId}/parser`))
      .attach('parser', Buffer.from(dummyParserSource(vendorName)), 'p.pmisparser.js');
    await auth(request(app).post(`/api/vendors/${v2.body.id}/parser`))
      .attach('parser', Buffer.from(dummyParserSource('甲營造')), 'p.pmisparser.js');

    // 直接安裝一支「對不到任何廠商」的孤兒讀取器
    registry.install(Buffer.from(dummyParserSource('不存在的廠商')), '不存在的廠商');

    try {
      const res = await auth(request(app).get('/api/parsers'));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.vendors)).toBe(true);
      expect(Array.isArray(res.body.orphans)).toBe(true);

      const byName = Object.fromEntries(res.body.vendors.map(v => [v.vendorName, v]));
      expect(byName['測試廠商'].installed).toBe(true);
      expect(byName['測試廠商'].version).toBe('1.0.0');
      expect(byName['甲營造'].installed).toBe(true);
      expect(byName['乙營造'].installed).toBe(false);
      expect(byName['乙營造'].version).toBeNull();

      const orphanKeys = res.body.orphans.map(o => o.vendorKey);
      expect(orphanKeys).toContain('不存在的廠商');
      // 已對到廠商者不應出現在孤兒清單
      expect(orphanKeys).not.toContain('測試廠商');
    } finally {
      registry.remove('甲營造');
      registry.remove('不存在的廠商');
    }
  });

  // ── POST /api/parsers/bulk 批次 ──
  test('bulk:多檔含 matched + unmatched,部分成功個別回報', async () => {
    // 已存在廠商:測試廠商(beforeEach)、甲營造
    await auth(request(app).post('/api/vendors')).send({ name: '甲營造' });

    try {
      const res = await auth(request(app).post('/api/parsers/bulk'))
        .attach('files', Buffer.from(dummyParserSource(vendorName)), 'a.pmisparser.js')
        .attach('files', Buffer.from(dummyParserSource('甲營造')), 'b.pmisparser.js')
        .attach('files', Buffer.from(dummyParserSource('查無此家')), 'c.pmisparser.js')
        .attach('files', Buffer.from(dummyParserSource('壞檔', { selfTestReturn: false })), 'd.pmisparser.js');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(4);
      const byFile = Object.fromEntries(res.body.map(r => [r.filename, r]));

      // matched + 安裝成功
      expect(byFile['a.pmisparser.js'].ok).toBe(true);
      expect(byFile['a.pmisparser.js'].vendorKey).toBe('測試廠商');
      expect(byFile['a.pmisparser.js'].matchedVendorId).toBe(vendorId);
      expect(byFile['b.pmisparser.js'].ok).toBe(true);
      expect(byFile['b.pmisparser.js'].matchedVendorId).toBeTruthy();

      // unmatched:查無同名廠商 → 不安裝
      expect(byFile['c.pmisparser.js'].ok).toBe(false);
      expect(byFile['c.pmisparser.js'].vendorKey).toBe('查無此家');
      expect(byFile['c.pmisparser.js'].matchedVendorId).toBeNull();
      expect(byFile['c.pmisparser.js'].error).toMatch(/unmatched/);

      // 壞檔(selfTest false)→ 個別回報失敗,不影響其他
      expect(byFile['d.pmisparser.js'].ok).toBe(false);
      expect(byFile['d.pmisparser.js'].error).toMatch(/selfTest/);

      // 安裝結果真的落地:測試廠商 + 甲營造 installed
      expect(registry.status('測試廠商').installed).toBe(true);
      expect(registry.status('甲營造').installed).toBe(true);
      expect(registry.status('查無此家').installed).toBe(false);
    } finally {
      registry.remove('甲營造');
    }
  });

  test('bulk:非 admin → 403', async () => {
    const { hashPassword } = require('../server/password');
    const hash = await hashPassword('password1');
    const { rows } = await db.query(
      "INSERT INTO users (username, password_hash, display_name, role) VALUES ($1, $2, $3, 'user') RETURNING id",
      ['bulkuser', hash, '一般使用者']
    );
    const userToken = jwt.sign({ userId: rows[0].id }, 'test-secret', { expiresIn: '7d' });

    const res = await request(app).post('/api/parsers/bulk')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('files', Buffer.from(dummyParserSource(vendorName)), 'a.pmisparser.js');
    expect(res.status).toBe(403);
  });

  test('bulk:無檔案 → 400', async () => {
    const res = await auth(request(app).post('/api/parsers/bulk'));
    expect(res.status).toBe(400);
  });
});

// ── 純函式:isValidVendorKey(廠商名稱鍵)──
describe('registry.isValidVendorKey', () => {
  test('接受含中文的非空名稱', () => {
    expect(registry.isValidVendorKey('金大營造有限公司')).toBe(true);
    expect(registry.isValidVendorKey('甲')).toBe(true);
    expect(registry.isValidVendorKey('ABC Co')).toBe(true);
  });

  test('拒絕空字串 / 非字串', () => {
    expect(registry.isValidVendorKey('')).toBe(false);
    expect(registry.isValidVendorKey(null)).toBe(false);
    expect(registry.isValidVendorKey(123)).toBe(false);
  });

  test('拒絕檔名危險字元(路徑分隔 / 保留字元)', () => {
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(registry.isValidVendorKey(bad)).toBe(false);
    }
  });

  test('拒絕單獨的 . 與 ..', () => {
    expect(registry.isValidVendorKey('.')).toBe(false);
    expect(registry.isValidVendorKey('..')).toBe(false);
    // 名稱中含點但非單獨點號 → 允許
    expect(registry.isValidVendorKey('甲.乙')).toBe(true);
  });

  test('拒絕開頭 / 結尾空白', () => {
    expect(registry.isValidVendorKey(' 甲')).toBe(false);
    expect(registry.isValidVendorKey('甲 ')).toBe(false);
  });

  test('拒絕超長(>100)', () => {
    expect(registry.isValidVendorKey('甲'.repeat(101))).toBe(false);
    expect(registry.isValidVendorKey('甲'.repeat(100))).toBe(true);
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
