/**
 * parser-onboarding.js — 啟動時掃描讀取器並 upsert 廠商(SP-P)
 *
 * 正式環境不安裝 AI:讀取器由開發環境的 gen-vendor-parser skill 產出後 commit 進 repo。
 * 正式環境啟動時 `git pull` 取得最新讀取器,再呼叫 scanAndInstall:
 *   逐支讀取器 → 驗證安裝 → 有同名廠商就更新讀取器,沒有就新建廠商並綁定。
 * 免手動安裝、免按鈕。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const registry = require('./parsers/registry');
const db = require('./db');

// 讀取器來源:隨程式碼樹發佈的 samples 目錄(git pull 會更新這裡)。
const BUNDLED_DIR = path.join(__dirname, 'parsers', 'vendors', 'samples');
// repo 根(app/server → app → repo),供 git pull。
const REPO_ROOT = path.resolve(__dirname, '../..');

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
      const { rows } = await q('SELECT id FROM vendors WHERE name = $1', [vendorKey]);
      if (!rows[0]) {
        await q('INSERT INTO vendors (name) VALUES ($1)', [vendorKey]);
        entry.vendorCreated = true;
      }
      entry.ok = true;
    } catch (e) {
      entry.error = e.message;
    }
    results.push(entry);
  }
  return results;
}

// 啟動時取得最新讀取器(best-effort;無 remote/衝突一律略過,不擋啟動)。
function gitPull() {
  return new Promise((resolve) => {
    execFile('git', ['pull', '--ff-only'], { cwd: REPO_ROOT, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) console.warn('[onboarding] git pull 略過:', String(stderr || err.message).trim());
      else console.log('[onboarding] git pull:', String(stdout).trim() || 'up to date');
      resolve();
    });
  });
}

/**
 * 啟動時 onboarding:git pull 取得最新讀取器 → 掃描安裝 + upsert 廠商。
 * 全程 best-effort,不因失敗中斷啟動。
 * @returns {Promise<Array>} scanAndInstall 結果
 */
async function runStartupOnboarding() {
  await gitPull();
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
