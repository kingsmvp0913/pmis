/**
 * hewen.pmisparser.js — 和穩土木包工業施工日誌讀取器(永定國小無障礙)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌 `施工項目` 分頁第 0 列與 `日報` 的
 * 「承攬廠商名稱」欄也都寫「和穩土木包工業」,三邊一致。
 *
 * ── 版面事實(實測 3 份 xlsx / 60 天)──
 * 與**承昇**(明倫國小)是同一套版面:`封面 | 日報 | 施工項目` 三分頁,
 * 兩個資料分頁各自重複「天區塊」,天數一致、順序對應:
 *   - `日報`     以「表報編號：」為界;提供 header(天氣/日期/工期/進度)
 *   - `施工項目` 以「第二聯」為界;提供 dailyRows(八欄俱全)
 * registry 是「一 vendorKey 一支讀取器」、讀取器又不能 require 別的檔,
 * 所以同版面只能整份複製(這是刻意的取捨,不是漏抽共用)。
 *
 * **dailyRows 一律取自 `施工項目` 而不是 `日報`**:日報那張只列當天施作的項目、
 * 且沒有契約單價與金額;第二聯才是八欄齊全的完整明細(SP3 的 B3/B4/C2 要用)。
 *
 * 欄索引以**表頭列實測**為準(合併填充後穩定):
 *   施工項目 — 項次 0 / 工程項目 4 / 單位 20 / 契約數量 24 / 契約單價 30 /
 *              本日完成數量 36 / 本日完成金額 42 / 累計完成數量 48 / 累計完成金額 54
 *
 * ── 三個坑 ──
 * ① **明細最後一列是「計」**(欄 4 = 計,沒有項次,只有金額合計)。它沒有單位、
 *    沒有數量,收下來會被 `isCategoryRow` 判成大類,完整性統計看不到,卻多出一列
 *    假項目。判準:**真項目一定有項次**,沒有項次的列一律不收(同齊全那家的小計坑)。
 * ② **開工日期打成「114年09年10日」**(第二個「年」是「月」的筆誤)。日期字串的
 *    第二段無論寫年或月都是月份,故容忍;不容忍的話這欄整份 null。
 * ③ **同案的 PDF 版不必做**:`永定國小施工日誌-無障礙1141030.pdf` 與同名 xlsx
 *    是同一批日子,xlsx 已涵蓋全部 60 天。PDF 餵給 SheetJS 會回一份空活頁簿,
 *    那時要 throw 而不是回空陣列——回空會被上游當成「這份沒有資料」靜靜略過。
 *
 * ── 此格式沒有的東西 ──
 * 沒有星期、沒有出工人數/機具/材料(日報那三張表實測全空),日層級的累計金額也沒有
 * (第二聯只有逐項金額)。一律 null,不由別處回推。
 */

const META_VENDOR_KEY = '和穩土木包工業';

const DAILY_SHEET = '日報';
const ITEM_SHEET = '施工項目';
const DAILY_STRIDE = 47;
const ITEM_STRIDE = 48;

// 施工項目分頁(第二聯)的欄索引
const COL = {
  項次: 0, 工程項目: 4, 單位: 20, 契約數量: 24, 契約單價: 30,
  本日完成數量: 36, 本日完成金額: 42, 累計完成數量: 48,
};
// 明細列相對於天區塊起始列的偏移:起始列是「第二聯」,+2 是表頭,+3 起是資料。
const ITEM_FIRST_OFFSET = 3;

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/** 無資料標記(`-`/`－`/空白)一律 null——語意是「無資料」而非 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 民國/西元日期字串 → 'YYYY-MM-DD'。
 * 第二個分隔字容忍「年」:來源實測打成「114年09年10日」(見檔頭②)。
 */
