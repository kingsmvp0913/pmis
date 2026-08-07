/**
 * project-basics.js — 工程基本資料的比對與寫入指令組裝(SP1 業務層)
 *
 * 純函式,不碰檔案系統、不碰 DB。IO 由 project-basics-routes.js 負責。
 *
 * Exports:
 *   COMPARABLE                    可與決標公告比對的欄位(順序即畫面顯示順序)
 *   compareBasics(award, project) 逐欄比對 → [{欄位, 決標公告值, 主檔值, 狀態}]
 *   CELL_OF                       欄位 → 「工程基本資料」分頁儲存格對照表
 *   basicsToOperations(values)    9 值 → SP0 template-engine 的 setCell 指令
 */

const { isoToExcelSerial } = require('./parsers/filetypes/xlsx');

// 決標公告能提供、且主檔也有對應值的欄位。契約工期/開工日期不在此列
// (決標公告推不出,見 spec §4.3);監造單位/設計單位來自系統設定,無從比對。
const COMPARABLE = ['工程名稱', '主辦機關', '承包廠商', '契約金額', '工程編號'];

/**
 * 空白正規化與空值統一,所有欄位共用:承辦人輸入與公告排版的半形/全形空白
 * 差異不是實質不一致,一併去除;空字串視同缺值。
 *
 * NFKC 排在去空白**之前**:它會把全形空白 U+3000 折成半形空白,順序顛倒的話
 * 那個空白會留下來。NFKC 同時把全形標點與全形英數折成半形——決標公告的文字在
 * pdf.js 已做過 NFKC,主檔的值卻是承辦人打的、常留全形,兩邊不同層做正規化就會
 * 把同一個名稱判成 diff。49 個舊案對照人工報表抓到的實例:
 * 「校園環境安全改善～文安國小…」vs 同名的半形波浪號版本。
 * 同型問題 SP3 的 daily-log-validate 已於 454ba35 修過,這層當時漏了。
 *
 * NFKC **不做數值轉換**,故識別碼的前導零原樣保留('0123' 不會變 '123')——
 * 那個折疊會把兩個不同的案號當成同一個,見 normalizeAmount 的說明。
 */
function normalizeText(v) {
  if (v == null) return null;
  const s = String(v).normalize('NFKC').replace(/[\s　]/g, '');
  return s === '' ? null : s;
}

/**
 * 契約金額專用正規化:在空白/空值正規化之上,把純數字字串轉成數值再轉回,
 * 消去 '3057698.00' 這類尾綴差異——主檔 award_amount 是 PostgreSQL NUMERIC,
 * pg 依驅動可能回 '3057698' 或 '3057698.00',不正規化的話每次都判 diff。
 *
 * 只能套用在契約金額,不可套用到其餘欄位:工程編號等是識別碼而非數值,
 * 案號格式各機關自訂、沒有「不含前導零」的上界保證,對識別碼做數值轉換
 * 會把 '0123' 轉成 '123',讓兩個實際不同的編號被誤判為相同。
 */
function normalizeAmount(v) {
  const s = typeof v === 'number' ? String(v) : normalizeText(v);
  if (s == null) return null;
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : s;
}

function normalize(v, 欄位) {
  return 欄位 === '契約金額' ? normalizeAmount(v) : normalizeText(v);
}

/**
 * 逐欄比對決標公告解析值與 PMIS 專案主檔值。
 *
 * 狀態三態不可壓成布林:'missing'(沒得比)與 'diff'(比出來不同)在畫面上的
 * 提示與承辦人的處理方式不同,壓成布林會讓硬擋誤判。
 *
 * @param {object} award   parseAwardNotice 的輸出
 * @param {object} project 主檔側同名欄位
 * @returns {Array<{欄位:string, 決標公告值:any, 主檔值:any, 狀態:'match'|'diff'|'missing'}>}
 */
function compareBasics(award, project) {
  const a = award || {};
  const p = project || {};
  return COMPARABLE.map((欄位) => {
    const na = normalize(a[欄位], 欄位);
    const np = normalize(p[欄位], 欄位);
    let 狀態;
    if (na == null || np == null) 狀態 = 'missing';
    else if (na === np) 狀態 = 'match';
    else 狀態 = 'diff';
    return {
      欄位,
      決標公告值: a[欄位] == null ? null : a[欄位],
      主檔值: p[欄位] == null ? null : p[欄位],
      狀態,
    };
  });
}

// 欄位 → 「工程基本資料」分頁儲存格。
// B9 完工期限是範本公式 =B8+B7-1,**任何情況都不得寫入**,否則公式被換成死值,
// 之後 SP2/SP3 改了工期或開工日,完工期限不會跟著動。
const CELL_OF = {
  工程名稱: 'B1',
  監造單位: 'B2',
  主辦機關: 'B3',
  設計單位: 'B4',
  承包廠商: 'B5',
  契約金額: 'B6',
  契約工期: 'B7',
  開工日期: 'B8',
  工程編號: 'B10',
};

/**
 * 把 9 值組成 SP0 template-engine 的 setCell 指令。
 *
 * 未提供(undefined)的欄位**不產生指令**——專案報表是常駐檔,SP2/SP3 之後也往
 * 同一份寫,只補一欄時不該連帶清空別欄。明確傳 null 才會清該格。
 *
 * @param {object} values 鍵為 CELL_OF 的欄位名
 * @returns {Array<{type:'setCell', sheet:string, addr:string, value:any}>}
 */
function basicsToOperations(values) {
  const v = values || {};
  const ops = [];
  for (const [欄位, addr] of Object.entries(CELL_OF)) {
    if (v[欄位] === undefined) continue;
    // 開工日期須以 Excel 序號寫入,B9 的 =B8+B7-1 才算得出完工期限
    const value = 欄位 === '開工日期' ? isoToExcelSerial(v[欄位]) : v[欄位];
    ops.push({ type: 'setCell', sheet: '工程基本資料', addr, value: value == null ? null : value });
  }
  return ops;
}

// normalizeText/normalizeAmount 對外露出,是給 scripts/check-against-truth.js 用的:
// 那支拿舊案的人工報表當外部基準比對讀取器,「哪些差異算等價」必須與這裡同一份判定。
// 各寫一份就會漂移——報告說「等價」而系統實際判 diff(或反之)。
module.exports = {
  COMPARABLE, compareBasics, CELL_OF, basicsToOperations, normalizeText, normalizeAmount,
};
