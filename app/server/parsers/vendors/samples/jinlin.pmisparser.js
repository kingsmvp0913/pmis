/**
 * jinlin.pmisparser.js — 晉林土木包工業(南陽國小)監造施工日報表 Excel 讀取器
 *
 * 本組樣本中「最難、最髒」的一份:監造視角、11 sheet、`so` 主表 235 欄矩陣、
 * 數個監工/施工日報 snapshot sheet 含 `#REF!`/`#VALUE!` 公式錯誤。經徹底來源分析後
 * 選定「最乾淨且可逐日展開」的來源:
 *
 * ── 資料來源選定(誠實取捨,見檔尾說明)──
 *   • 逐日資料 = `so` 矩陣(A1:IA737,3891 merges,零 error cell)。每天佔「2 列」:
 *       本日列(A 欄有日期序號)+ 累計列(A 欄空、E 欄="累計")。資料自 R8 起。
 *     — 205 個 sheet 列 = 365 個「範本預生成日」(2026-03-18 ~ 2027-03-17),但本工程僅
 *       實際填到 2026-06-30(105 天有天氣),之後為空白佔位日 → 本讀取器只回「有天氣的實日」。
 *   • 施工項目定義(項次/名稱/單位/契約單價/契約數量)= `so` 表頭列:
 *       item 欄在兩個「水平區塊」重複:
 *         Block1 = AI..BS(37 欄:AI=大項「直接工程費」表頭 + 36 細項/管理費);
 *                  R5=名稱、R2=單位、R3=契約單價、R7=契約數量;每日格 = 本日/累計「完成數量」。
 *         Block2 = EE..FO(同 37 欄,名稱與 Block1 一字不差);每日格 = 本日/累計「完成金額」。
 *       兩區塊欄序 1:1 對齊(已驗證 0 mismatch),故同一 item 的「數量」取 Block1、「金額」取 Block2。
 *   • header:工程名稱/契約金額/工期 取自 `監造表頭`(單日監造抬頭,零 error);
 *       天氣/預定進度/實際進度/星期 取自 `so` 當日列(逐日,較 snapshot 可靠)。
 *
 * ── 略過的 sheet(髒/殘留/公式錯)──
 *   • `預定進度表 `:殘留與本案無關的舊範本(「98年莫拉克颱風—中埔鄉…道路」「瑤池橋」)→ 完全不讀。
 *   • `60/100項監工日報`、`60/100項施工日報表`:單日 snapshot,且 `#REF!`/`#VALUE!` 落在
 *       預定進度(F6)、本日完成金額(J6)、直接工程費列本日金額(I9)等「金額/進度」關鍵格。
 *       SheetJS 對 error cell 會回「快取的舊數值」(如 F6=#REF! 卻回 23、J6=#VALUE! 回 15),
 *       屬不可信髒值 → 不採此來源;逐日一律走零 error 的 `so`。
 *
 * ── 介面(對齊 registry.js;檔型工具經 ctx.filetypes 注入,不自行 require)──
 *   meta       = { vendorKey:'晉林土木包工業', version, targetFields }
 *   parse(filePath, ctx)     -> Promise<第一實日結構>
 *   parseAll(filePath, ctx)  -> Promise<[每實日結構…]>
 *   parseGrid(soGrid, headGrid, ft)  純函式(供 selfTest / 測試,不碰檔案)
 *   selfTest(ft)             -> boolean(內建小樣本 grid 自檢)
 *
 * ── 統一 schema 對應誠實度(詳見檔尾)──
 *   可靠✅:工程名稱、填報日期、星期、天氣(上下午)、預定/實際進度、本日累計金額、
 *           項次、工程項目、單位、契約單價、契約數量、本日完成數量、本日完成金額、累計完成數量、出工明細。
 *   抽不到❌:出工總人數(so 分工別、無單一總數格)、主要材料(此監造版無材料表)、
 *           契約單價的「本日完成金額」在大項/直接工程費表頭列不適用(→ null)。
 */

// ── 常數:座標與欄位落點(0-based grid 索引由注入的 colToIndex 於解析時算)──

