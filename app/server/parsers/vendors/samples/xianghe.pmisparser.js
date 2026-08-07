/**
 * xianghe.pmisparser.js — 祥賀營造(嘉興國小)施工日誌讀取器
 *
 * 來源:`嘉興國小-施工日誌-(調)至0831.xls`。13 分頁,明細在**分頁名為純數字**的那幾張
 * (1..8,每張一個月);`後半年`/`進度`/`工程詳細表`/`工期計算`/`公式` 是輔助表,不讀。
 *
 * vendorKey 取自**決標公告的得標廠商**(嘉興案:祥賀營造有限公司),日誌本身
 * r0+2 欄 13 也載明同一個名稱,兩邊一致。**不得依命名慣例推定**——猜錯不會報錯,
 * org-match 逐字相等查不到廠商,讀取器就永遠叫不出來(玉森踩過,71 份日誌閒置)。
 *
 * ── 版面事實(實測)──
 * 工程會標準「公共工程施工日誌」表單,一天一區塊垂直堆疊,**間距固定 83 列**
 * (但本檔以「該列出現『報表編號』」偵測起點,不寫死間距——間距是觀察值不是保證)。
 *
 * 區塊表頭(相對起點 r0):
 *   r0+1  欄4=上午天氣  欄8=下午天氣  欄13=填報日期(Excel 序號)
 *   r0+2  欄3=工程名稱  欄13=承攬廠商名稱
 *   r0+7  欄4=本日預定進度  欄11=本日實際進度
 *   r0+60 欄25=每日施工金額累計
 *
 * 明細自 r0+14 起,**左右兩組並排**(表頭列 r0+12/13 兩組欄名一字不差):
 *   欄位        左組  右組
 *   項次         1    10
 *   工程項目      2    11
 *   單位         4    13
 *   契約數量      5    14
 *   本日完成數量   7    16
 *   累計完成數量   8    17
 *   契約單價     20    24
 *   契約複價     21    25
 *   本日完成金額  22    26
 *
 * 欄 20~26 看起來像「表格外的計算區」,但實測逐筆對得上:
 *   單價×契約數量=複價(5800×118=684400)、本日數量×單價=本日金額(40×450=18000)。
 *
 * 兩組都要讀:左組讀完(13 項)接右組(續到營業稅),只讀左組會漏掉一半項目。
 * 停止條件是**該組的工程項目為空**,不是固定列數——各月項目數不同。
 *
 * 星期、出工總人數此格式的日誌區塊不提供(施工人數在 `後半年` 彙總表,
 * 對不回逐日),一律 null 不硬湊。
 */

const META_VENDOR_KEY = '祥賀營造有限公司';

// 明細分頁:名稱是純數字的那幾張。用名稱形狀而非寫死 '1'..'8'——各案月份數不同。
const DETAIL_SHEET_RE = /^\d+$/;

const BLOCK_ANCHOR = '報表編號';

// 區塊內的表頭列位移
const OFF_WEATHER = 1;
const OFF_NAME = 2;
const OFF_PROGRESS = 7;
const OFF_FIRST_ITEM = 14;
const OFF_DAY_TOTAL = 60;

// 明細的兩組欄位落點(見檔頭表格)
const ITEM_GROUPS = [
  { 項次: 1, 工程項目: 2, 單位: 4, 契約數量: 5, 本日完成數量: 7, 累計完成數量: 8, 契約單價: 20, 本日完成金額: 22 },
  { 項次: 10, 工程項目: 11, 單位: 13, 契約數量: 14, 本日完成數量: 16, 累計完成數量: 17, 契約單價: 24, 本日完成金額: 26 },
];

/** 儲存格取值:空字串/純空白/'-'/'－' 一律 null(無資料標記,不是 0)。 */
function cell(grid, r, c) {
  const row = grid[r];
  if (!row) return null;
  const v = row[c];
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s === '-' || s === '－') return null;
    return s;
  }
  return v;
}

/** 數值取值:非數字回 null,絕不編造 0。 */
function num(grid, r, c) {
  const v = cell(grid, r, c);
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Excel 1900 日期序號 → 'YYYY-MM-DD'。也吃已是字串的日期(雙制辨識:
 * 民國 115/6/7 → 2026-06-07;西元 2026/6/7 原樣)。
 * 注入的 ft 有 excelSerialToISO 時優先用它(與其他讀取器同一份實作)。
 */
function toISO(v, ft) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (ft && typeof ft.excelSerialToISO === 'function') return ft.excelSerialToISO(v);
    return null;
  }
  const s = String(v).trim();
  let m = /^(\d{2,4})[/年-](\d{1,2})[/月-](\d{1,2})/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911; // 民國
  return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

/** 找出一張 grid 裡所有天區塊的起點列。 */
function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (const v of row) {
      if (typeof v === 'string' && v.replace(/\s/g, '') === BLOCK_ANCHOR) { out.push(r); break; }
    }
  }
  return out;
}

/**
 * 解析單一天區塊(純函式,不碰檔案系統;供 selfTest 用)。
 * @param {Array<Array>} grid 整張分頁
 * @param {number} r0 區塊起點列
 * @param {object} [ft] 注入的檔型工具(只用 excelSerialToISO)
 */
