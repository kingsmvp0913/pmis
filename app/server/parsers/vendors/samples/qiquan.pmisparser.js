/**
 * qiquan.pmisparser.js — 齊全土木包工業施工日誌讀取器(公誠國小育英樓排水改善)
 *
 * vendorKey 取自**決標公告的得標廠商**(公誠案:齊全土木包工業);
 * 日誌 r3 的承攬廠商名稱與之一字不差,可互為佐證。
 *
 * ── 版面事實(實測 6 份 .xlsx / 294 個分頁)──
 * 工程會版單頁表單,**一天一個分頁**,分頁名 `MMDD`(如 `1215`、`0318`),
 * 檔案內已是時序。6 份 xlsx 是**同一個工程的逐月快照**:最新那份(0318)含
 * 12/15–3/18 全部 94 天,舊的幾份是它的前綴,跨檔重複 77 天。
 *
 * 座標(0-based grid;合併區已被 gridFromWorksheet 填滿):
 *   r2  c10=上午天氣 c20=下午天氣 c48=日期序號 c59=星期(數字 1=日 … 7=六)
 *   r3  c6=工程名稱  c47=承攬廠商
 *   r5  c17=開工序號 c49=完工序號
 *   r7  c17=累計預定進度 c49=累計實際進度(r6 是**本日**進度,不是這個)
 *   r9  明細表頭      r10–r30 明細   r32/r33 本日/累計合計金額
 *   r38 材料表頭      r45 出工/機具表頭
 *
 * ── 三個會讀錯的地方 ──
 * ① **數值欄分成左右兩塊**:單位/契約數量/本日完成數量/累計完成數量在 c30–c60,
 *    但**契約單價(c65)、本日完成金額(c66)、累計完成金額(c67)、契約總額(c69)
 *    在表格右外側**。寶樹那家的右外側區與明細**錯開一列**,這家實測沒有:
 *    5475 列的「單價 × 契約數量 = 契約總額」與「累計量 × 單價 = 累計金額」都對得上,
 *    111 個不符全部落在營業稅那一列(費用項的累計欄是比例)。
 *    本日完成金額同樣核對過:0.5 × 5000 = 2500、12 × 4650 = 55800,逐筆吻合。
 * ② **明細中間夾著兩列小計**(r25「合計(壹)」、r31「發包工程費合計」)。
 *    它們沒有單位也沒有單價,`isCategoryRow` 會把它們當成大類收進 dailyRows。
 *    判準是**項次欄為空**——小計列的項次是空的,真項目一定有項次。
 * ③ **星期欄沒有標籤**(緊接在日期序號右邊),值是數字 1~7(1=日)。
 *    取日期後的下一個非空值,且只在 1~7 的整數時採用。
 *
 * ── 這家有的、多數家沒有的 ──
 *   r33「累計合計金額」是**當日的累計金額**,與各項累計金額逐筆相加一致
 *   (1/6 實測 11000+110+110+770+3084+15190 = 30264),故收進 header.本日累計金額。
 */

const META_VENDOR_KEY = '齊全土木包工業';

// 單位白名單。樣式判定會把 RC/PVC 這類工程縮寫當成單位(skill 的金大教訓)。
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', 'CM', 'MM', 'KG', 'kg',
  '噸', 'T', '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間',
  '天', '日', '趟', '才', '公尺', '公斤', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '張', '盞', '針', '本', '月']);

const WEEKDAY = ['', '日', '一', '二', '三', '四', '五', '六'];

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' || s === '－' ? null : s;
};

/** 去掉所有空白(標籤如「開 工 日 期」逐字散開,比對前要壓掉)。 */
const squash = (v) => (v == null ? '' : String(v).replace(/[\s　]/g, ''));

/** 數值。無資料標記(`-`/空白)一律 null——語意是「無資料」而非 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function unitOf(v) {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;
}

const at = (grid, r, c) => {
  const row = grid[r];
  if (!row) return null;
  const v = row[c];
  return v === undefined ? null : v;
};

/** 星期欄是數字 1~7(1=日)。轉成與其他讀取器一致的「星期一」形狀。 */
function weekdayOf(v) {
  const n = numOf(v);
  if (n == null || !Number.isInteger(n) || n < 1 || n > 7) return null;
  return `星期${WEEKDAY[n]}`;
}

