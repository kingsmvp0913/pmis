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
 * 這支改成解析**整份**樣本並統計缺漏率,再把結果餵進 SP3 的 42 條驗證——
 * 讀取器讀錯的東西會在那裡變成一大片硬錯(金大會噴 A7:160、J2:160、B3:318)。
 */
const fs = require('fs');
const path = require('path');
const filetypes = require('../server/parsers/filetypes');
// ⚠️ 名稱形狀健檢**已搬進 daily-log-validate**(產線的 J5),這裡改成共用同一份。
// 原本兩邊各一份:這支腳本擋得住的東西,上線之後一條防線都沒有——2026-08-15
// 逐家走查修掉的四支讀取器(明德整列不見、富森兩個名稱黏在一起)正是這一類。
// 留兩份也必然漂掉:改了一邊,另一邊還在用舊規則,而且不會有任何錯誤訊息。
const { validateDailyLog, isCategoryRow, detectNameAnomalies } = require('../server/daily-log-validate');

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

/**
 * 從 DB 取某工程已建好的契約詳細價目表(SP2 的產出)當**外部基準**。
 *
 * 為什麼需要它:預設的自我基準(見關卡 c)是拿日誌自己的第一次出現值當契約值,
 * 讀取器若每天都用同樣方式讀錯,自我比對永遠一致——系統性讀錯完全看不見。
 * 接上真實契約表之後,E3(名稱)/E4(單位)/E5(數量)/E6(單價)才有第二個來源可比。
 *
 * 連線設定讀 data/config.json(同 scripts/start.js 的作法),不寫死絕對路徑。
 */
