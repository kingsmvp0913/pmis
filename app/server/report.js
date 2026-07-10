/**
 * report.js — 監造報表(工程會附表五)產生器
 *
 * 依行政院公共工程委員會《公共工程施工品質管理作業要點》附表五「公共工程監造報表」
 * 版面,以 exceljs 產出 .xlsx 表單。deterministic 純函式,不接 AI。
 *
 * 版面分四段(照抄附表五骨幹):
 *   1. 表頭:工程/契約/工期/金額/進度/天氣/填報日期抬頭。
 *   2. 工程細目表:項次/工程項目/單位/契約單價/契約數量/本日完成數量/
 *      本日完成金額/累計完成數量(對應施工日誌第一項,附表五註1允許參詳日誌)。
 *   3. 五大監造查核項(標題 + 空白填寫區,監造方人工填)。
 *   4. 監造單位簽章列。
 *
 * 金額:凡需重算之金額(本日完成金額 = 契約單價 × 本日完成數量)一律以
 * ROUND_HALF_UP(台灣四捨五入,非銀行家捨入)算至小數 2 位。缺欄留空,不編造。
 *
 * 匯出:
 *   buildSupervisionReport(data)          -> Promise<ExcelJS.Workbook>  單日一 sheet
 *   buildMonthlyReport({ 工程, days })    -> Promise<ExcelJS.Workbook>  多日每天一 sheet
 *   roundHalfUp(value, digits)            -> number|null   (供測試/計算)
 */
const ExcelJS = require('exceljs');

/**
 * 台灣四捨五入(half-up),支援指定小數位。以字串縮放避免 IEEE754 邊界誤差。
 * 例:roundHalfUp(2250.005, 2) === 2250.01;roundHalfUp(30.5, 0) === 31。
 * @param {number|string|null} value
 * @param {number} [digits=2] 小數位數
 * @returns {number|null} null 表示無資料(輸入為 null/NaN)
 */
function roundHalfUp(value, digits = 2) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  const factor = Math.pow(10, digits);
  const neg = n < 0;
  const abs = Math.abs(n) * factor;
  const rounded = Math.floor(abs + 0.5 + Number.EPSILON);
  const result = (neg ? -rounded : rounded) / factor;
  return result;
}

// 五大監造查核項標題(附表五原文),內容一律留空給監造方現場填。
const REVIEW_SECTIONS = [
  '一、工程進行情況（含約定之重要施工項目及數量）：',
  '二、監督依照設計圖說及核定施工圖說施工（含約定之檢驗停留點及施工抽查等情形）：',
  '三、查核材料規格及品質（含約定之檢驗停留點、材料設備管制及檢（試）驗等抽驗情形）：',
  '四、督導工地職業安全衛生事項：',
  '（一）施工廠商施工前檢查事項辦理情形：□完成　□未完成',
  '（二）其他工地安全衛生督導事項：',
  '五、其他約定監造事項（含重要事項紀錄、主辦機關指示及通知廠商辦理事項等）：',
];

// 細目表欄位標題(照施工日誌第一項工程細目 + 金額欄)。
const DETAIL_HEADERS = [
  '項次', '工程項目', '單位', '契約單價', '契約數量',
  '本日完成數量', '本日完成金額', '累計完成數量',
];

const N_COLS = 8; // 表格總欄數(A..H)

const THIN = { style: 'thin' };
const ALL_BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

// 空值顯示為空字串(缺欄留空,不編造 0)。
function cell(v) {
  return v == null ? '' : v;
}

/**
 * 在既有 worksheet 上寫入「單日監造報表」版面(附表五)。
 * 抽成共用函式:單日版(buildSupervisionReport)與多日版(buildMonthlyReport)
 * 皆呼叫本函式,避免複製整段排版邏輯。
 *
 * @param {ExcelJS.Worksheet} ws 目標工作表(呼叫端已建好、命好名)
 * @param {object} data
 * @param {object} data.工程 主檔:工程名稱/工程編號/契約工期/開工日期/契約竣工日/契約金額/決標金額/預定進度
 * @param {object} data.日報 讀取器:填報日期/天氣_上午/天氣_下午/實際進度/dailyRows[]
 * @param {object} [data.監造] 五大查核項(留空給監造方填)
 */