function parseBlock(grid, r0, ft) {
  const 填報日期 = toISO(cell(grid, r0 + OFF_WEATHER, 13), ft);
  const dailyRows = [];
  for (const g of ITEM_GROUPS) {
    for (let r = r0 + OFF_FIRST_ITEM; r < grid.length; r++) {
      const 工程項目 = cell(grid, r, g.工程項目);
      if (工程項目 == null) break; // 該組結束;各月項目數不同,不用固定列數
      dailyRows.push({
        項次: cell(grid, r, g.項次) == null ? null : String(cell(grid, r, g.項次)),
        工程項目: String(工程項目),
        單位: cell(grid, r, g.單位) == null ? null : String(cell(grid, r, g.單位)),
        契約單價: num(grid, r, g.契約單價),
        契約數量: num(grid, r, g.契約數量),
        本日完成數量: num(grid, r, g.本日完成數量),
        本日完成金額: num(grid, r, g.本日完成金額),
        累計完成數量: num(grid, r, g.累計完成數量),
      });
    }
  }
  return {
    header: {
      工程名稱: cell(grid, r0 + OFF_NAME, 3) == null ? null : String(cell(grid, r0 + OFF_NAME, 3)),
      填報日期,
      星期: null,          // 此格式不提供
      天氣_上午: cell(grid, r0 + OFF_WEATHER, 4) == null ? null : String(cell(grid, r0 + OFF_WEATHER, 4)),
      天氣_下午: cell(grid, r0 + OFF_WEATHER, 8) == null ? null : String(cell(grid, r0 + OFF_WEATHER, 8)),
      預定進度: num(grid, r0 + OFF_PROGRESS, 4),
      實際進度: num(grid, r0 + OFF_PROGRESS, 11),
      出工總人數: null,     // 施工人數只在「後半年」彙總表,對不回逐日
      // r0+60 欄 24 的標籤寫「每日施工金額累計」,但**值是當日金額不是累計**:
      // 2025-01-06=52677、01-07=15107(遞減),而 52677+15107=67784 正好是第 2 天的
      // 各項累計金額總和。把它當累計填進去,SP3 的 B4(本日累計金額 vs 各項累計總和)
      // 會每天都硬錯——實測 239 項。schema 這欄要的是累計值,來源沒有就是 null,
      // **不自行累加**(那是推導不是來源值,見護欄:金額找不到就留 null,絕不編造)。
      本日累計金額: null,
    },
    dailyRows,
    extras: {},
  };
}

function detailSheets(wb) {
  return wb.sheetNames.filter((n) => DETAIL_SHEET_RE.test(String(n).trim()));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const out = [];
  for (const name of detailSheets(wb)) {
    const grid = wb.sheets[name];
    if (!grid || !grid.length) continue;
    for (const r0 of blockStarts(grid)) {
      const day = parseBlock(grid, r0, ft);
      if (day.填報日期 === null && !day.dailyRows.length) continue; // 空白範本區塊
      out.push(day);
    }
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || { header: {}, dailyRows: [], extras: {} };
}

// selfTest 用**真實座標**造一個最小區塊(取自 fixture 分頁「1」第一天,只換工程名稱)。
// 自己編一組整齊的格子驗不到真實版面的形狀——這裡要驗的是「左右兩組都讀到」
// 與「單價/金額在表格外的欄 20~26」這兩件最容易寫錯的事。
function selfTest(ft) {
  const grid = [];
  const set = (r, c, v) => { (grid[r] = grid[r] || [])[c] = v; };
  set(0, 1, '報表編號'); set(0, 3, 1);
  set(1, 1, '本日天氣'); set(1, 4, '晴'); set(1, 8, '晴'); set(1, 12, '填報日期：'); set(1, 13, 45663);
  set(2, 1, '工程名稱'); set(2, 3, '113年鋪面與排水改善工程'); set(2, 13, META_VENDOR_KEY);
  set(7, 1, '本日預定進度(%)'); set(7, 4, 0.00064); set(7, 11, 0.00993616949037);
  // 左組一列 + 右組一列
  set(14, 1, '2'); set(14, 2, '施工圍籬(租用)'); set(14, 4, 'M');
  set(14, 5, 137); set(14, 7, 40); set(14, 8, 40);
  set(14, 20, 450); set(14, 21, 61650); set(14, 22, 18000);
  set(14, 10, '16'); set(14, 11, '拆除清運走廊地磚，基礎打除'); set(14, 13, 'M2');
  set(14, 14, 230); set(14, 16, 11); set(14, 17, 11);
  set(14, 24, 1200); set(14, 25, 276000); set(14, 26, 13200);
  set(60, 25, 52677);

  const day = parseBlock(grid, 0, ft);
  if (day.header.填報日期 !== '2025-01-06') return false;   // 序號 45663 必須轉出來
  if (day.header.工程名稱 !== '113年鋪面與排水改善工程') return false;
  if (day.header.本日累計金額 !== null) return false;   // 來源只有當日金額,不當累計填
  if (day.dailyRows.length !== 2) return false;              // 左右兩組都要讀到
  const [l, r] = day.dailyRows;
  if (l.單位 !== 'M' || l.契約單價 !== 450 || l.本日完成金額 !== 18000) return false;
  if (r.單位 !== 'M2' || r.契約單價 !== 1200 || r.本日完成金額 !== 13200) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度', '本日累計金額',
      '項次', '工程項目', '單位', '契約單價', '契約數量', '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  // 匯出供測試直接驗純函式
  parseBlock,
  blockStarts,
};
