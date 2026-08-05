/**
 * check-parser.js — 讀取器交付前的品質關卡(gen-vendor-parser skill 的驗證步驟 b、c)
 *
 * 用法:node scripts/check-parser.js <讀取器路徑或 vendorKey> <施工日誌樣本檔>
 *
 * ## 為什麼需要這支
 *
 * 金大讀取器交付時三道既有把關全過(jest 全綠、selfTest true、fixture 斷言通過),
 * 但 17 個明細列裡有 2 列**解析全錯**——項目名稱裡的 "RC" 被當成單位,名稱被截斷、
 * 單位錯、契約數量與單價變 null。沒被抓到的原因是結構性的:
 *
 *   - `selfTest` 的內建小樣本是**產生者自己挑的**,自然挑解得出來的那幾列
 *   - fixture 測試只斷言「某幾個項次」,沒驗到的列錯了也不會紅
 *
 * 這支改成解析**整份**樣本並統計缺漏率,再把結果餵進 SP3 的 39 條驗證——
 * 讀取器讀錯的東西會在那裡變成一大片硬錯(金大會噴 A7:160、J2:160、B3:318)。
 */
const fs = require('fs');
const path = require('path');
const filetypes = require('../server/parsers/filetypes');
const { validateDailyLog, isCategoryRow } = require('../server/daily-log-validate');

const REQUIRED_ROW_FIELDS = ['單位', '契約數量', '契約單價'];

function loadParser(ref) {
  const direct = path.resolve(ref);
  if (fs.existsSync(direct)) return require(direct);
  const sample = path.resolve(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', `${ref}.pmisparser.js`);
  if (fs.existsSync(sample)) return require(sample);
  const registry = require('../server/parsers/registry');
  const wrapped = registry.getParser(ref);
  if (wrapped) return wrapped;
  throw new Error(`找不到讀取器:${ref}`);
}

async function main() {
  const [ref, samplePath] = process.argv.slice(2);
  if (!ref || !samplePath) {
    console.error('用法:node scripts/check-parser.js <讀取器路徑或 vendorKey> <施工日誌樣本檔>');
    process.exit(2);
  }
  const mod = loadParser(ref);
  const days = await mod.parseAll(samplePath, { filetypes });
  console.log(`讀取器:${(mod.meta && mod.meta.vendorKey) || ref}`);
  console.log(`樣本:${path.basename(samplePath)} → ${days.length} 天\n`);

  // ── 關卡 b:解析完整性 ────────────────────────────────────
  const missing = [];   // 每個「非大類列但缺必要欄位」的位置
  let totalRows = 0;
  const headerMissing = {};
  // 某欄位在**所有明細列**都缺 = 這個格式不提供該欄(富森就沒有契約單價),
  // 不是讀取器讀不到。判準與 SP3 一致:整份缺→格式限制,部分缺→才是漏讀。
  // 不分這兩者的話,富森會被報成「100% 缺漏」而看不出真正有問題的列。
  const allRows = days.flatMap((d) => (d.dailyRows || []).filter((r) => !isCategoryRow(r)));
  const absentFields = REQUIRED_ROW_FIELDS.filter(
    (f) => allRows.length && allRows.every((r) => r[f] == null || r[f] === '')
  );
  const checkFields = REQUIRED_ROW_FIELDS.filter((f) => !absentFields.includes(f));
  for (const d of days) {
    const h = d.header || {};
    for (const [k, v] of Object.entries(h)) {
      if (v == null || v === '') headerMissing[k] = (headerMissing[k] || 0) + 1;
    }
    for (const r of d.dailyRows || []) {
      if (isCategoryRow(r)) continue;
      totalRows++;
      const lack = checkFields.filter((f) => r[f] == null || r[f] === '');
      if (lack.length) {
        missing.push({ 日期: h.填報日期, 項次: r.項次, 工程項目: r.工程項目, 缺: lack });
      }
    }
  }

  console.log('── 關卡 b:解析完整性 ──');
  if (absentFields.length) {
    console.log(`  此格式不提供:${absentFields.join('、')}(整份皆空,已排除於缺漏統計外)`);
  }
  console.log(`明細列 ${totalRows} 列,缺必要欄位 ${missing.length} 列 ` +
    `(${totalRows ? (missing.length / totalRows * 100).toFixed(1) : 0}%)`);
  if (missing.length) {
    // 同一個項次通常每天都錯,按項次收斂才看得出是哪幾列有問題
    const byItem = new Map();
    for (const m of missing) {
      const k = `${m.項次} ${m.工程項目}`;
      const cur = byItem.get(k) || { 次數: 0, 缺: new Set() };
      cur.次數++;
      m.缺.forEach((f) => cur.缺.add(f));
      byItem.set(k, cur);
    }
    for (const [k, v] of byItem) {
      console.log(`  ✗ 項次 ${k} — 缺 ${[...v.缺].join('/')}(${v.次數} 天)`);
    }
  }
  const headerAllMissing = Object.entries(headerMissing).filter(([, n]) => n === days.length);
  if (headerAllMissing.length) {
    console.log(`  header 整份皆空:${headerAllMissing.map(([k]) => k).join('、')}`);
  }

  // ── 關卡 c:跨層驗證(SP3 的 39 條)────────────────────────
  // 契約表用該份日誌自己的契約值當基準:這裡要的是「讀取器有沒有讀錯」,
  // 不是「廠商有沒有填錯」,故不需要真的 SP2 契約表。
  const contract = [];
  const seen = new Set();
  for (const d of days) {
    for (const r of d.dailyRows || []) {
      if (isCategoryRow(r) || r.項次 == null || seen.has(String(r.項次))) continue;
      if (r.單位 == null || r.契約數量 == null) continue;
      seen.add(String(r.項次));
      contract.push({
        項次: String(r.項次), 項目: r.工程項目, 單位: r.單位,
        數量: Number(r.契約數量), 單價: Number(r.契約單價),
      });
    }
  }
  const result = validateDailyLog({ days, contract, project: {} });
  const tally = (arr) => {
    const m = {};
    for (const e of arr) m[e.code] = (m[e.code] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || '(無)';
  };
  console.log('\n── 關卡 c:跨層驗證(SP3 39 條)──');
  console.log(`硬錯 ${result.errors.length} 項 → ${tally(result.errors)}`);
  console.log(`軟警告 ${result.warnings.length} 項 → ${tally(result.warnings)}`);
  console.log(`未檢查 → ${result.skipped.map((s) => s.code).join(' ')}`);
  for (const e of result.errors.slice(0, 5)) {
    console.log(`  例:${e.code} ${e.日期 || ''} 項次${e.項次 || '-'} ${e.訊息}`);
  }

  const pass = missing.length === 0 && result.errors.length === 0;
  console.log(`\n結果:${pass ? '通過' : '未通過 —— 逐條確認是廠商填錯還是讀取器讀錯,後者一律回頭修讀取器'}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('失敗:', e.message); process.exit(2); });
