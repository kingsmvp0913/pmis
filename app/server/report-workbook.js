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
 */
const fs = require('fs');
const path = require('path');

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

module.exports = { TEMPLATE_PATH, workbookPath, ensureWorkbook };