function writeSupervisionSheet(ws, data) {
  const 工程 = data.工程 || {};
  const 日報 = data.日報 || {};
  const rows = Array.isArray(日報.dailyRows) ? 日報.dailyRows : [];

  // 欄寬(項次窄、工程項目寬)。
  ws.columns = [
    { width: 6 },   // A 項次
    { width: 34 },  // B 工程項目
    { width: 8 },   // C 單位
    { width: 12 },  // D 契約單價
    { width: 10 },  // E 契約數量
    { width: 12 },  // F 本日完成數量
    { width: 14 },  // G 本日完成金額
    { width: 12 },  // H 累計完成數量
  ];

  let r = 1;

  // ── 標題 ──
  ws.mergeCells(r, 1, r, N_COLS);
  const title = ws.getCell(r, 1);
  title.value = '公共工程監造報表（工程會附表五）';
  title.font = { bold: true, size: 16 };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(r).height = 26;
  r++;

  // ── 表頭:天氣 / 填報日期 ──
  // 一列兩欄式(label:value),用合併儲存格排版。
  function labeledRow(pairs) {
    // pairs = [[label, value, labelSpan, valueSpan], ...] 累計欄數 = N_COLS
    let col = 1;
    for (const [label, value, lSpan = 1, vSpan = 1] of pairs) {
      const lc = ws.getCell(r, col);
      lc.value = label;
      lc.font = { bold: true };
      lc.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      if (lSpan > 1) ws.mergeCells(r, col, r, col + lSpan - 1);
      applyBorder(r, col, col + lSpan - 1);
      col += lSpan;

      const vc = ws.getCell(r, col);
      vc.value = cell(value);
      vc.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      if (vSpan > 1) ws.mergeCells(r, col, r, col + vSpan - 1);
      applyBorder(r, col, col + vSpan - 1);
      col += vSpan;
    }
    r++;
  }

  function applyBorder(row, colStart, colEnd) {
    for (let c = colStart; c <= colEnd; c++) {
      ws.getCell(row, c).border = ALL_BORDER;
    }
  }

  const 星期 = 日報.星期 ? `(${日報.星期})` : '';
  labeledRow([
    ['本日天氣　上午', cell(日報.天氣_上午), 2, 2],
    ['下午', cell(日報.天氣_下午), 1, 1],
    ['填報日期', `${cell(日報.填報日期)} ${星期}`.trim(), 1, 1],
  ]);

  // 工程名稱(整列)。
  labeledRow([['工程名稱', cell(工程.工程名稱), 1, 7]]);
  labeledRow([['工程編號', cell(工程.工程編號), 1, 7]]);

  // 工期 / 日期。
  labeledRow([
    ['契約工期(天)', cell(工程.契約工期), 2, 2],
    ['開工日期', cell(工程.開工日期), 1, 1],
    ['契約竣工日', cell(工程.契約竣工日), 1, 1],
  ]);

  // 金額 / 進度。
  labeledRow([
    ['契約金額', cell(工程.契約金額), 2, 2],
    ['決標金額', cell(工程.決標金額), 1, 1],
    ['實際完工日期', '', 1, 1],
  ]);
  labeledRow([
    ['預定進度(%)', cell(工程.預定進度), 2, 2],
    ['實際進度(%)', cell(日報.實際進度), 1, 1],
    ['契約變更次數', '', 1, 1],
  ]);

  r++; // 空一列

  // ── 中段:工程細目表 ──
  ws.mergeCells(r, 1, r, N_COLS);
  const detTitle = ws.getCell(r, 1);
  detTitle.value = '工程細目表（本日／累計完成數量　參詳施工日誌）';
  detTitle.font = { bold: true, size: 12 };
  detTitle.alignment = { horizontal: 'left', vertical: 'middle' };
  r++;

  // 細目表欄位標題列。
  const headerRow = r;
  DETAIL_HEADERS.forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    c.border = ALL_BORDER;
  });
  ws.getRow(r).height = 22;
  r++;

  // 資料列。本日完成金額若缺,以 契約單價 × 本日完成數量 用 ROUND_HALF_UP 補算。
  for (const row of rows) {
    const 契約單價 = row.契約單價;
    const 本日完成數量 = row.本日完成數量;
    let 本日完成金額 = row.本日完成金額;
    if (本日完成金額 == null && 契約單價 != null && 本日完成數量 != null) {
      本日完成金額 = roundHalfUp(Number(契約單價) * Number(本日完成數量), 2);
    }

    const values = [
      cell(row.項次),
      cell(row.工程項目),
      cell(row.單位),
      cell(契約單價),
      cell(row.契約數量),
      cell(本日完成數量),
      cell(本日完成金額),
      cell(row.累計完成數量),
    ];
    values.forEach((v, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = v;
      c.border = ALL_BORDER;
      c.alignment = {
        vertical: 'middle',
        wrapText: i === 1,                          // 工程項目自動換行
        horizontal: i >= 3 ? 'right' : (i === 1 ? 'left' : 'center'),
      };
      if (i >= 3 && typeof v === 'number') c.numFmt = '#,##0.00';
    });
    r++;
  }

  r++; // 空一列

  // ── 下段:五大監造查核項(標題 + 空白填寫區) ──
  for (const sec of REVIEW_SECTIONS) {
    // 標題列。
    ws.mergeCells(r, 1, r, N_COLS);
    const t = ws.getCell(r, 1);
    t.value = sec;
    t.font = { bold: true };
    t.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    applyBorder(r, 1, N_COLS);
    r++;
    // 空白填寫區(合併大格,留給監造方填)。
    ws.mergeCells(r, 1, r + 1, N_COLS);
    const blank = ws.getCell(r, 1);
    blank.value = '';
    blank.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
    applyBorder(r, 1, N_COLS);
    ws.getRow(r).height = 20;
    ws.getRow(r + 1).height = 20;
    r += 2;
  }

  r++; // 空一列

  // ── 監造單位簽章列 ──
  ws.mergeCells(r, 1, r, N_COLS);
  const sign = ws.getCell(r, 1);
  sign.value = '監造單位簽章：';
  sign.font = { bold: true };
  sign.alignment = { horizontal: 'left', vertical: 'middle' };
  applyBorder(r, 1, N_COLS);
  ws.getRow(r).height = 40;
}

