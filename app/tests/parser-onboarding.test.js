const os = require('os');
const fs = require('fs');
const path = require('path');

// 讀取檔落地根用暫存目錄,避免污染真 data/;須在 require registry 前設定。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-onboard-test-'));
process.env.PMIS_DATA_DIR = TMP_DATA;

const { newDb } = require('pg-mem');
const db = require('../server/db');
const registry = require('../server/parsers/registry');
const { scanAndInstall } = require('../server/parser-onboarding');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

describe('scanAndInstall 啟動掃描 upsert', () => {
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  test('掃 bundled 讀取器:安裝並自動建立同名廠商', async () => {
    const results = await scanAndInstall({ query: db.query });
    const ok = results.filter(r => r.ok);
    expect(ok.length).toBeGreaterThanOrEqual(3); // jinda/jinlin/zhidong

    // 每支都新建了同名廠商
    expect(ok.every(r => r.vendorCreated)).toBe(true);
    const { rows } = await db.query('SELECT name FROM vendors');
    expect(rows.length).toBe(ok.length);

    // 讀取器確實安裝
    for (const r of ok) {
      expect(registry.status(r.vendorKey).installed).toBe(true);
    }
  });

  test('重跑冪等:廠商已存在則只更新讀取器,不重複建', async () => {
    await scanAndInstall({ query: db.query });
    const second = await scanAndInstall({ query: db.query });
    expect(second.every(r => r.ok)).toBe(true);
    expect(second.some(r => r.vendorCreated)).toBe(false); // 第二次都不新建
    const { rows } = await db.query('SELECT name FROM vendors');
    expect(rows.length).toBe(second.filter(r => r.ok).length); // 無重複廠商
  });
});