// so 矩陣:資料自 Excel R8(idx 7)起,每 2 列一天(本日 + 累計)。
const SO_DATA_START = 7; // R8 → idx 7(本日列)
// so header 列(0-based):名稱 R5(idx4)、單位 R2(idx1)、契約單價 R3(idx2)、契約數量 R7(idx6)。
const SO_NAME_ROW = 4;
const SO_UNIT_ROW = 1;
const SO_PRICE_ROW = 2;
const SO_QTY_ROW = 6;

// so item 欄區塊(字母,於解析時轉索引)。Block1=數量、Block2=金額;AI 為大項表頭(直接工程費)。
const SO_BLOCK1_START = 'AI';
const SO_BLOCK1_END = 'BS';
const SO_BLOCK2_START = 'EE';
const SO_BLOCK2_END = 'FO';
const SO_TOTAL_AMT_COL = 'IA'; // 金額合計(每日彙總)

// so 逐日欄(本日列):日期 A、星期 B、天氣上午 C、天氣下午 D、本日% H、預定% I。
const SO_DATE_COL = 'A';
const SO_WEEK_COL = 'B';
const SO_WX_AM_COL = 'C';
const SO_WX_PM_COL = 'D';
const SO_TODAY_PCT_COL = 'H';
const SO_PLAN_PCT_COL = 'I';
// 出工(本日列)工別欄 J..O 與名稱。
const SO_WORKER_COLS = [
  ['J', '拆除技術工'], ['K', '泥作技術工'], ['L', '水電技術工'],
  ['M', '裝潢技術工'], ['N', '油漆技術工'], ['O', '一般工'],
];

// 星期 code(so B 欄):1=日 … 7=六(已對 2026-03-18=週三→code4、03-19=週四→code5 驗證)。
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六']; // index = code-1

// 監造表頭 sheet(單日抬頭)座標(0-based):工程名稱 R4-A(前綴「工程名稱:」)、契約金額 R7-H。
const HEAD_SHEET = '監造表頭';
const SO_SHEET = 'so';

// ── 值正規化 helpers ──

// 無資料標記 → null(數量/金額語意:無資料,非 0)。含 error 字串防護。
function isDash(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '' || s === '-' || s === '–' || s === '—' || s === '－';
}

// error cell 字串(SheetJS 對 error 多半回快取數值,但保險起見字串也擋)。
function isErrorToken(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return s === '#REF!' || s === '#VALUE!' || s === '#DIV/0!' || s === '#N/A' ||
    s === '#NAME?' || s === '#NULL!' || s === '#NUM!' || /^\$?a{2,}$/i.test(s);
}

