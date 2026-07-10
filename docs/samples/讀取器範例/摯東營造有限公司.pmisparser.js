/**
 * zhidong.pmisparser.js — 摯東營造(大勇國小)施工日誌 Excel 讀取器【原始碼範例】
 *
 * 這支是第二支「範例讀取器」的原始碼(第一支為 jinda PDF),放 repo 供版控 / 測試 /
 * 當日後 skill 產其他 Excel 廠商讀取器的樣板。正式安裝的讀取器落在
 * data/vendor-parsers/,由 registry 動態載入;此檔不被 registry 掃到,靠其
 * targetFields/介面示範樣板。
 *
 * 來源:摯東「115.06 大勇國小」施工日誌 .xls(884 KB)。
 *   32 sheet = `簽章表`(技術士簽章,略過)+ `(1)…(31)`(每天一個 sheet)。
 *   每個日 sheet 是「施工日誌＋估驗」整合單頁,座標固定(範圍 A1:AD70,約 280 merges)。
 *
 * ── 介面(對齊 registry.js 檔頭定義)──
 *   meta       = { vendorKey:'摯東營造有限公司', version, targetFields }
 *   parse(filePath, ctx)     -> Promise<單一天(第一個 (n) sheet)結構>
 *   parseAll(filePath, ctx)  -> Promise<[每天結構…]>(依 (1)…(31) 順序)
 *   selfTest(ft)             -> boolean  (以內建小樣本 grid 驗證取值/轉換邏輯,不依賴檔案)
 *
 * ── 檔型工具「注入」──
 *   讀取器不自己 require 檔型檔或摸路徑;由 registry 於 parse/parseAll 時注入
 *   ctx.filetypes(= app/server/parsers/filetypes 的 exports),Excel 相關工具
 *   (readWorkbook / gridFromWorksheet / colToIndex / excelSerialToISO)一律經
 *   ctx.filetypes 取用。selfTest 因需以檔型工具建 grid,由 registry 於驗證時
 *   把同一份 filetypes 當參數傳入(ft)。
 *
 * ── 版面座標(每個日 sheet;R 為 1-based Excel 列,欄為字母)──
 *   header:
 *     報表編號  C1
 *     天氣_上午 E2  / 天氣_下午 I2  / 填報日期 R2(Excel 序號)
 *     工程名稱  C3  / 承攬廠商   Q3
 *     核定工期  C4  / 累計工期   H4 / 剩餘工期 N4 / 工期展延 Q4(常空)
 *     開工日期  F6(序號) / 完工日期 Q6(序號)
 *     預定進度  F7(小數,×100=%) / 實際進度 Q7(小數)
 *   估驗表(施工項目):
 *     表頭在 R9;資料列 R11 起,至 A 欄出現「營造業專業工程特定施工項目」為止(該樣本 R11–R43)。
 *     項次 A(數字 1..N 之細項,或中文大寫 壹貳參肆伍陸 之大項/管理費列)
 *     工程項目 B(合併 B:I)  單位 J  契約數量 K(合併 K:M)  本日完成數量 N(合併 N:P)
 *     累計完成數量 Q(合併 Q:S)  備註 T(合併 T:V)  數量檢核 X(=契約−累計,略)
 *     契約單價 Y  複價 Z(=契約金額)  累計完成複價 AA  前月完成數量 AB
 *
 * ── 對應到統一 schema 的取捨(遵守「找不到就 null,不編造」護欄)──
 *   - 本日完成金額:摯東估驗表**無此欄**(只有 單價 Y、複價 Z、累計完成複價 AA)→ 一律 null。
 *   - 本日累計金額(header):摯東無單一「當日累計金額」總格(AC43=6,319,000 是契約總價,
 *     非累計完成),為免用類別列 sum 造成重複計算/編造 → null。
 *   - 星期:摯東 sheet 無星期欄 → null。
 *   - 「-」/空白/undefined(含合併空格)→ null(數量/金額語意:無資料,非 0)。
 *
 * ── 合併儲存格 ──
 *   由 filetypes/xlsx.js 將每個合併區「起點值填滿整個合併區」,故本檔用合併區內任一欄
 *   索引都能取到同一值(此處固定用起點欄字母:契約數量→K、本日完成→N…)。
 */
// 中文大寫項次(大項/管理費/稅列)。
const CJK_ITEM_IDS = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾'];

// 估驗表結束錨(A 欄出現此字串即停)。
const ITEM_END_ANCHOR = '營造業專業工程特定施工項目';

