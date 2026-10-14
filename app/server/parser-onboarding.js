/**
 * parser-onboarding.js — 啟動時掃描讀取器並 upsert 廠商(SP-P)
 *
 * 正式環境不安裝 AI:讀取器由開發環境的 gen-vendor-parser skill 產出後 commit 進 repo。
 * 取得最新讀取器的 `git pull` 在「啟動.bat」裡、node 起來之前跑——放進程內太晚,
 * 拉到的 .js 這一次執行吃不到。這裡只負責掃描安裝:
 *   逐支讀取器 → 驗證安裝 → 有同名廠商就更新讀取器,沒有就新建廠商並綁定;
 *   meta.aliases 列的別名廠商一併設成沿用這支讀取器。
 * 免手動安裝、免按鈕。
 */
const fs = require('fs');
const path = require('path');
const registry = require('./parsers/registry');
const db = require('./db');

// 讀取器來源:隨程式碼樹發佈的 samples 目錄(git pull 會更新這裡)。
const BUNDLED_DIR = path.join(__dirname, 'parsers', 'vendors', 'samples');

/**
 * meta.aliases:同一家公司用不同名稱得標(昌林土木包 = 賜利發土木包),版面相同。
 * 別名廠商沒有就建立,沿用未設定時設成沿用本家——重開即可用,不必到讀取器頁手動設。
 * 已設定沿用(承辦人手動指到別家)不覆蓋;已被別家沿用的不設,避免串接(只解析一層)。
 */
async function linkAliases(q, aliases, vendorKey, vendorId) {
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    if (!registry.isValidVendorKey(alias) || alias === vendorKey) continue;
    let { rows } = await q('SELECT id, parser_vendor_id FROM vendors WHERE name = $1', [alias]);
    if (!rows[0]) {
      ({ rows } = await q('INSERT INTO vendors (name) VALUES ($1) RETURNING id, parser_vendor_id', [alias]));
    }
    if (rows[0].parser_vendor_id != null) continue;
    const { rows: dep } = await q('SELECT id FROM vendors WHERE parser_vendor_id = $1', [rows[0].id]);
    if (dep.length) continue;
    await q('UPDATE vendors SET parser_vendor_id = $1 WHERE id = $2', [vendorId, rows[0].id]);
  }
}

/**
 * 掃描讀取器目錄,逐支安裝並 upsert 廠商。
 * @param {object}   [opts]
 * @param {string}   [opts.dir]   讀取器來源目錄(預設 bundled samples)
 * @param {function} [opts.query] DB query(預設 db.query;測試可注入 pg-mem)
 * @returns {Promise<Array<{file, vendorKey, vendorCreated, ok, error}>>}
 */
async function scanAndInstall(opts = {}) {
  const dir = opts.dir || BUNDLED_DIR;
  const q = opts.query || db.query;
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.pmisparser.js'));
  for (const file of files) {
    const entry = { file, vendorKey: null, vendorCreated: false, ok: false, error: null };
    try {
      const buf = fs.readFileSync(path.join(dir, file));
      const ins = registry.inspect(buf);
      if (!ins.ok || !ins.meta || !ins.meta.vendorKey) {
        entry.error = ins.error || '讀取器驗證失敗';
        results.push(entry);
        continue;
      }
      const vendorKey = String(ins.meta.vendorKey);
      entry.vendorKey = vendorKey;

      const inst = registry.install(buf, vendorKey);
      if (!inst.ok) {
        entry.error = inst.error;
        results.push(entry);
        continue;
      }

      // upsert 廠商:無同名則新建並綁定。
      let { rows } = await q('SELECT id FROM vendors WHERE name = $1', [vendorKey]);
      if (!rows[0]) {
        ({ rows } = await q('INSERT INTO vendors (name) VALUES ($1) RETURNING id', [vendorKey]));
        entry.vendorCreated = true;
      }
      await linkAliases(q, ins.meta.aliases, vendorKey, rows[0].id);
      entry.ok = true;
    } catch (e) {
      entry.error = e.message;
    }
    results.push(entry);
  }
  return results;
}

/**
 * 啟動時 onboarding:掃描安裝讀取器 + upsert 廠商。
 * 全程 best-effort,不因失敗中斷啟動。
 * @returns {Promise<Array>} scanAndInstall 結果
 */
async function runStartupOnboarding() {
  const results = await scanAndInstall();
  const ok = results.filter(r => r.ok).length;
  const created = results.filter(r => r.vendorCreated).length;
  console.log(`[onboarding] 讀取器掃描:安裝 ${ok} 支,新建廠商 ${created} 家`);
  for (const f of results.filter(r => !r.ok)) {
    console.warn(`[onboarding] 略過 ${f.file}:${f.error}`);
  }
  return results;
}

module.exports = { scanAndInstall, runStartupOnboarding, BUNDLED_DIR };
