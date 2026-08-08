/**
 * budget-sheet.js — 發包經費總表的讀取與逐項抽取(SP2)
 *
 * Exports:
 *   readSheets(filePath)      實檔 → [{ name, rows }](薄 IO,rows 為 A~F 欄字串矩陣)
 *   parseItems(rows)          單一分頁的列 → 項目清單(純函式)
 *   findCandidates(sheets)    → [{ name, items, 合計 }] 可能是契約價目表的分頁
 *
 * ## 為何分頁判定不看名稱
 *
 * 31 份樣本的分頁命名有 6 種變體:`詳細價目表` / `詳細預算表` / `詳細表` /
 * `(標單)詳細價目表` / 尾端帶空白 / `(2)`。改用結構特徵:**A 欄為阿拉伯數字且
 * 該列有單價的列數 >= 3**。實測分離乾淨——詳細價目表 6~34 項,而經費總表恆為
 * 2 項(那 2 項是「柒 工程管理費」下的學校/縣府管理費)。
 *
 * 判定不必完美:選錯分頁時合計不會等於決標金額,**金額比對是最後防線**
 * (見 contract-items.js)。
 */
const path = require('path');
const x = require('xlsx');

// 費用項目的中文大寫項次。**不含「壹」**:那是「直接工程費」大類標題,沒有
// 數量單價,收下它會在每日施工紀錄多一列要人填「本日完成幾成」的空殼。
// 「参」是「參」的異體字,31 份樣本裡兩種混用;不認就會整個費用項目漏掉。
const FEE_NO = /^[貳贰參参叁肆伍陸陆柒捌玖拾]$/;
const ITEM_NO = /^\d+$/;

// 一份經費總表含兩個子工程時(古坑:A 棒球場圍籬 / B 車棚),項次會帶前綴變成
// `A.壹.1`、`A.貳`。只認純數字/純大寫會讓**整份**收 0 項、候選為 0,SP2 直接卡在
// 「選不出契約詳細價目表」。判定改看最後一段——「壹 是大類標題不收」也自動保持,
// 因為 `A.壹` 的最後一段就是「壹」。
const noKey = (項次) => String(項次).split('.').pop();

/**
 * 這一項是不是「費用項目」(職安衛管理費/品管費/包商管理費/保險費/營業稅…)。
 * 這類項目沒有施工實體,施工日誌不會記,每日進度由 SP3 依契約工期推算
 * (見 daily-log-write.js)。判定與收錄規則共用同一個項次正規化,兩邊不會漂移。
 * @param {string} 項次
 * @returns {boolean}
 */
const isFeeItem = (項次) => FEE_NO.test(noKey(項次));

// 小計/合計/總計列是公式結果。收下它們,累計金額與完成百分比會整份重複計算。
const SUBTOTAL = /小計|合計|總計/;

/**
 * 儲存格 → 數值。千分位與尾隨空白在樣本裡是常態(`1,033 `),
 * 不清就全部變 NaN。
 * @returns {number|null} 非數字回 null
 */
function toNum(v) {
  const s = String(v == null ? '' : v).replace(/[,\s　]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const text = (v) => String(v == null ? '' : v).trim();

/**
 * 單一分頁 → 項目清單。
 *
 * 收錄條件:A 欄是阿拉伯數字或費用項次,且**數量、單價、複價都讀得到數值**。
 * 缺數字的列一律不收——那是大類標題、註記或空列,硬收會產生一筆數量為 null
 * 的項目,寫進範本後每日施工紀錄的公式會拉出一整列的 #VALUE!。
 *
 * @param {Array<Array<string>>} rows A~F 欄字串矩陣
 * @returns {Array<{項次:string,項目:string,單位:string,數量:number,單價:number,複價:number}>}
 */
function parseItems(rows) {
  const out = [];
  for (const row of rows || []) {
    const 項次 = text(row[0]);
    const 項目 = text(row[1]);
    if (SUBTOTAL.test(項次) || SUBTOTAL.test(項目)) continue;
    const key = noKey(項次);
    if (!ITEM_NO.test(key) && !FEE_NO.test(key)) continue;
    const 數量 = toNum(row[3]);
    const 單價 = toNum(row[4]);
    const 複價 = toNum(row[5]);
    if (數量 == null || 單價 == null || 複價 == null) continue;
    out.push({ 項次, 項目, 單位: text(row[2]), 數量, 單價, 複價 });
  }
  return out;
}

// 詳細價目表最少 6 項(東榮災後那份),經費總表恆為 2 項。門檻取 3 是因為
// 這兩群之間沒有交集,而 3 留了餘裕給「管理費不只兩項」的縣市。
const MIN_ITEMS = 3;

/**
 * 找出可能是契約價目表的分頁。
 * @param {Array<{name:string, rows:Array<Array<string>>}>} sheets
 * @returns {Array<{name:string, items:Array<object>, 合計:number}>}
 */
function findCandidates(sheets) {
  const out = [];
  for (const s of sheets || []) {
    const items = parseItems(s.rows);
    if (items.filter((i) => ITEM_NO.test(noKey(i.項次))).length < MIN_ITEMS) continue;
    out.push({ name: s.name, items, 合計: items.reduce((sum, i) => sum + i.複價, 0) });
  }
  return out;
}

const EXT = new Set(['.xls', '.xlsx', '.xlsm']);

/**
 * 讀實檔 → 分頁矩陣。三種副檔名都靠 SheetJS 同一條路徑吃下。
 * 只取 A~F:版面資訊都在前 6 欄,其餘是備註與空白。
 *
 * @throws {Error} code 'BAD_BUDGET_FILE' 副檔名不支援或檔案讀不開
 */
function readSheets(filePath) {
  if (!EXT.has(path.extname(String(filePath)).toLowerCase())) {
    const err = new Error('發包經費總表只接受 .xls / .xlsx / .xlsm');
    err.code = 'BAD_BUDGET_FILE';
    throw err;
  }
  let wb;
  try { wb = x.readFile(filePath); }
  catch (e) {
    const err = new Error('此檔無法開啟,請確認是完整的 Excel 檔案');
    err.code = 'BAD_BUDGET_FILE';
    throw err;
  }
  return wb.SheetNames.map((name) => ({
    name,
    rows: x.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, defval: '', blankrows: true, raw: false,
    }).map((r) => r.slice(0, 6).map((c) => String(c))),
  }));
}

module.exports = { readSheets, parseItems, findCandidates, isFeeItem };