// 各欄字母 → 0-based 索引;以注入的 ft.colToIndex 於解析時算一次(不 require 檔型檔)。
function buildCols(colToIndex) {
  return {
    報表編號: colToIndex('C'), // C1
    天氣上午: colToIndex('E'), // E2
    天氣下午: colToIndex('I'), // I2
    填報日期: colToIndex('R'), // R2
    工程名稱: colToIndex('C'), // C3
    承攬廠商: colToIndex('Q'), // Q3
    核定工期: colToIndex('C'), // C4
    累計工期: colToIndex('H'), // H4
    剩餘工期: colToIndex('N'), // N4
    開工日期: colToIndex('F'), // F6
    完工日期: colToIndex('Q'), // Q6
    預定進度: colToIndex('F'), // F7
    實際進度: colToIndex('Q'), // Q7
    項次: colToIndex('A'),
    工程項目: colToIndex('B'),
    單位: colToIndex('J'),
    契約數量: colToIndex('K'),
    本日完成數量: colToIndex('N'),
    累計完成數量: colToIndex('Q'),
    備註: colToIndex('T'),
    契約單價: colToIndex('Y'),
  };
}

// 資料列在 grid 的固定列索引(0-based)。表頭在 R9;資料自 R10(大項「壹」)起→idx 9。
const DATA_START_IDX = 9; // R10(含大項「壹 直接工程費」)

function cell(grid, rIdx, cIdx) {
  const row = grid[rIdx];
  if (!row) return null;
  const v = row[cIdx];
  return v === undefined ? null : v;
}

// 無資料標記(『-』全形/半形、空白字串)→ null。
function isDash(v) {
  if (v == null) return true;
  const s = String(v).trim();
  return s === '' || s === '-' || s === '–' || s === '—' || s === '－';
}