// sheet 名安全化:Excel 禁用字元 \ / ? * [ ] :,長度上限 31。
// 用於「每天一 sheet」的分頁名(如填報日期 2026-04-08 → '04-08')。
function safeSheetName(name, fallback) {
  let s = String(name == null ? '' : name).replace(/[\\/?*[\]:]/g, '-').trim();
  if (!s) s = fallback;
  return s.slice(0, 31);
}

// 由某天結構取「MM-DD」分頁名;無填報日期則以序號 fallback。
function sheetNameForDay(day, index) {
  const 填報日期 = day && day.header && day.header.填報日期;
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(填報日期 || ''));
  const base = m ? `${m[1]}-${m[2]}` : `第${index + 1}天`;
  return base;
}

// 把讀取器某天結構(header/dailyRows)攤平成 writeSupervisionSheet 期望的 日報 形狀。
function dayToReport(day) {
  const header = (day && day.header) || {};
  return {
    填報日期: header.填報日期,
    星期: header.星期,
    天氣_上午: header.天氣_上午,
    天氣_下午: header.天氣_下午,
    實際進度: header.實際進度,
    dailyRows: (day && day.dailyRows) || [],
  };
}

/**
 * 產生監造報表 workbook(單日一 sheet)。
 * @param {object} data 見 writeSupervisionSheet
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function buildSupervisionReport(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PMIS';
  const ws = wb.addWorksheet('監造報表');
  writeSupervisionSheet(ws, data);
  return wb;
}

/**
 * 產生「多日 → 一個 workbook,每天一 sheet」的監造報表。
 * 每天沿用單日版面(writeSupervisionSheet),sheet 名以填報日期 MM-DD 命名。
 * days 為讀取器 parseAll 過濾後的多天陣列;工程主檔對每天共用。
 * 督導(單筆)也走本函式(可能只有 1 天)。
 *
 * @param {object} params
 * @param {object} params.工程 工程主檔(對每天共用)
 * @param {Array<{header, dailyRows}>} params.days 讀取器過濾後的多天陣列
 * @param {object} [params.監造] 五大查核項(留空)
 * @returns {Promise<ExcelJS.Workbook>}
 */
async function buildMonthlyReport({ 工程, days, 監造 } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PMIS';
  const list = Array.isArray(days) ? days : [];

  // 空陣列:仍給一張空 sheet,避免產出無工作表的壞 xlsx。
  if (list.length === 0) {
    const ws = wb.addWorksheet('監造報表');
    writeSupervisionSheet(ws, { 工程: 工程 || {}, 日報: {}, 監造: 監造 || {} });
    return wb;
  }

  const used = new Set();
  list.forEach((day, i) => {
    let name = safeSheetName(sheetNameForDay(day, i), `第${i + 1}天`);
    // sheet 名不可重複(同日多筆時)→ 補序號。
    let unique = name;
    let n = 2;
    while (used.has(unique)) {
      const suffix = `_${n++}`;
      unique = name.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(unique);
    const ws = wb.addWorksheet(unique);
    writeSupervisionSheet(ws, { 工程: 工程 || {}, 日報: dayToReport(day), 監造: 監造 || {} });
  });

  return wb;
}

module.exports = {
  buildSupervisionReport,
  buildMonthlyReport,
  roundHalfUp,
  REVIEW_SECTIONS,
  DETAIL_HEADERS,
};