/** 找出第 0 欄壓掉空白後含 keyword 的第一列。找不到回 -1。 */
function rowOf(grid, keyword, from = 0) {
  for (let r = from; r < grid.length; r++) {
    if (squash(at(grid, r, 0)).includes(keyword)) return r;
  }
  return -1;
}

/**
 * 表頭列壓成分段:連續同值(合併填充後的複本)只留最左那一欄。
 * 不壓的話一個合併 11 欄的標籤會被當成 11 個獨立區塊。
 */
function headerSegments(row) {
  const segs = [];
  let prev = null;
  for (let c = 0; c < (row || []).length; c++) {
    const s = squash(row[c]);
    if (s !== '' && s !== prev) segs.push({ label: s, col: c });
    prev = s;
  }
  return segs;
}

/** 表頭列上,標籤等於 label 的第一個欄索引(已壓掉合併複本)。 */
function colOf(segs, label) {
  const hit = segs.find((s) => s.label === label);
  return hit ? hit.col : -1;
}

/** 同一列上,標籤欄之後的第一個非空值(跳過合併複本)。 */
function valueAfterLabel(grid, r, keyword) {
  const row = grid[r] || [];
  const segs = headerSegments(row);
  const i = segs.findIndex((s) => s.label.includes(keyword));
  if (i < 0 || i + 1 >= segs.length) return null;
  return row[segs[i + 1].col];
}

const isSectionTitle = (v) => /^[一二三四五六七八九十]、/.test(squash(v));

// 明細表頭標籤 → 內部欄名。右外側那四欄也在同一列。
const ITEM_HEADERS = {
  項次: '項次', 工程項目: '施工項目', 單位: '單位', 契約數量: '契約數量',
  本日完成數量: '本日完成數量', 累計完成數量: '累計完成數量',
  契約單價: '契約單價金額', 本日完成金額: '本日完成金額',
};

function itemColumns(grid, headerRow) {
  const segs = headerSegments(grid[headerRow] || []);
  const cols = {};
  for (const [key, label] of Object.entries(ITEM_HEADERS)) {
    const c = colOf(segs, label);
    if (c >= 0) cols[key] = c;
  }
  return cols;
}

/**
 * 明細列。**只收項次非空的列**——中間夾著的「合計(壹)」「發包工程費合計」
 * 沒有單位也沒有單價,收下來會被當成大類(見檔頭②)。
 */
function parseItemRows(grid, headerRow, cols) {
  const out = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const 首欄 = squash(at(grid, r, 0));
    const 名稱欄 = squash(at(grid, r, cols.工程項目));
    if (首欄.includes('營造業專業工程')) break;              // 明細區下界
    if (名稱欄 === '本日合計金額' || 名稱欄 === '累計合計金額') break;
    const 項次 = text(at(grid, r, cols.項次));
    if (!項次) continue;                                     // 小計列
    out.push({
      項次,
      工程項目: text(at(grid, r, cols.工程項目)),
      單位: unitOf(at(grid, r, cols.單位)),
      契約單價: numOf(at(grid, r, cols.契約單價)),
      契約數量: numOf(at(grid, r, cols.契約數量)),
      本日完成數量: numOf(at(grid, r, cols.本日完成數量)),
      本日完成金額: numOf(at(grid, r, cols.本日完成金額)),
      累計完成數量: numOf(at(grid, r, cols.累計完成數量)),
    });
  }
  return out;
}

/** 出工/機具/材料:同一張表頭列上並排,以標籤定位,止於下一個段落標題。 */
function parseListBlock(grid, headerRow, nameLabel, valueLabel, unitLabel) {
  const segs = headerSegments(grid[headerRow] || []);
  const nameCol = colOf(segs, nameLabel);
  const valueCol = colOf(segs, valueLabel);
  const unitCol = unitLabel ? colOf(segs, unitLabel) : -1;
  if (nameCol < 0) return [];
  const out = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    // 合併填充後不會有「整列皆空」,靠段落標題當界
    if (isSectionTitle(at(grid, r, 0))) break;
    const 名稱 = text(at(grid, r, nameCol));
    if (!名稱) continue;
    const item = { 名稱, 數量: valueCol < 0 ? null : numOf(at(grid, r, valueCol)) };
    if (unitCol >= 0) item.單位 = unitOf(at(grid, r, unitCol));
    out.push(item);
  }
  return out;
}