async function loadContractFromDb(projectId) {
  const cfgPath = path.resolve(__dirname, '..', '..', 'data', 'config.json');
  if (!fs.existsSync(cfgPath)) throw new Error(`找不到 ${cfgPath},無法連 DB 取契約表`);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.DATABASE_URL) process.env.DATABASE_URL = cfg.DATABASE_URL;
  const { query } = require('../server/db');
  const { rows } = await query(
    `SELECT item_no, name, unit, quantity, unit_price FROM contract_items
      WHERE project_id = $1 ORDER BY seq`, [projectId]);
  if (!rows.length) throw new Error(`工程 ${projectId} 沒有契約詳細價目表(SP2 尚未建立?)`);
  return rows.map((r) => ({
    項次: String(r.item_no), 項目: r.name, 單位: r.unit,
    數量: Number(r.quantity), 單價: Number(r.unit_price),
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf('--contract');
  const contractRef = ci >= 0 ? argv[ci + 1] : null;
  // 沒有 --contract 時 ci 是 -1,不可拿 ci+1 當索引過濾——那會把第一個參數濾掉。
  const [ref, samplePath] = ci >= 0 ? argv.filter((_, i) => i !== ci && i !== ci + 1) : argv;
  if (!ref || !samplePath) {
    console.error('用法:node scripts/check-parser.js <讀取器路徑或 vendorKey> <施工日誌樣本檔> [--contract <工程id>]');
    console.error('  --contract:改用該工程已建好的契約詳細價目表當基準(預設是拿日誌自身的值當基準,');
    console.error('              看不到系統性讀錯——每天都用同樣方式讀錯時,自我比對永遠一致)');
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
  // 與產線 A7 的判準一致：同一項跨多天每次都沒有契約數量，是來源格式未提供，
  // 不是讀取器偶發漏讀。只排除該項的該欄，其他項目或部分天數缺值仍列為缺漏。
  const absentQtyItems = new Set();
  if (days.length >= 2) {
    const states = new Map();
    for (const r of allRows) {
      if (r.項次 == null) continue;
      const key = String(r.項次);
      const state = states.get(key) || { count: 0, allBlank: true };
      state.count++;
      if (r.契約數量 != null && r.契約數量 !== '') state.allBlank = false;
      states.set(key, state);
    }
    for (const [key, state] of states) {
      if (state.count >= 2 && state.allBlank) absentQtyItems.add(key);
    }
  }
  const checkFields = REQUIRED_ROW_FIELDS.filter((f) => !absentFields.includes(f));
  for (const d of days) {
    const h = d.header || {};
    for (const [k, v] of Object.entries(h)) {
      if (v == null || v === '') headerMissing[k] = (headerMissing[k] || 0) + 1;
    }
    for (const r of d.dailyRows || []) {
      if (isCategoryRow(r)) continue;
      totalRows++;
      const lack = checkFields.filter((f) => (r[f] == null || r[f] === '')
        && !(f === '契約數量' && absentQtyItems.has(String(r.項次))));
      if (lack.length) {
        missing.push({ 日期: h.填報日期, 項次: r.項次, 工程項目: r.工程項目, 缺: lack });
      }
    }
  }

  console.log('── 關卡 b:解析完整性 ──');
  if (absentFields.length) {
    console.log(`  此格式不提供:${absentFields.join('、')}(整份皆空,已排除於缺漏統計外)`);
  }
  if (absentQtyItems.size) {
    console.log(`  項目未提供契約數量:${[...absentQtyItems].join('、')}(跨多天皆空,已排除於缺漏統計外)`);
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
  // 名稱形狀健檢:缺漏統計看不到「名稱被切錯」,因為錯位不會讓任何欄位變 null。
  const nameAnomalies = detectNameAnomalies(allRows);
  if (nameAnomalies.length) {
    console.log(`\n  ⚠ 疑似名稱錯位 ${nameAnomalies.length} 項(名稱被切錯不會讓欄位變 null,缺漏統計看不到):`);
    for (const a of nameAnomalies.slice(0, 10)) {
      console.log(`    項次 ${a.項次} [${a.code}] ${a.why}`);
      console.log(`      「${a.名稱.slice(0, 40)}${a.名稱.length > 40 ? '…' : ''}」`);
    }
    if (nameAnomalies.length > 10) console.log(`    …另有 ${nameAnomalies.length - 10} 項`);
  }

  const headerAllMissing = Object.entries(headerMissing).filter(([, n]) => n === days.length);
  if (headerAllMissing.length) {
    console.log(`  header 整份皆空:${headerAllMissing.map(([k]) => k).join('、')}`);
  }

  // ── 關卡 c:跨層驗證(SP3 的 42 條)────────────────────────
  // 預設基準:該份日誌自己的第一次出現值。這樣不需要真的 SP2 契約表就能跑,
  // 但**只看得到「同一項次跨天不一致」,看不到系統性讀錯**——讀取器若每天都用
  // 同樣方式讀錯,自我比對永遠一致(富森的名稱錯位就是這樣躲過三道關卡的)。
  // 要抓系統性讀錯,用 --contract <工程id> 接上真實的契約詳細價目表當外部基準。
  let contract;
  let 基準說明;
  if (contractRef) {
    contract = await loadContractFromDb(contractRef);
    基準說明 = `外部基準:工程 ${contractRef} 的契約詳細價目表(${contract.length} 項)`;
  } else {
    contract = [];
    const seen = new Set();
    for (const d of days) {
      for (const r of d.dailyRows || []) {
        if (isCategoryRow(r) || r.項次 == null || seen.has(String(r.項次))) continue;
        if (r.單位 == null || r.契約單價 == null) continue;
        seen.add(String(r.項次));
        contract.push({
          項次: String(r.項次), 項目: r.工程項目, 單位: r.單位,
          數量: r.契約數量 == null ? null : Number(r.契約數量), 單價: Number(r.契約單價),
        });
      }
    }
    基準說明 = '自我基準:日誌自身的第一次出現值 —— 看不到系統性讀錯,'
      + '要抓請加 --contract <工程id>';
  }
  const result = validateDailyLog({ days, contract, project: {} });
  const tally = (arr) => {
    const m = {};
    for (const e of arr) m[e.code] = (m[e.code] || 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ') || '(無)';
  };
  console.log('\n── 關卡 c:跨層驗證(SP3 42 條)──');
  console.log(`  ${基準說明}`);
  console.log(`硬錯 ${result.errors.length} 項 → ${tally(result.errors)}`);
  console.log(`軟警告 ${result.warnings.length} 項 → ${tally(result.warnings)}`);
  console.log(`未檢查 → ${result.skipped.map((s) => s.code).join(' ')}`);
  for (const e of result.errors.slice(0, 5)) {
    console.log(`  例:${e.code} ${e.日期 || ''} 項次${e.項次 || '-'} ${e.訊息}`);
  }

  // 名稱異常一併納入判定:八家實測零誤報(只有富森 10 項、陳宏鈞 1 項命中,都是真的
  // 被切錯),而名稱錯了會讓下游的「依名稱對應契約項目」失效——那是項次對不上時
  // 唯一的退路,退路也錯就沒有東西接得住了。
  const pass = missing.length === 0 && nameAnomalies.length === 0 && result.errors.length === 0;
  console.log(`\n結果:${pass ? '通過' : '未通過 —— 逐條確認是廠商填錯還是讀取器讀錯,後者一律回頭修讀取器'}`);
  process.exit(pass ? 0 : 1);
}

// 只有直接執行才跑;被 require(測試)時不得自己啟動,否則會吃到呼叫端的 argv。
if (require.main === module) {
  main().catch((e) => { console.error('失敗:', e.message); process.exit(2); });
}

module.exports = { detectNameAnomalies };
