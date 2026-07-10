/**
 * filetypes/xlsx.js — 共用 Excel(xls/xlsx)檔型讀取器
 *
 * 各廠商 Excel 施工日誌讀取器共用此工具:以 `xlsx` 套件(SheetJS)把活頁簿
 * 讀成「每 sheet 一個 cell 矩陣(2D 陣列)」,供下游依固定 row/col 座標取值。
 *
 * ── 合併儲存格處理(關鍵)──
 *   Excel 施工日誌大量使用合併儲存格(摯東每 sheet 280 個 merges),SheetJS 只在
 *   合併區「起點 cell」存值,其餘覆蓋格為 undefined。本讀取器讀 `sheet['!merges']`,
 *   把每個合併區的**起點值填滿整個合併區的所有覆蓋格**;因此下游用合併區內「任一欄」
 *   索引(不必知道起點欄)都能取到同一個值。此即「取得合併起點值」的作法。
 *   (另一路線是 sheet_to_json 的 header 模式,但那不易處理橫向合併攤開的欄位落點,
 *    故本檔採 merges 填充 + 定址矩陣。)
 *
 * ── 座標系 ──
 *   回傳的 grid 為 0-based:grid[r][c],r/c 皆 0-based。對應 Excel「1-based 列 + 欄字母」時
 *   R(1-based)=r+1、欄字母以 colToIndex/indexToCol 轉換。日期以 Excel 序號(number)原樣回傳,
 *   由廠商 reader 自行以 excelSerialToISO 轉西元(SheetJS 對 .xls 1900 曆制)。
 *
 * Exports:
 *   readWorkbook(filePath)          -> { sheetNames:[…], sheets:{ name: grid(2D陣列) } }
 *   readSheet(filePath, sheetName)  -> grid(2D 陣列) 或 null
 *   gridFromWorksheet(ws)           -> 由單一 worksheet 物件建 grid(純函式,供 selfTest 用)
 *   colToIndex('AA') -> 26 ;indexToCol(26) -> 'AA'
 *   excelSerialToISO(46174)         -> '2026-06-01'(Excel 1900 序號 → 西元 YYYY-MM-DD)
 */
const fs = require('fs');
const XLSX = require('xlsx');

// 欄字母 → 0-based 索引('A'->0,'Z'->25,'AA'->26)。
function colToIndex(col) {
  let n = 0;
  const s = String(col).toUpperCase();
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n - 1;
}

// 0-based 索引 → 欄字母(0->'A',26->'AA')。
function indexToCol(idx) {
  let n = idx + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Excel 序號日期 → 'YYYY-MM-DD'。用 SheetJS 的 SSF(內建 1900/1904 曆制處理)。
function excelSerialToISO(serial) {
  if (serial == null || serial === '') return null;
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  const d = XLSX.SSF.parse_date_code(n);
  if (!d) return null;
  const mm = String(d.m).padStart(2, '0');
  const dd = String(d.d).padStart(2, '0');
  return `${d.y}-${mm}-${dd}`;
}

/**
 * 由 SheetJS worksheet 物件建 grid(2D 陣列),並把合併區起點值填滿整個合併區。
 * 空 cell 為 null。純函式,不碰檔案系統。
 *
 * @param {object} ws SheetJS worksheet(含 '!ref' 與可選 '!merges')
 * @returns {Array<Array<any>>} grid[r][c]
 */
function gridFromWorksheet(ws) {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const nRows = range.e.r - range.s.r + 1;
  const nCols = range.e.c - range.s.c + 1;

  // 先建純值矩陣(以 0-based 由 range.s 起算)。
  const grid = [];
  for (let r = 0; r < nRows; r++) {
    const row = new Array(nCols).fill(null);
    for (let c = 0; c < nCols; c++) {
      const addr = XLSX.utils.encode_cell({ r: r + range.s.r, c: c + range.s.c });
      const cell = ws[addr];
      row[c] = cell && cell.v !== undefined ? cell.v : null;
    }
    grid.push(row);
  }

  // 合併區:起點值填滿整個合併區的所有覆蓋格。
  const merges = ws['!merges'] || [];
  for (const m of merges) {
    const sr = m.s.r - range.s.r;
    const sc = m.s.c - range.s.c;
    if (sr < 0 || sc < 0 || sr >= nRows || sc >= nCols) continue;
    const startVal = grid[sr][sc];
    if (startVal == null) continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        const rr = r - range.s.r;
        const cc = c - range.s.c;
        if (rr < 0 || cc < 0 || rr >= nRows || cc >= nCols) continue;
        if (grid[rr][cc] == null) grid[rr][cc] = startVal;
      }
    }
  }
  return grid;
}

/**
 * 讀整份活頁簿 → { sheetNames, sheets:{name: grid} }。
 * @param {string} filePath xls/xlsx 路徑
 */
function readWorkbook(filePath) {
  const buffer = fs.readFileSync(filePath);
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheets = {};
  for (const name of wb.SheetNames) {
    sheets[name] = gridFromWorksheet(wb.Sheets[name]);
  }
  return { sheetNames: wb.SheetNames.slice(), sheets };
}

/**
 * 只讀單一 sheet 的 grid;不存在回 null。
 * @param {string} filePath
 * @param {string} sheetName
 */
function readSheet(filePath, sheetName) {
  const buffer = fs.readFileSync(filePath);
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  return gridFromWorksheet(ws);
}

module.exports = {
  readWorkbook,
  readSheet,
  gridFromWorksheet,
  colToIndex,
  indexToCol,
  excelSerialToISO,
};
