const os = require('os');
const fs = require('fs');
const path = require('path');

// 讀取檔落地根用暫存目錄,避免污染真 data/;須在 require registry 前設定。
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-onboard-test-'));
process.env.PMIS_DATA_DIR = TMP_DATA;

const { newDb } = require('pg-mem');
const db = require('../server/db');
const registry = require('../server/parsers/registry');
const { scanAndInstall, BUNDLED_DIR } = require('../server/parser-onboarding');

function freshPool() {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

// 掃描來源用**只放三支的暫存目錄**,不掃真正的 samples/。
//
// 為什麼:`registry.install` 是用 `Module._compile` 載入讀取器的(刻意繞過 Jest 沙箱,
// 好讓讀取器 require 得到 xlsx/pdf-parse)。掃 samples/ 等於在一支測試裡做
// 「支數 × 2」次繞過沙箱的編譯——支數隨每次補讀取器成長,實測到 19 支時這支測試
// 從 1.7 秒變 10.9 秒,並且**間歇性地毒到同一個 worker 的鄰居測試**:那些殘留在
// 全域 require cache 的模組會讓後續 pg 的 lazy `require('pgpass')` 拿到壞的 entry,
// 噴出 `TypeError: pgPass is not a function` 這種與測試內容無關的 Unhandled error
// (四次全跑會中一次,每次陪葬的鄰居還不一樣)。
//
// 這支要驗的是 upsert 的行為,不是「repo 裡目前有幾支讀取器」——後者本來就會隨時間漂移。
const FIXED_SAMPLES = ['jinda', 'zhidong', 'changze'];   // PDF 座標型 / Excel 型 / 雙檔型
let SRC_DIR;

beforeAll(() => {
  SRC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-onboard-src-'));
  for (const key of FIXED_SAMPLES) {
    const file = `${key}.pmisparser.js`;
    fs.copyFileSync(path.join(BUNDLED_DIR, file), path.join(SRC_DIR, file));
  }
});

describe('scanAndInstall 啟動掃描 upsert', () => {
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
  });
  afterEach(() => db._setPoolForTesting(null));

  test('掃讀取器目錄:安裝並自動建立同名廠商', async () => {
    const results = await scanAndInstall({ dir: SRC_DIR, query: db.query });
    const ok = results.filter(r => r.ok);
    expect(ok.length).toBe(FIXED_SAMPLES.length);

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
    await scanAndInstall({ dir: SRC_DIR, query: db.query });
    const second = await scanAndInstall({ dir: SRC_DIR, query: db.query });
    expect(second.every(r => r.ok)).toBe(true);
    expect(second.some(r => r.vendorCreated)).toBe(false); // 第二次都不新建
    const { rows } = await db.query('SELECT name FROM vendors');
    expect(rows.length).toBe(second.filter(r => r.ok).length); // 無重複廠商
  });
});

// 上面那支不再掃 samples/,所以「有人 commit 了裝不起來的讀取器」要由這裡守。
// 刻意用 Jest 自己的 require + validateModule(**不**走 install 的 Module._compile、
// 不寫任何檔、不碰 DB),才不會重蹈上面說的沙箱污染。
describe('bundled 讀取器健康檢查', () => {
  const files = fs.readdirSync(BUNDLED_DIR).filter(f => f.endsWith('.pmisparser.js'));

  test('samples 目錄不是空的', () => {
    expect(files.length).toBeGreaterThanOrEqual(FIXED_SAMPLES.length);
  });

  test.each(files)('%s 的 meta 合法且 selfTest 通過', (file) => {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(path.join(BUNDLED_DIR, file));
    expect(mod.meta && mod.meta.vendorKey).toBeTruthy();
    // vendorKey 是 registry 歸位的唯一依據,拼錯不會有任何錯誤訊息,
    // 只會讓那家的日誌永遠叫不出讀取器(玉森踩過,71 份閒置一整輪)。
    expect(registry.isValidVendorKey(mod.meta.vendorKey)).toBe(true);
    expect(registry.validateModule(mod, mod.meta.vendorKey)).toMatchObject({ ok: true });
  });
});
