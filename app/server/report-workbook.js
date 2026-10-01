/**
 * report-workbook.js — 專案監造報表 .xlsm 的生命週期
 *
 * 每個專案一份**常駐檔**:SP1 建立並寫工程基本資料,SP2 往同一份寫契約詳細價目表,
 * SP3 往同一份寫每日施工紀錄。故 ensureWorkbook 對已存在的檔一律原樣沿用,
 * 絕不以範本覆蓋——覆蓋等於把 SP2/SP3 的成果整份洗掉。
 *
 * Exports:
 *   TEMPLATE_PATH             公版範本絕對路徑(app/templates/)
 *   workbookPath(projectId)   該專案報表應在的路徑(不保證存在)
 *   ensureWorkbook(projectId) 不存在則由範本複製一份,回絕對路徑
 *   itemRowCounts(xlsmPath)   由實檔量出各分頁目前有幾列項目列
 */
const fs = require('fs');
const path = require('path');
const x = require('xlsx');
const {
  supervisionItemRowCount, formulaItemRowCount, INDEX_ROWS,
} = require('./contract-items');

// 資料根:相對本檔求出(app/server → repo/data),禁止寫死絕對路徑。
// 測試以 PMIS_DATA_DIR 覆寫,避免污染真 data/(與 registry.js / history-routes.js 一致)。
const DATA_DIR = process.env.PMIS_DATA_DIR
  ? path.resolve(process.env.PMIS_DATA_DIR)
  : path.resolve(__dirname, '../../data');
const REPORT_DIR = path.join(DATA_DIR, 'reports');

// 正式底稿。放 app/templates/ 而非 docs/samples/(範例庫語意)或 tests/fixtures/(測試資產)。
const TEMPLATE_PATH = path.resolve(__dirname, '../templates/監造報表_空白公版範本.xlsm');

// projects.id 是 PostgreSQL SERIAL,合法值本來就只會是正整數字串/數字。
// 只接受這個形狀,是因為路由層 ensureWorkbook(req.params.id) 會把外部輸入(未經 DB 查驗)
// 直接傳進來——Express 對路徑參數做 percent-decoding,'../../etc' 這類值能原樣穿過來,
// 若不在這裡擋,path.join 就會把它拼進路徑,逃出 REPORT_DIR 造成任意檔案寫入/覆蓋。
const PROJECT_ID_RE = /^[1-9][0-9]*$/;

/**
 * 驗證 projectId 為正整數(字串或數字皆可),不合法就丟明確錯誤而非靜默回 null/預設值——
 * 靜默處理會讓錯誤的 projectId 悄悄寫到別的專案的檔案上。
 * @param {number|string} projectId
 * @returns {string} 正規化後的正整數字串
 * @throws {Error} projectId 不是正整數
 */
function assertValidProjectId(projectId) {
  const s = String(projectId);
  if (!PROJECT_ID_RE.test(s)) {
    throw new Error(`projectId 不合法(必須是正整數):${JSON.stringify(projectId)}`);
  }
  return s;
}

/**
 * 該專案報表應在的路徑(不保證檔案存在)。驗證放在這裡(建路徑的邊界),
 * 讓任何未來呼叫端(含尚未寫的路由)都受保護,不必各自記得驗證。
 * @param {number|string} projectId
 * @returns {string} 絕對路徑
 * @throws {Error} projectId 不是正整數
 */
function workbookPath(projectId) {
  const id = assertValidProjectId(projectId);
  return path.join(REPORT_DIR, `project_${id}`, '監造報表.xlsm');
}

/**
 * 取得該專案的報表檔;不存在則由公版範本複製一份。已存在則原樣回傳,不覆蓋。
 * @param {number|string} projectId
 * @returns {string} 絕對路徑
 * @throws {Error} 公版範本不存在時
 */