/**
 * 解析單一天的分頁 grid → { header, dailyRows, extras }。純函式,selfTest 重用。
 * @param {Array<Array<any>>} grid
 * @param {(serial:number)=>string|null} serialToISO 由 ctx.filetypes 注入
 */
function parseSheet(grid, serialToISO) {
  const 天氣列 = rowOf(grid, '本日天氣');
  const 名稱列 = rowOf(grid, '工程名稱');
  const 開工列 = rowOf(grid, '開工日期');
  const 進度列 = rowOf(grid, '累計預定進度');
  const 表頭列 = rowOf(grid, '項次');
  if (天氣列 < 0 || 表頭列 < 0) {
    // 回空會被上游當成「這份沒有資料」靜靜略過,故 throw。
    throw new Error('分頁缺少「本日天氣/項次」錨點');
  }
  const cols = itemColumns(grid, 表頭列);
  for (const key of ['項次', '工程項目', '單位', '契約數量', '契約單價']) {
    if (cols[key] === undefined) throw new Error(`明細表頭缺少「${ITEM_HEADERS[key]}」欄`);
  }

  // 日期與星期:星期沒有自己的標籤,緊接在日期序號右邊(見檔頭③)
  const segs天氣 = headerSegments(grid[天氣列] || []);
  const i日期 = segs天氣.findIndex((s) => s.label.includes('日期'));
  const 序號 = i日期 >= 0 && i日期 + 1 < segs天氣.length
    ? numOf(at(grid, 天氣列, segs天氣[i日期 + 1].col)) : null;
  const 星期 = i日期 >= 0 && i日期 + 2 < segs天氣.length
    ? weekdayOf(at(grid, 天氣列, segs天氣[i日期 + 2].col)) : null;

  const 合計列 = (label) => {
    for (let r = 表頭列 + 1; r < grid.length; r++) {
      if (squash(at(grid, r, cols.工程項目)) === label) return numOf(at(grid, r, cols.本日完成數量));
    }
    return null;
  };

  const 出工 = parseListBlock(grid, rowOf(grid, '工別'), '工別', '本日人數');
  const 機具 = parseListBlock(grid, rowOf(grid, '工別'), '機具名稱', '本日完成數量');
  const 材料 = parseListBlock(grid, rowOf(grid, '材料名稱'), '材料名稱', '本日使用數量', '單位');

  let 出工總人數 = null;
  const 有人數 = 出工.filter((x) => x.數量 != null);
  if (有人數.length) 出工總人數 = 有人數.reduce((s, x) => s + x.數量, 0);

  const extras = {};
  if (出工.length) extras.出工明細 = 出工.map((x) => ({ 工別: x.名稱, 人數: x.數量 }));
  if (機具.length) extras.主要機具 = 機具.map((x) => ({ 名稱: x.名稱, 數量: x.數量 }));
  if (材料.length) extras.主要材料 = 材料.map((x) => ({ 名稱: x.名稱, 單位: x.單位, 數量: x.數量 }));

  return {
    header: {
      工程名稱: 名稱列 < 0 ? null : text(valueAfterLabel(grid, 名稱列, '工程名稱')),
      填報日期: 序號 != null && serialToISO ? serialToISO(序號) : null,
      星期,
      天氣_上午: text(valueAfterLabel(grid, 天氣列, '上午')),
      天氣_下午: text(valueAfterLabel(grid, 天氣列, '下午')),
      // r6 是本日進度、r7 才是累計;SP3 的 F3/C4 驗的是累計語意
      預定進度: 進度列 < 0 ? null : numOf(valueAfterLabel(grid, 進度列, '累計預定進度')),
      實際進度: 進度列 < 0 ? null : numOf(valueAfterLabel(grid, 進度列, '累計實際進度')),
      出工總人數,
      本日累計金額: 合計列('累計合計金額'),
      承包廠商: 名稱列 < 0 ? null : text(valueAfterLabel(grid, 名稱列, '承攬廠商名稱')),
      開工日期: (() => {
        if (開工列 < 0) return null;
        const v = numOf(valueAfterLabel(grid, 開工列, '開工日期'));
        return v != null && serialToISO ? serialToISO(v) : null;
      })(),
    },
    dailyRows: parseItemRows(grid, 表頭列, cols),
    extras,
  };
}