function rocTextToISO(v) {
  const s = v == null ? '' : String(v).replace(/[\s　]/g, '');
  const m = /(\d{2,4})年(\d{1,2})[年月](\d{1,2})日/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911; // 民國
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

// 「下午： 晴」→「晴」。上午欄是純值,下午欄把標籤與值黏在同一格。
function afternoonWeather(v) {
  const s = v == null ? '' : String(v).replace(/[\s　]/g, '');
  const m = /下午[:：]?(.*)$/.exec(s);
  return text(m ? m[1] : s);
}

/**
 * 一天的 header(純函式,吃日報分頁的 grid 與該天起始列)。
 * @param {Array<Array>} grid
 * @param {number} start 該天「表報編號：」所在列
 * @param {(serial:number)=>string|null} serialToISO 由 ctx.filetypes 注入
 */
function parseHeader(grid, start, serialToISO) {
  const row = (off) => grid[start + off] || [];
  const r1 = row(1);
  const 序號 = numOf(r1[7]);
  return {
    工程名稱: text(row(2)[3]),
    填報日期: 序號 == null || !serialToISO ? null : serialToISO(序號),
    星期: null,               // 此格式不提供
    天氣_上午: text(r1[2]),
    天氣_下午: afternoonWeather(r1[3]),
    預定進度: numOf(row(6)[3]),
    實際進度: numOf(row(6)[10]),
    出工總人數: null,          // 此格式不提供(日報的出工表實測全空)
    本日累計金額: null,        // 此格式不提供(第二聯有逐項金額,無日層級合計)
    承包廠商: text(row(2)[10]),
    開工日期: rocTextToISO(row(5)[3]),
  };
}

/**
 * 一天的明細(純函式,吃施工項目分頁的 grid 與該天起始列)。
 * 遇到整列皆空即結束——各天的項目數不一定相同,寫死列數會把別天的資料吃進來。
 * **沒有項次的列不收**:那是最後的「計」小計列(見檔頭①)。
 */
function parseItemRows(grid, start) {
  const out = [];
  for (let i = start + ITEM_FIRST_OFFSET; i < grid.length; i++) {
    const r = grid[i] || [];
    const 項次 = text(r[COL.項次]);
    const 工程項目 = text(r[COL.工程項目]);
    if (!項次 && !工程項目) break;
    if (!項次) continue;
    out.push({
      項次,
      工程項目,
      單位: text(r[COL.單位]),
      契約單價: numOf(r[COL.契約單價]),
      契約數量: numOf(r[COL.契約數量]),
      本日完成數量: numOf(r[COL.本日完成數量]),
      本日完成金額: numOf(r[COL.本日完成金額]),
      累計完成數量: numOf(r[COL.累計完成數量]),
    });
  }
  return out;
}

/** 找出各天區塊的起始列。以標記字串為準,不靠寫死的列號。 */
function blockStarts(grid, marker, stride) {
  const starts = [];
  for (let i = 0; i < grid.length; i++) {
    if (String((grid[i] || [])[0] || '').includes(marker)) starts.push(i);
  }
  // 標記找不到時退回固定間距(版面若微調,至少不會整份解析失敗)
  if (!starts.length && grid.length > stride) {
    for (let i = 1; i < grid.length; i += stride) starts.push(i);
  }
  return starts;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const daily = (wb.sheets || {})[DAILY_SHEET] || [];
  const items = (wb.sheets || {})[ITEM_SHEET] || [];
  const dStarts = daily.length ? blockStarts(daily, '表報編號', DAILY_STRIDE) : [];
  const iStarts = items.length ? blockStarts(items, '第二聯', ITEM_STRIDE) : [];
  // 回空陣列會被上游當成「這份沒有資料」靜靜略過。PDF 餵給 SheetJS 就是走到這裡。
  if (!dStarts.length || !iStarts.length) {
    throw new Error('找不到「日報/施工項目」分頁的天區塊(此檔非和穩格式,或是 PDF/掃描件)');
  }

  const n = Math.min(dStarts.length, iStarts.length);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      header: parseHeader(daily, dStarts[k], ft.excelSerialToISO),
      dailyRows: parseItemRows(items, iStarts[k]),
      extras: {},
    });
  }
  return out;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

/**
 * selfTest 用**內建 grid 小樣本**(取自 `永定國小施工日誌.xlsx` 的真實值)直接測純函式,
 * 不需要 ft,也不 require 任何 node_modules——讀取器裝到 data/vendor-parsers/ 時
 * 那裡沒有 node_modules,selfTest 內 require 會被 try/catch 吃掉變成「未通過」。
 */
function selfTest() {
  const itemGrid = [];
  itemGrid[1] = ['第二聯'];
  const put = (r, o) => {
    itemGrid[r] = [];
    for (const [k, c] of Object.entries(COL)) itemGrid[r][c] = o[k];
  };
  put(4, {
    項次: '1', 工程項目: '工程告示牌與職安衛告示牌(租用)', 單位: '式', 契約數量: '1',
    契約單價: '5000', 本日完成數量: '1', 本日完成金額: '5000', 累計完成數量: '1',
  });
  put(5, {
    項次: '貳', 工程項目: '職業安全衛生管理費與施工環境保護與清潔（壹*2%）', 單位: '式',
    契約數量: '1', 契約單價: '8807', 本日完成數量: '0.017', 本日完成金額: '149.719',
    累計完成數量: '0.017',
  });
  // 明細的最後一列是「計」:沒有項次,只有金額合計 —— 不可收成一列假項目
  itemGrid[6] = [];
  itemGrid[6][COL.工程項目] = '計';
  itemGrid[6][COL.本日完成金額] = '2482.474';

  const rows = parseItemRows(itemGrid, 1);
  if (rows.length !== 2) return false;
  const [r1, r2] = rows;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約單價 !== 5000) return false;
  if (r1.本日完成金額 !== 5000 || r1.累計完成數量 !== 1) return false;
  if (r2.項次 !== '貳' || r2.本日完成數量 !== 0.017) return false;   // 費用項是真項目
  if (rows.some((r) => r.工程項目 === '計')) return false;

  const dailyGrid = [];
  dailyGrid[1] = ['表報編號：', '1'];
  dailyGrid[2] = ['本日天氣：', '上午：', '晴', ' 下午： 陰', '', ' 填表日期：', '', 45910];
  dailyGrid[3] = ['工程名稱', '', '', '測試工程', '', '', '', '承攬廠商名稱', '', '', META_VENDOR_KEY];
  // 開工日期在來源是「114年09年10日」:第二個「年」其實是「月」的筆誤
  dailyGrid[6] = ['開工日期', '', '', '114年09年10日'];
  dailyGrid[7] = ['預定進度(%)', '', '', '0.002', '', '', '', '實際進度(%)', '', '', '0.004868627450980392'];
  const h = parseHeader(dailyGrid, 1, () => '2025-09-10');
  if (h.天氣_上午 !== '晴' || h.天氣_下午 !== '陰') return false;
  if (h.填報日期 !== '2025-09-10' || h.開工日期 !== '2025-09-10') return false;
  if (h.工程名稱 !== '測試工程' || h.承包廠商 !== META_VENDOR_KEY) return false;
  if (h.預定進度 !== 0.002) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseHeader, parseItemRows, rocTextToISO, afternoonWeather, numOf },
};
