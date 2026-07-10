/**
 * gen-sample-report.js — 產出監造報表(附表五)範例 .xlsx
 *
 * 用 jinda 讀取器對 tests/fixtures/jinda.pdf parseAll,取第一天(2026-04-08)的
 * 資料,配一組「樣本工程主檔值」(工程名稱沿用讀取器抓到的實名,契約金額/工期等
 * 為合理樣本值並註明「範例」),呼叫 buildSupervisionReport →
 * 輸出 docs/samples/監造報表範例_金大_20260408.xlsx。
 *
 * 純 deterministic,不接 AI。路徑一律 path.join(__dirname,...),不寫死絕對路徑。
 *
 * 執行:  node scripts/gen-sample-report.js
 */
const path = require('path');
const fs = require('fs');
const { buildSupervisionReport } = require('../server/report');

const APP_ROOT = path.join(__dirname, '..');       // app/
const REPO_ROOT = path.join(APP_ROOT, '..');       // pmis/
const FIXTURE = path.join(APP_ROOT, 'tests', 'fixtures', 'jinda.pdf');
const OUT_DIR = path.join(REPO_ROOT, 'docs', 'samples');
const OUT_FILE = path.join(OUT_DIR, '監造報表範例_金大_20260408.xlsx');

async function main() {
  const jinda = require('../server/parsers/vendors/samples/jinda.pmisparser.js');
  const ctx = { filetypes: require('../server/parsers/filetypes') };

  const all = await jinda.parseAll(FIXTURE, ctx);
  if (!all.length) throw new Error('讀取器未取得任何天數資料');
  const day1 = all[0]; // 第一天 2026-04-08

  const data = {
    // 主檔:工程名稱沿用讀取器抓到的實名;其餘為合理樣本值(範例)。
    工程: {
      工程名稱: day1.header.工程名稱,
      工程編號: 'SAMPLE-2026-竹崎圍牆-001（範例）',
      契約工期: 90,                 // 範例
      開工日期: '2026-04-08',        // 範例(與讀取器第一天一致)
      契約竣工日: '2026-07-06',      // 範例(開工 +90 天)
      契約金額: 10400248,           // 範例
      決標金額: 10400248,           // 範例
      預定進度: 5,                  // 範例(%)
    },
    // 日報:來自讀取器第一天。
    日報: {
      填報日期: day1.header.填報日期,
      星期: day1.header.星期,
      天氣_上午: day1.header.天氣_上午,  // 金大第二聯無天氣 → null → 留空
      天氣_下午: day1.header.天氣_下午,
      實際進度: day1.header.實際進度,    // 第二聯無實際進度% → null → 留空
      dailyRows: day1.dailyRows,
    },
    // 監造:五大查核項留空給監造方填。
    監造: {},
  };

  const wb = await buildSupervisionReport(data);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  await wb.xlsx.writeFile(OUT_FILE);

  console.log('範例監造報表已產出:', OUT_FILE);
  console.log('  工程名稱:', data.工程.工程名稱);
  console.log('  填報日期:', data.日報.填報日期, data.日報.星期 || '');
  console.log('  細目列數:', data.日報.dailyRows.length);
}

main().catch((err) => {
  console.error('產出失敗:', err);
  process.exit(1);
});