// 值 → number 或 null(容忍 '1,234'、'  '、'-')。
function toNum(v) {
  if (isDash(v)) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 值 → 去頭尾空白字串或 null。
function toStr(v) {
  if (isDash(v)) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// 進度小數(0.477)→ 保留原數值(下游決定是否 ×100 顯示 %);非數字回 null。
function toPct(v) {
  return toNum(v);
}

// 填報/開完工日期:Excel 序號(number)→ 'YYYY-MM-DD';已是字串日期則盡量解析。
// excelSerialToISO 由注入的 ft 提供(不 require 檔型檔)。
function toDateISO(v, excelSerialToISO) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return excelSerialToISO(v);
  // 少數情況值為字串(民國/西元),交由雙制辨識。
  return normalizeDateString(String(v));
}

// 日期字串雙制辨識(民國 115 年 → +1911;西元 2026/6/1、6/1/26 等)→ 'YYYY-MM-DD'。
function normalizeDateString(s) {
  const t = String(s).trim();
  // 民國/西元「YYYY 年 M 月 D 日」
  let m = t.match(/(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    let y = Number(m[1]);
    if (y < 1911) y += 1911; // 民國
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  // 西元 YYYY/M/D 或 YYYY-M-D
  m = t.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
  }
  // M/D/YY(兩位年)
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2})$/);
  if (m) {
    const yy = 2000 + Number(m[3]);
    return `${yy}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  return null;
}

// 項次判定:數字(細項)或中文大寫(大項/管理費)。
function isItemId(v) {
  if (v == null) return false;
  if (typeof v === 'number') return Number.isInteger(v) && v > 0;
  const s = String(v).trim();
  if (CJK_ITEM_IDS.includes(s)) return true;
  return /^\d{1,3}$/.test(s);
}

/**
 * 解析單一日 sheet 的 grid → { header, dailyRows, extras }。
 * 純函式,不碰檔案;selfTest 重用之。
 *
 * @param {Array<Array<any>>} grid 由 ft.gridFromWorksheet 產出(合併已填滿)
 * @param {object} ft   注入的檔型工具(需 colToIndex / excelSerialToISO)
 */
function parseGrid(grid, ft) {
  const { colToIndex, excelSerialToISO } = ft;
  const COL = buildCols(colToIndex);
  // ── header(固定座標)──
  const 填報日期 = toDateISO(cell(grid, 1, COL.填報日期), excelSerialToISO);      // R2
  const 工程名稱 = toStr(cell(grid, 2, COL.工程名稱));          // C3

  const header = {
    工程名稱,
    填報日期,
    星期: null,                                               // 摯東 sheet 無星期欄
    天氣_上午: toStr(cell(grid, 1, COL.天氣上午)),             // E2
    天氣_下午: toStr(cell(grid, 1, COL.天氣下午)),             // I2
    預定進度: toPct(cell(grid, 6, COL.預定進度)),              // F7
    實際進度: toPct(cell(grid, 6, COL.實際進度)),              // Q7
    出工總人數: null,                                          // 摯東出工分工別列(extras),無單一總數欄
    本日累計金額: null,                                        // 無單一「當日累計金額」總格(見檔頭)
  };

  // ── dailyRows:R11 起,遇 A 欄結束錨或連續空白項次即停 ──
  const rows = [];
  for (let r = DATA_START_IDX; r < grid.length; r++) {
    const rawId = cell(grid, r, COL.項次);
    // 結束錨:A 欄出現「營造業專業工程特定施工項目」或後段標題(一/二/三…段落)。
    const idStr = rawId == null ? '' : String(rawId).trim();
    if (idStr === ITEM_END_ANCHOR || idStr.startsWith('營造業專業')) break;

    if (!isItemId(rawId)) {
      // 非項次列:若前面已收過列且此列 A 欄非空(段落標題如「二、」),視為表尾 → 停。
      if (rows.length && idStr !== '') break;
      continue; // 尚未進資料區的雜訊列,略過
    }

    const 工程項目 = toStr(cell(grid, r, COL.工程項目));
    const 單位 = toStr(cell(grid, r, COL.單位));

    rows.push({
      項次: typeof rawId === 'number' ? String(rawId) : idStr,
      工程項目,
      單位,
      契約單價: toNum(cell(grid, r, COL.契約單價)),
      契約數量: toNum(cell(grid, r, COL.契約數量)),
      本日完成數量: toNum(cell(grid, r, COL.本日完成數量)),
      本日完成金額: null,                                       // 摯東估驗表無此欄
      累計完成數量: toNum(cell(grid, r, COL.累計完成數量)),
    });
  }

  // ── extras:出工明細(R54 起,工別/本日人數)、機具(同列右半)、材料 ──
  const extras = {};
  const 出工明細 = [];
  const 主要機具 = [];
  // 出工表頭 R53(idx 52):工別 A、本日人數 E;機具名稱 L、本日使用數量 O。資料 R54(idx 53)起。
  const 工別Col = colToIndex('A');
  const 本日人數Col = colToIndex('E');
  const 機具名稱Col = colToIndex('L');
  const 機具本日Col = colToIndex('O');
  for (let r = 53; r < grid.length; r++) {
    const 工別 = toStr(cell(grid, r, 工別Col));
    // 出工區止於 A 欄再度出現段落標題(如「四、」)或空白數列。
    if (工別 && /^[一二三四五六七八九十]、/.test(工別)) break;
    if (工別 && !/、/.test(工別)) {
      const 人數 = toNum(cell(grid, r, 本日人數Col));
      if (人數 != null) 出工明細.push({ 工別, 人數 });
    }
    const 機具名 = toStr(cell(grid, r, 機具名稱Col));
    if (機具名) 主要機具.push({ 名稱: 機具名, 數量: toNum(cell(grid, r, 機具本日Col)) });
  }
  if (出工明細.length) extras.出工明細 = 出工明細;
  if (主要機具.length) extras.主要機具 = 主要機具;

  return { header, dailyRows: rows, extras };
}

// 由檔案取「每天 sheet 名」:僅 `(數字)` 形式,依數字排序;排除 `簽章表`。
function daySheetNames(sheetNames) {
  return sheetNames
    .filter((n) => /^\(\d+\)$/.test(n))
    .sort((a, b) => Number(a.replace(/[()]/g, '')) - Number(b.replace(/[()]/g, '')));
}

/**
 * parse(filePath, ctx) — 回該檔第一天(第一個 (n) sheet)結構。
 * @param {object} ctx registry 注入;ctx.filetypes 提供 readWorkbook / colToIndex / excelSerialToISO。
 */
async function parse(filePath, ctx) {
  const ft = ctx.filetypes;
  const wb = ft.readWorkbook(filePath);
  const days = daySheetNames(wb.sheetNames);
  if (!days.length) return { header: {}, dailyRows: [], extras: {} };
  return parseGrid(wb.sheets[days[0]], ft);
}

/**
 * parseAll(filePath, ctx) — 依 (1)…(31) 逐日解析,回每天結構陣列。
 */
async function parseAll(filePath, ctx) {
  const ft = ctx.filetypes;
  const wb = ft.readWorkbook(filePath);
  const days = daySheetNames(wb.sheetNames);
  return days.map((n) => parseGrid(wb.sheets[n], ft));
}

// selfTest(ft):以內建小樣本 grid 驗證取值/日期轉換/『-』→null(不依賴檔案,安裝時可執行)。
// 用真的 SheetJS worksheet(含 !merges)經 ft.gridFromWorksheet 建 grid,確保合併填充邏輯也一起驗。
// ft 由 registry 於驗證時注入(= filetypes 的 exports);Excel 讀取器 selfTest 需檔型工具建 grid。
function selfTest(ft) {
  try {
    const XLSX = require('xlsx');
    const { gridFromWorksheet } = ft;
    const ws = {};
    const set = (addr, v) => { ws[addr] = { v, t: typeof v === 'number' ? 'n' : 's' }; };
    // header
    set('C1', 11561);
    set('E2', '晴'); set('I2', '陰'); set('R2', 46174); // 2026-06-01
    set('C3', '測試工程'); set('Q3', '摯東營造有限公司');
    set('C4', 202); set('H4', 127); set('N4', 75);
    set('F6', 46048); set('Q6', 46249);
    set('F7', 0.477); set('Q7', 0.4771);
    // header row R9
    set('A9', '施工項目'); set('J9', '單位'); set('K9', '契約數量');
    set('N9', '本日完成數量'); set('Q9', '累計完成數量'); set('Y9', '單價');
    // data rows
    set('A10', '壹'); set('B10', '直接工程費');                    // 大項,無單位/數字
    set('A11', 1); set('B11', '工程告示牌'); set('J11', '式');
    set('K11', 1); set('Y11', 14381);                              // 本日完成 N 空 → null
    set('A12', 12); set('B12', '牆面貼石英磚'); set('J12', 'M2');
    set('K12', 599); set('N12', 5); set('Q12', 75); set('Y12', 1378);
    set('A13', '陸'); set('B13', '營業稅'); set('J13', '式'); set('K13', 1); set('Q13', 0.37);
    set('A14', '營造業專業工程特定施工項目');                       // 結束錨
    // 出工/機具
    set('A53', '工別'); set('E53', '本日人數'); set('L53', '機具名稱'); set('O53', '本日使用數量');
    set('A54', '大工'); set('E54', 4); set('L54', '挖土機');
    set('A57', '四、');
    ws['!ref'] = 'A1:AD70';
    ws['!merges'] = [
      XLSX.utils.decode_range('K11:M11'),
      XLSX.utils.decode_range('K12:M12'),
      XLSX.utils.decode_range('N12:P12'),
      XLSX.utils.decode_range('Q12:S12'),
      XLSX.utils.decode_range('B11:I11'),
      XLSX.utils.decode_range('B12:I12'),
    ];
    const grid = gridFromWorksheet(ws);
    const out = parseGrid(grid, ft);

    if (out.header.填報日期 !== '2026-06-01') return false;
    if (out.header.工程名稱 !== '測試工程') return false;
    if (out.header.天氣_上午 !== '晴' || out.header.天氣_下午 !== '陰') return false;
    if (out.header.預定進度 !== 0.477) return false;
    if (out.header.本日累計金額 !== null) return false;
    if (out.header.星期 !== null) return false;

    const r壹 = out.dailyRows.find((x) => x.項次 === '壹');
    if (!r壹 || r壹.工程項目 !== '直接工程費' || r壹.本日完成金額 !== null) return false;

    const r1 = out.dailyRows.find((x) => x.項次 === '1');
    if (!r1 || r1.單位 !== '式' || r1.契約單價 !== 14381) return false;
    // 本日完成 N 空 → null(語意:無資料)
    if (r1.本日完成數量 !== null) return false;
    if (r1.本日完成金額 !== null) return false;

    const r12 = out.dailyRows.find((x) => x.項次 === '12');
    if (!r12 || r12.單位 !== 'M2') return false;
    if (r12.契約數量 !== 599 || r12.本日完成數量 !== 5 || r12.累計完成數量 !== 75) return false;
    if (r12.契約單價 !== 1378) return false;

    // 結束錨後不應再有列(A14 之後停)
    if (out.dailyRows.some((x) => x.工程項目 === '營造業專業工程特定施工項目')) return false;

    // extras 出工
    if (!out.extras.出工明細 || out.extras.出工明細[0].工別 !== '大工' || out.extras.出工明細[0].人數 !== 4) return false;

    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  meta: {
    vendorKey: '摯東營造有限公司',
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  parseGrid,   // 匯出純函式供測試/自檢
  selfTest,
};
