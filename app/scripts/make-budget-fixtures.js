/**
 * make-budget-fixtures.js — 從本機的發包經費總表實檔抽出測試 fixture
 *
 * 為什麼需要這支:`docs/samples/` 的 xls/xlsx/xlsm 一律不版控(見該目錄 .gitignore),
 * 測試不能直接讀實檔。但**手打 fixture 會寫出與現實不符的資料**——SP1B 手打過
 * 「114一116」(真值其實有空白)導致規則永不觸發卻全綠。故一律從實檔產生。
 *
 * 產出:tests/fixtures/budget/<key>.json = { file, sheets: [{ name, rows }] }
 *   rows 只留 A~F 欄、且去掉尾端空列(版面資訊在前 6 欄,其餘是備註與空白)。
 *
 * 用法(本機有樣本時才跑):node scripts/make-budget-fixtures.js
 */
const fs = require('fs');
const path = require('path');
const x = require('xlsx');

const SRC = path.join(__dirname, '..', '..', 'docs', 'samples', '發包經費總表');
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'budget');

// 挑選依據:每一份都代表一種實測到的樣態,不是隨機取樣。
const PICK = [
  ['nanyang', '南陽國小北棟廁所工程_發包後經費總表.xls'],           // 雙表,第一張是舊底稿殘留
  ['chongxing-toilet', '重興國小廁所_發包後經費總表.xls'],          // 跨檔合併之一
  ['chongxing-sewage', '重興國小汙水_發包後經費總表.xls'],          // 跨檔合併之二(分頁名為「詳細表」)
  ['damei', '114年大美國小老舊廁所整修工程計畫_發包後經費總表.xlsm'], // 單表直取,最單純
  ['sihu-longjump', '四湖國小跳遠場地整修工程_發包後經費總表.xls'],  // 費用項目 8 個(多柒捌玖)
  ['fengrong', '雲林縣豐榮國小教學行政大樓西側老舊廁所整修工程_發包後經費總表.xls'], // 項目最多(34+5=39),擴列案例
  ['taichung-nodetail', '(to 主任)114年度充實設施設備-校園中庭紅磚道路面修復及排水溝設置工程_發包後經費總表0630.xlsm'], // 完全沒有明細
];

fs.mkdirSync(OUT, { recursive: true });

for (const [key, file] of PICK) {
  const abs = path.join(SRC, file);
  if (!fs.existsSync(abs)) {
    console.error(`跳過(本機無此檔):${file}`);
    continue;
  }
  const wb = x.readFile(abs);
  const sheets = wb.SheetNames.map((name) => {
    const rows = x.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, defval: '', blankrows: true, raw: false,
    }).map((r) => r.slice(0, 6).map((c) => String(c)));
    // 去尾端空列:整份 range 常被拉到 80+ 列,存下來只是噪音
    let last = -1;
    rows.forEach((r, i) => { if (r.some((c) => c.trim() !== '')) last = i; });
    return { name, rows: rows.slice(0, last + 1) };
  });
  const out = path.join(OUT, `${key}.json`);
  fs.writeFileSync(out, JSON.stringify({ file, sheets }, null, 1));
  console.log(`${key}: ${sheets.length} 分頁 → ${(fs.statSync(out).size / 1024).toFixed(1)}KB`);
}
