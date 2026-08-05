/**
 * chengsheng.pmisparser.js — 承昇營造(明倫國小)施工日誌讀取器
 *
 * 來源:`承昇明倫國小廁所06施工日誌.xlsx`,3 分頁(封面 / 日報 / 施工項目)。
 *
 * ── 版面事實(實測)──
 * 兩個分頁**各自**以固定間距重複 49 個「天區塊」,兩邊天數一致、順序對應:
 *   - `日報`     起始列 1、間距 47;提供 header(天氣/日期/工期/進度)
 *   - `施工項目` 起始列 1、間距 48;提供 dailyRows(第二聯,八欄俱全)
 *
 * **dailyRows 一律取自「施工項目」而非「日報」**:日報的明細只有
 * 施工項目/單位/契約數量/本日完成數量/累計完成數量,**沒有契約單價與金額**;
 * 第二聯才是八欄齊全的那一份。用日報的話,單價與金額只能留 null,
 * 而那兩欄正是 SP3 的 B3/B4/C2 驗證所需。
 *
 * 欄索引在合併儲存格被 `gridFromWorksheet` 填滿後是穩定的,但仍以**表頭列實測**
 * 為準(skill 的 Excel 坑③):
 *   施工項目分頁 — 項次 0 / 工程項目 4 / 單位 20 / 契約數量 24 / 契約單價 30 /
 *                  本日完成數量 36 / 本日完成金額 42 / 累計完成數量 48
 *   日報分頁     — 天氣上午 2、天氣下午 3(「下午： 晴」需拆)、填表日期 7(序號)、
 *                  工程名稱 3、開工日期 3、預定進度 3、實際進度 10
 */

const META_VENDOR_KEY = '承昇營造有限公司';

// 日報與施工項目分頁各自的天區塊參數(實測)。
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

/**
 * 數值。無資料標記(`-`/`－`/空白)一律 null——語意是「無資料」而非 0,
 * 兩者在累計驗證裡的意義不同。
 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 民國/西元日期字串 → 'YYYY-MM-DD'。承昇的開工日期是「115年5月13日」這種字串,
 * 填表日期則是 Excel 序號(由呼叫端以 ft.excelSerialToISO 轉)。
 */
function rocTextToISO(v) {
  const s = v == null ? '' : String(v).replace(/[\s　]/g, '');
  const m = /(\d{2,4})年(\d{1,2})月(\d{1,2})日/.exec(s);
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
    填報日期: 序號 == null ? null : serialToISO(序號),
    星期: null,               // 此格式不提供
    天氣_上午: text(r1[2]),
    天氣_下午: afternoonWeather(r1[3]),
    預定進度: numOf(row(6)[3]),
    實際進度: numOf(row(6)[10]),
    出工總人數: null,          // 此格式不提供
    本日累計金額: null,        // 此格式不提供(第二聯有逐項金額,無日層級合計)
    承包廠商: text(row(2)[10]),
    開工日期: rocTextToISO(row(5)[3]),
  };
}

/**
 * 一天的明細(純函式,吃施工項目分頁的 grid 與該天起始列)。
 * 遇到整列皆空即結束——各天的項目數不一定相同,寫死列數會把別天的資料吃進來。
 */
function parseItemRows(grid, start) {
  const out = [];
  for (let i = start + ITEM_FIRST_OFFSET; i < grid.length; i++) {
    const r = grid[i] || [];
    const 項次 = text(r[COL.項次]);
    const 工程項目 = text(r[COL.工程項目]);
    if (!項次 && !工程項目) break;
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

function buildDays(wb) {
  const daily = wb.sheets[DAILY_SHEET] || [];
  const items = wb.sheets[ITEM_SHEET] || [];
  return { daily, items };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const wb = ft.readWorkbook(filePath);
  const { daily, items } = buildDays(wb);
  const dStarts = blockStarts(daily, '表報編號', DAILY_STRIDE);
  const iStarts = blockStarts(items, '第二聯', ITEM_STRIDE);

  const n = Math.min(dStarts.length, iStarts.length);
  const out = [];
  for (let k = 0; k < n; k++) {
    const header = parseHeader(daily, dStarts[k], ft.excelSerialToISO);
    out.push({ header, dailyRows: parseItemRows(items, iStarts[k]), extras: {} });
  }
  return out;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

// selfTest 用**內建 grid 小樣本**直接測純函式,不需要 ft,也不 require 任何
// node_modules——讀取器裝到 data/vendor-parsers/ 時那裡沒有 node_modules,
// selfTest 內 require 會被 try/catch 吃掉變成「未通過」(skill 護欄)。
function selfTest() {
  const itemGrid = [];
  itemGrid[1] = ['第二聯'];
  itemGrid[3] = [];
  itemGrid[4] = [];
  itemGrid[4][COL.項次] = '1';
  itemGrid[4][COL.工程項目] = '乙種施工圍籬';
  itemGrid[4][COL.單位] = '式';
  itemGrid[4][COL.契約數量] = '1';
  itemGrid[4][COL.契約單價] = '2200';
  itemGrid[4][COL.本日完成數量] = '0';
  itemGrid[4][COL.本日完成金額] = '0';
  itemGrid[4][COL.累計完成數量] = '0';
  const rows = parseItemRows(itemGrid, 1);
  if (rows.length !== 1) return false;
  const r = rows[0];
  if (r.項次 !== '1' || r.單位 !== '式' || r.契約單價 !== 2200) return false;

  const dailyGrid = [];
  dailyGrid[1] = ['表報編號：', '1'];
  dailyGrid[2] = ['本日天氣：', '上午：', '晴', ' 下午： 陰', '', '填表日期：', '', 46155];
  dailyGrid[3] = ['工程名稱', '', '', '測試工程', '', '', '', '承攬廠商名稱', '', '', '承昇營造有限公司'];
  dailyGrid[6] = ['開工日期', '', '', '115年5月13日'];
  dailyGrid[7] = ['預定進度(%)', '', '', '0.003', '', '', '', '實際進度(%)', '', '', '0.0076'];
  const h = parseHeader(dailyGrid, 1, () => '2026-05-13');
  if (h.天氣_上午 !== '晴' || h.天氣_下午 !== '陰') return false;
  if (h.填報日期 !== '2026-05-13' || h.開工日期 !== '2026-05-13') return false;
  if (h.預定進度 !== 0.003) return false;
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
  // 供測試直接驗純函式
  _internal: { parseHeader, parseItemRows, rocTextToISO, afternoonWeather, numOf },
};