/** 日分頁 = 有「本日天氣」與「項次」兩個錨的分頁。 */
function daySheetNames(wb) {
  return wb.sheetNames.filter((n) => {
    const g = wb.sheets[n];
    return Array.isArray(g) && rowOf(g, '本日天氣') >= 0 && rowOf(g, '項次') >= 0;
  });
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const names = daySheetNames(wb);
  if (!names.length) {
    throw new Error('找不到任何日分頁(此檔非齊全格式,或是無文字層的掃描件)');
  }
  const days = names.map((n) => parseSheet(wb.sheets[n], ft.excelSerialToISO));
  days.sort((a, b) => String(a.header.填報日期 || '').localeCompare(String(b.header.填報日期 || '')));
  return days;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

// selfTest:內建 grid 小樣本,不需 ft、不 require 任何 node_modules
// (讀取器安裝在 data/vendor-parsers/,那裡沒有 node_modules)。
function selfTest() {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  const span = (r, from, to, v) => { for (let c = from; c <= to; c++) set(r, c, v); };

  span(0, 0, 64, '公共工程施工日誌');
  set(1, 0, '表報編號：'); span(1, 7, 64, 23);
  set(2, 0, '本日天氣:'); set(2, 6, '上午：'); span(2, 10, 12, '晴');
  set(2, 16, '下午:'); span(2, 20, 22, '陰');
  span(2, 43, 47, '日期：'); span(2, 48, 58, 45663); span(2, 59, 64, 2);
  span(3, 0, 5, '工程名稱'); span(3, 6, 38, '測試工程');
  span(3, 39, 46, '承攬廠商名稱'); span(3, 47, 64, '齊全土木包工業');
  span(5, 0, 16, '開 工 日 期'); span(5, 17, 32, 45641);
  span(5, 33, 48, '完 工 日 期'); span(5, 49, 64, 45732);
  // r6 是**本日**進度,r7 才是累計——抓錯列不會有欄位變 null
  span(6, 0, 16, '本日預定進度(%)'); span(6, 17, 32, 0.5);
  span(6, 33, 48, '本日實際進度(%)'); span(6, 49, 64, 0.6);
  span(7, 0, 16, '累計預定進度(%)'); span(7, 17, 32, 0.02408);
  span(7, 33, 48, '累計實際進度(%)'); span(7, 49, 64, 0.03394);
  span(8, 0, 64, '一、依施工計劃書執行按圖施工概況');
  span(9, 0, 2, '項次'); span(9, 3, 29, '施工項目'); span(9, 30, 33, '單位');
  span(9, 34, 42, '契約數量'); span(9, 43, 51, '本日完成數量'); span(9, 52, 60, '累計完成數量');
  span(9, 61, 64, '備註');
  set(9, 65, '契約單價金額'); set(9, 66, '本日完成金額'); set(9, 67, '累計完成金額'); set(9, 69, '契約總額');
  span(10, 0, 2, '壹.'); span(10, 3, 29, '直接工程');                      // 大類:無單位無單價
  span(11, 0, 2, 1); span(11, 3, 29, '工程告示牌、職業安全衛生告示牌與交通管制設施(租用)');
  span(11, 30, 33, '式'); span(11, 34, 42, 1); span(11, 43, 51, 1); span(11, 52, 60, 1);
  set(11, 65, 5000); set(11, 66, 5000); span(11, 67, 69, 5000);
  span(12, 0, 2, 7); span(12, 3, 29, '新設RC水溝'); span(12, 30, 33, 'M');
  span(12, 34, 42, 23); span(12, 52, 60, 0);
  set(12, 65, 3500); span(12, 66, 68, 0); set(12, 69, 80500);
  // 小計列:項次空、無單位無單價——不排除的話會被當成大類收進明細
  span(13, 3, 42, '合計(壹)'); set(13, 66, 5000); span(13, 67, 68, 11000); set(13, 69, 776279);
  span(14, 0, 2, '貳'); span(14, 3, 29, '職業安全衛生管理費 (壹*1%)'); span(14, 30, 33, '式');
  span(14, 34, 42, 1); span(14, 43, 51, 0); span(14, 52, 60, 0.01417);
  set(14, 65, 7762); set(14, 66, 0); span(14, 67, 68, 110); set(14, 69, 7762);
  span(15, 3, 42, '發包工程費合計 (壹~陸)'); set(15, 66, 5000);
  span(16, 3, 29, '本日合計金額'); span(16, 43, 60, 5000);
  span(17, 3, 29, '累計合計金額'); span(17, 43, 60, 30264);
  span(18, 0, 20, '營造業專業工程特定施工項目');
  span(20, 0, 64, '二、工地材料管理概況');
  span(21, 0, 20, '材料名稱'); span(21, 21, 23, '單位'); span(21, 24, 33, '設計數量');
  span(21, 34, 43, '本日使用數量'); span(21, 44, 53, '累計使用數量');
  span(22, 0, 20, 'D10鋼筋'); span(22, 21, 23, 'KG'); span(22, 24, 33, 1021.95); span(22, 44, 53, 1021.95);
  span(23, 0, 64, '三、工地人員及機具管理');
  span(24, 0, 10, '工別'); span(24, 11, 20, '本日人數'); span(24, 21, 33, '累計人數');
  span(24, 34, 43, '機具名稱'); span(24, 44, 53, '本日完成數量'); span(24, 54, 64, '累計完成數量');
  span(25, 0, 10, '技術工'); span(25, 11, 20, 4); span(25, 21, 33, 53);
  span(25, 34, 43, '挖土機'); span(25, 54, 64, 3);
  span(26, 0, 10, '小工'); span(26, 11, 20, 2); span(26, 21, 33, 20);
  span(26, 34, 43, '鏟土機'); span(26, 54, 64, 2);
  span(27, 0, 64, '四、本日施工項目是否有須依「營造業專業工程持定施工項目');

  const day = parseSheet(g, (n) => ({ 45663: '2025-01-06', 45641: '2024-12-15' }[n] || null));
  const h = day.header;
  if (h.工程名稱 !== '測試工程') return false;
  if (h.承包廠商 !== META_VENDOR_KEY) return false;
  if (h.填報日期 !== '2025-01-06') return false;
  if (h.開工日期 !== '2024-12-15') return false;
  if (h.天氣_上午 !== '晴' || h.天氣_下午 !== '陰') return false;
  if (h.星期 !== '星期一') return false;                  // 沒有標籤的那一欄,數字 2 = 星期一
  if (h.預定進度 !== 0.02408 || h.實際進度 !== 0.03394) return false;   // 取累計不是本日
  if (h.出工總人數 !== 6) return false;
  if (h.本日累計金額 !== 30264) return false;             // 這家真的有日層級累計金額

  const rows = day.dailyRows;
  // 大類 + 兩個細項 + 一個費用項;夾在中間的兩列小計必須被切掉
  if (rows.length !== 4) return false;
  if (rows.some((x) => String(x.工程項目 || '').includes('合計'))) return false;
  const [大類, r1] = rows;
  if (大類.項次 !== '壹.' || 大類.單位 !== null || 大類.契約單價 !== null) return false;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約單價 !== 5000) return false;
  // 金額欄在表格右外側,錯一欄就會拿到契約總額
  if (r1.本日完成數量 !== 1 || r1.本日完成金額 !== 5000) return false;
  if (r1.本日完成金額 !== r1.本日完成數量 * r1.契約單價) return false;
  const r7 = rows.find((x) => x.項次 === '7');
  if (!r7) return false;
  if (r7.工程項目 !== '新設RC水溝' || r7.單位 !== 'M') return false;     // RC 不可被當成單位
  if (r7.本日完成數量 !== null || r7.本日完成金額 !== 0) return false;   // 沒填是 null,不是 0
  const r貳 = rows.find((x) => x.項次 === '貳');
  if (!r貳 || r貳.契約單價 !== 7762) return false;

  const 出工 = day.extras.出工明細 || [];
  if (出工.length !== 2 || 出工[0].工別 !== '技術工' || 出工[0].人數 !== 4) return false;
  const 機具 = day.extras.主要機具 || [];
  if (機具.length !== 2 || 機具[0].名稱 !== '挖土機' || 機具[0].數量 !== null) return false;
  const 材料 = day.extras.主要材料 || [];
  if (材料.length !== 1 || 材料[0].單位 !== 'KG' || 材料[0].數量 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseSheet, parseItemRows, itemColumns, weekdayOf, numOf, unitOf },
};