// 值 → number 或 null(容忍 '1,234'、空白、'-'、error 字串)。
function toNum(v) {
  if (isDash(v) || isErrorToken(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 值 → 去頭尾空白字串或 null(error/dash → null)。
function toStr(v) {
  if (isDash(v) || isErrorToken(v)) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Excel 序號 → 'YYYY-MM-DD';字串日期交雙制辨識。
function toDateISO(v, excelSerialToISO) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return excelSerialToISO(v);
  return normalizeDateString(String(v));
}

// 民國/西元雙制 → 'YYYY-MM-DD'。
function normalizeDateString(s) {
  const t = String(s).trim();
  let m = t.match(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    let y = Number(m[1]);
    if (y < 1911) y += 1911;
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  m = t.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const yy = 2000 + Number(m[3]);
    return `${yy}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  return null;
}

// so B 欄星期 code(1..7)→ 「日..六」;無效回 null。
function weekName(code) {
  const n = toNum(code);
  if (n == null || !Number.isInteger(n) || n < 1 || n > 7) return null;
  return WEEK_NAMES[n - 1];
}

function cell(grid, rIdx, cIdx) {
  const row = grid[rIdx];
  if (!row) return null;
  const v = row[cIdx];
  return v === undefined ? null : v;
}

/**
 * 由 so 表頭列建「施工項目定義」清單(項次/名稱/單位/契約單價/契約數量 + block1/block2 欄索引)。
 * 項次:AI=大項「直接工程費」表頭(項次 '壹');其後細項依序 1..N(對齊 預算詳細表 標單順序)。
 */
function buildItemDefs(soGrid, ft) {
  const { colToIndex } = ft;
  const b1s = colToIndex(SO_BLOCK1_START);
  const b1e = colToIndex(SO_BLOCK1_END);
  const b2s = colToIndex(SO_BLOCK2_START);
  const names = soGrid[SO_NAME_ROW] || [];
  const units = soGrid[SO_UNIT_ROW] || [];
  const prices = soGrid[SO_PRICE_ROW] || [];
  const qtys = soGrid[SO_QTY_ROW] || [];

  const defs = [];
  let seq = 0;
  for (let c = b1s; c <= b1e; c++) {
    const nm = toStr(names[c]);
    if (nm == null) continue; // 空/0 佔位欄(區塊尾端)
    const isHeader = c === b1s; // AI = 大項表頭「直接工程費」
    const b2c = b2s + (c - b1s); // block2 對應欄(1:1 平移)
    defs.push({
      項次: isHeader ? '壹' : String(++seq),
      工程項目: nm,
      單位: isHeader ? null : toStr(units[c]),
      契約單價: isHeader ? null : toNum(prices[c]),
      契約數量: isHeader ? null : toNum(qtys[c]),
      _qtyCol: c,     // block1:本日/累計 完成數量
      _amtCol: b2c,   // block2:本日/累計 完成金額
      _isHeader: isHeader,
    });
  }
  return defs;
}

/**
 * 解析監造表頭 sheet → { 工程名稱, 契約金額 }(單日抬頭,零 error)。headGrid 可為 null。
 */
function parseHeadSheet(headGrid) {
  if (!headGrid) return { 工程名稱: null, 契約金額: null };
  // 工程名稱在 R4 A 欄,前綴「工程名稱:」。
  let 工程名稱 = null;
  const a4 = toStr(cell(headGrid, 3, 0));
  if (a4) 工程名稱 = a4.replace(/^工程名稱\s*[:：]\s*/, '') || null;
  // 契約金額 R7 H 欄(idx6,7)。
  const 契約金額 = toNum(cell(headGrid, 6, 7));
  return { 工程名稱, 契約金額 };
}

/**
 * 解析「單一天」→ { header, dailyRows, extras }。
 * @param {Array<Array<any>>} soGrid   so 矩陣 grid
 * @param {number} todayR              本日列 idx(累計列 = todayR+1)
 * @param {Array} itemDefs             buildItemDefs 結果
 * @param {object} headInfo            parseHeadSheet 結果(工程名稱/契約金額)
 * @param {object} ft                  注入檔型工具
 */
function parseDay(soGrid, todayR, itemDefs, headInfo, ft) {
  const { colToIndex, excelSerialToISO } = ft;
  const cumR = todayR + 1;
  const dateCol = colToIndex(SO_DATE_COL);
  const totalAmtCol = colToIndex(SO_TOTAL_AMT_COL);

  const 填報日期 = toDateISO(cell(soGrid, todayR, dateCol), excelSerialToISO);

  const header = {
    工程名稱: headInfo.工程名稱,
    填報日期,
    星期: weekName(cell(soGrid, todayR, colToIndex(SO_WEEK_COL))),
    天氣_上午: toStr(cell(soGrid, todayR, colToIndex(SO_WX_AM_COL))),
    天氣_下午: toStr(cell(soGrid, todayR, colToIndex(SO_WX_PM_COL))),
    預定進度: toNum(cell(soGrid, todayR, colToIndex(SO_PLAN_PCT_COL))),
    實際進度: toNum(cell(soGrid, todayR, colToIndex(SO_TODAY_PCT_COL))),
    出工總人數: null, // so 出工分工別、無單一總數格 → null(不加總編造)
    本日累計金額: toNum(cell(soGrid, cumR, totalAmtCol)), // 金額合計(IA)累計列
  };

  const dailyRows = itemDefs.map((d) => ({
    項次: d.項次,
    工程項目: d.工程項目,
    單位: d.單位,
    契約單價: d.契約單價,
    契約數量: d.契約數量,
    本日完成數量: d._isHeader ? null : toNum(cell(soGrid, todayR, d._qtyCol)),
    本日完成金額: d._isHeader ? null : toNum(cell(soGrid, todayR, d._amtCol)),
    累計完成數量: d._isHeader ? null : toNum(cell(soGrid, cumR, d._qtyCol)),
  }));

  // extras:出工明細(本日列工別人數,>0 才收)。
  const extras = {};
  const 出工明細 = [];
  for (const [colLetter, 工別] of SO_WORKER_COLS) {
    const 人數 = toNum(cell(soGrid, todayR, colToIndex(colLetter)));
    if (人數 != null && 人數 > 0) 出工明細.push({ 工別, 人數 });
  }
  if (出工明細.length) extras.出工明細 = 出工明細;

  return { header, dailyRows, extras };
}

// 找出所有「實日」本日列 idx(A 欄為日期序號、且當日有天氣 → 排除範本預生成空白日)。
function realDayRows(soGrid, ft) {
  const { colToIndex } = ft;
  const dateCol = colToIndex(SO_DATE_COL);
  const wxCol = colToIndex(SO_WX_AM_COL);
  const rows = [];
  for (let r = SO_DATA_START; r < soGrid.length; r += 2) {
    const a = cell(soGrid, r, dateCol);
    if (typeof a !== 'number' || a < 40000) continue; // 非日期列
    const wx = toStr(cell(soGrid, r, wxCol));
    if (wx == null) continue; // 空白佔位日(天氣空)→ 略過
    rows.push(r);
  }
  return rows;
}

/**
 * parseGrid — 由 so grid + 監造表頭 grid 解析出「每實日」結構陣列(純函式,供測試/selfTest)。
 */
function parseGrid(soGrid, headGrid, ft) {
  const itemDefs = buildItemDefs(soGrid, ft);
  const headInfo = parseHeadSheet(headGrid);
  const dayRows = realDayRows(soGrid, ft);
  return dayRows.map((r) => parseDay(soGrid, r, itemDefs, headInfo, ft));
}

async function parseAll(filePath, ctx) {
  const ft = ctx.filetypes;
  const wb = ft.readWorkbook(filePath);
  const soGrid = wb.sheets[SO_SHEET];
  const headGrid = wb.sheets[HEAD_SHEET] || null;
  if (!soGrid) return [];
  return parseGrid(soGrid, headGrid, ft);
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all.length ? all[0] : { header: {}, dailyRows: [], extras: {} };
}

// selfTest:內建小樣本 so grid + 監造表頭 grid,驗證矩陣展開/區塊對齊/星期/error→null。
function selfTest(ft) {
  try {
    const { gridFromWorksheet, colToIndex } = ft;

    // ── 建 so worksheet 小樣本 ──
    const so = {};
    const setS = (addr, v) => { so[addr] = { v, t: typeof v === 'number' ? 'n' : 's' }; };
    // 表頭:名稱 R5 / 單位 R2 / 契約單價 R3 / 契約數量 R7。Block1 AI..AK,Block2 EE..EG。
    setS('AI5', '直接工程費'); setS('AJ5', '乙種施工圍籬'); setS('AK5', '牆面貼石英磚');
    setS('AJ2', '式'); setS('AK2', 'M2');
    setS('AJ3', 5000); setS('AK3', 1700);
    setS('AJ7', 1); setS('AK7', 210);
    setS('EE5', '直接工程費'); setS('EF5', '乙種施工圍籬'); setS('EG5', '牆面貼石英磚');
    setS('IA5', '金額合計');
    // day1 本日列 R8:日期 46099(2026-03-18)、星期4、天氣、%、出工、item 數量/金額。
    setS('A8', 46099); setS('B8', 4); setS('C8', '晴'); setS('D8', '陰');
    setS('H8', 0.73); setS('I8', 0.75); setS('O8', 2);
    setS('AJ8', 1); setS('AK8', 25);            // block1 本日數量
    setS('EF8', 5000); setS('EG8', 42500);      // block2 本日金額
    setS('IA8', 47500);
    // day1 累計列 R9。
    setS('E9', '累計'); setS('AJ9', 1); setS('AK9', 25); setS('IA9', 47500);
    // day2 本日列 R10:日期 46100、星期5。
    setS('A10', 46100); setS('B10', 5); setS('C10', '晴'); setS('D10', '晴');
    setS('H10', 1.0); setS('I10', 1.5); setS('AK10', 10);
    setS('EG10', 17000); setS('IA10', 17000);
    setS('E11', '累計'); setS('AK11', 35); setS('IA11', 64500);
    // day3 佔位空白日(無天氣)→ 應被排除。
    setS('A12', 46101); setS('B12', 6); setS('E12', '本日');
    setS('E13', '累計');
    so['!ref'] = 'A1:IA13';
    so['!merges'] = [];

    // ── 建 監造表頭 worksheet 小樣本 ──
    const head = {};
    const setH = (addr, v) => { head[addr] = { v, t: typeof v === 'number' ? 'n' : 's' }; };
    setH('A4', '工程名稱:114年南陽國小北棟教室廁所整修工程');
    setH('H7', 3122168);
    head['!ref'] = 'A1:M8';

    const soGrid = gridFromWorksheet(so);
    const headGrid = gridFromWorksheet(head);
    const days = parseGrid(soGrid, headGrid, ft);

    // 只 2 實日(第 3 天無天氣被排除)。
    if (days.length !== 2) return false;

    const d1 = days[0];
    if (d1.header.工程名稱 !== '114年南陽國小北棟教室廁所整修工程') return false;
    if (d1.header.填報日期 !== '2026-03-18') return false;
    if (d1.header.星期 !== '三') return false; // code4 → 三(週三)
    if (d1.header.天氣_上午 !== '晴' || d1.header.天氣_下午 !== '陰') return false;
    if (d1.header.預定進度 !== 0.75 || d1.header.實際進度 !== 0.73) return false;
    if (d1.header.本日累計金額 !== 47500) return false;
    if (d1.header.出工總人數 !== null) return false;

    // 大項表頭列:項次 壹、各數值欄 null。
    const h = d1.dailyRows.find((x) => x.項次 === '壹');
    if (!h || h.工程項目 !== '直接工程費' || h.契約單價 !== null || h.本日完成金額 !== null) return false;

    // 細項 1 = 圍籬:單位式、契約單價5000、契約數量1、本日數量1、本日金額5000。
    const r1 = d1.dailyRows.find((x) => x.項次 === '1');
    if (!r1 || r1.工程項目 !== '乙種施工圍籬' || r1.單位 !== '式') return false;
    if (r1.契約單價 !== 5000 || r1.契約數量 !== 1) return false;
    if (r1.本日完成數量 !== 1 || r1.本日完成金額 !== 5000) return false;

    // 細項 2 = 牆面貼石英磚:本日數量25、金額42500、累計數量25(block1/block2 對齊)。
    const r2 = d1.dailyRows.find((x) => x.項次 === '2');
    if (!r2 || r2.單位 !== 'M2' || r2.契約單價 !== 1700 || r2.契約數量 !== 210) return false;
    if (r2.本日完成數量 !== 25 || r2.本日完成金額 !== 42500 || r2.累計完成數量 !== 25) return false;

    // 出工:一般工 2。
    if (!d1.extras.出工明細 || d1.extras.出工明細[0].工別 !== '一般工' || d1.extras.出工明細[0].人數 !== 2) return false;

    // day2:累計數量 35(累計列)、累計金額 64500、星期五。
    const d2 = days[1];
    if (d2.header.填報日期 !== '2026-03-19' || d2.header.星期 !== '四') return false;
    const d2r2 = d2.dailyRows.find((x) => x.項次 === '2');
    if (!d2r2 || d2r2.本日完成數量 !== 10 || d2r2.累計完成數量 !== 35) return false;
    if (d2.header.本日累計金額 !== 64500) return false;

    // error token → null 防護。
    if (toNum('#REF!') !== null || toNum('#VALUE!') !== null) return false;
    if (toNum('-') !== null || toStr('') !== null) return false;

    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  meta: {
    vendorKey: '晉林土木包工業',
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '本日累計金額', '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  parseGrid,
  selfTest,
};