function ensureWorkbook(projectId) {
  const dest = workbookPath(projectId);
  if (fs.existsSync(dest)) return dest;
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`公版範本不存在:${TEMPLATE_PATH}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(TEMPLATE_PATH, dest);
  return dest;
}

/**
 * 各分頁目前有幾列項目列,由**實檔**量出——報表是常駐檔,可能已被前一次寫入刪過列,
 * 也可能是承辦人自己上傳的那份。用範本常數推會刪到報表正文,而刪掉的正文不會有
 * 任何錯誤訊息。
 *
 * 監造報表看得到正文錨點(項目區正下方就是正文);另兩個分頁下方是空白,只能數
 * 「從第 2 列起連續有公式的列」。讀不到就回 null → 那個分頁只擴不刪。
 *
 * 放在這裡而不是 contract-items.js:後者刻意維持純函式(不碰檔案系統)。
 * 而 SP2 與 SP3 兩條寫入路徑都要量同一份常駐檔,量法只能有一份。
 */
function itemRowCounts(xlsmPath) {
  const 空 = { 監造報表: null, 每日施工紀錄: null, 契約詳細價目表: null };
  let wb;
  try { wb = x.readFile(xlsmPath, { sheets: ['監造報表', '每日施工紀錄', '契約詳細價目表'] }); }
  catch { return 空; }
  const 逐列 = (sheet, col, pick) => {
    const ws = wb.Sheets[sheet];
    if (!ws || !ws['!ref']) return [];
    const { e } = x.utils.decode_range(ws['!ref']);
    return Array.from({ length: e.r + 1 }, (_, i) => pick(ws[`${col}${i + 1}`]));
  };
  const 值 = (c) => (c == null || c.v == null ? '' : String(c.v));
  const 是公式 = (c) => !!(c && c.f);
  try {
    return {
      監造報表: supervisionItemRowCount(逐列('監造報表', 'A', 值)),
      每日施工紀錄: formulaItemRowCount(逐列('每日施工紀錄', 'A', 是公式),
        INDEX_ROWS.每日施工紀錄.first),
      契約詳細價目表: formulaItemRowCount(逐列('契約詳細價目表', 'F', 是公式),
        INDEX_ROWS.契約詳細價目表.first),
    };
  } catch { return 空; }
}

// 進度區塊在合計列之下的固定相對位置(合計列 +0 起);監造報表 B7/F7 以 A 欄標籤 MATCH 找列。
const PROGRESS_LABELS = ['(合計)', '每日實際進度(%)', '實際進度', '總實際進度(%)', '每日預定進度(%)', '預定進度'];

/**
 * 量每日施工紀錄的進度區塊缺了什麼(供 SP3 補舊常駐報表)。
 *
 * 8/11 以前的公版範本少了 A 欄的進度標籤與預定進度那一列公式,監造報表的
 * B7/F7 找不到列,匯出的每一天進度都是空白;常駐檔不會跟著範本更新。
 * 合計列會因刪項目列而上移,故以 F 欄的 `ROUND(SUM(F2:…))` 公式認,不寫死列號。
 *
 * @returns {{合計列:number, 末欄:string, 缺標籤列:number[], 預定列空:boolean}|null}
 *   缺標籤列:合計列本身(B 欄「(合計)」)與其下五列中 A 欄沒有標籤的列號;
 *   預定列空:合計列 +6 那列在 J 欄以後完全沒有內容(有手填值就不是空)。讀不到回 null。
 */
function progressBlock(xlsmPath) {
  let wb;
  try { wb = x.readFile(xlsmPath, { sheets: ['每日施工紀錄'], cellFormula: true }); }
  catch { return null; }
  const ws = wb.Sheets['每日施工紀錄'];
  if (!ws || !ws['!ref']) return null;
  const { e } = x.utils.decode_range(ws['!ref']);
  let r0 = null;
  for (let r = 2; r <= e.r + 1; r++) {
    const c = ws[`F${r}`];
    if (c && c.f && /^ROUND\(SUM\(F2:/i.test(c.f)) { r0 = r; break; }
  }
  if (r0 == null) return null;
  let 末 = 9;
  for (let c = 9; c <= e.c; c++) if (ws[x.utils.encode_cell({ r: r0 - 1, c })]) 末 = c;
  const 有值 = (c) => !!(c && (c.f || (c.v != null && String(c.v).trim() !== '')));
  const 缺標籤列 = [];
  PROGRESS_LABELS.forEach((label, i) => {
    const col = i === 0 ? 'B' : 'A';
    if (!有值(ws[`${col}${r0 + i}`])) 缺標籤列.push(r0 + i);
  });
  let 預定列空 = true;
  for (let c = 9; c <= 末 && 預定列空; c++) {
    if (有值(ws[x.utils.encode_cell({ r: r0 + 5, c })])) 預定列空 = false;
  }
  // 範本的每日完成金額是 SUMPRODUCT($E$2:$E$37,…),只加到第 37 列:項目超過 36 項時,
  // 多出來的項目做了也不算進實際進度。範圍沒涵蓋到合計列上一列就算不足。
  const jf = (ws[`J${r0}`] && ws[`J${r0}`].f) || '';
  const m = jf.match(/\$E\$2:\$E\$(\d+)/);
  const 合計範圍不足 = !m || Number(m[1]) < r0 - 1;
  // 合計列 +7:廠商填報實際進度的核對列(列印範圍外)。範本那一列留著編範本時的手算差值
  // (=3.57-3.56),不清掉會在核對列印出 0.01。只認純數字算式,廠商值是數字不是公式。
  const 廠商列 = r0 + 7;
  const 廠商列雜項 = [];
  for (let c = 9; c <= 末; c++) {
    const addr = x.utils.encode_cell({ r: 廠商列 - 1, c });
    const cell = ws[addr];
    if (cell && cell.f && /^[\d.\s+\-*/()]+$/.test(cell.f)) 廠商列雜項.push(addr);
  }
  return {
    合計列: r0, 末欄: x.utils.encode_col(末), 缺標籤列, 預定列空, 合計範圍不足,
    廠商標籤缺: !有值(ws[`A${廠商列}`]), 廠商列雜項,
  };
}

module.exports = {
  TEMPLATE_PATH, workbookPath, ensureWorkbook, itemRowCounts, progressBlock, PROGRESS_LABELS,
};
