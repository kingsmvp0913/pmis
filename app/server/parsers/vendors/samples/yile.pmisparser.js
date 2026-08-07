/**
 * yile.pmisparser.js — 以勒綠能光電有限公司施工日誌讀取器(永慶高中運動場整修)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄與活頁簿的
 * `基本資料` 分頁也都是同一個名稱,三邊一致。
 *
 * ── 版面事實(實測 1 份 xlsx / 12 個日分頁)──
 * 工程會標準表單的單聯版,**一天一個分頁**(分頁名 `0811`~`0822`),錨點是欄 0
 * 去空白後等於「表報編號:」。
 *   a+0  欄8「填報日期：」欄9=Excel 序號
 *   a+1  欄0「本日天氣:」欄1「上午：」欄2=值 欄3「下午：」欄4=值
 *   a+2  欄2=工程名稱  欄8=承攬廠商名稱
 *   a+4  欄3=開工日期(序號)
 *   a+5  預定/實際進度(**分數**,保留原值)
 *   a+7  明細表頭      a+8 起是明細(9 列),到「二、」為止
 *
 * ── 兩個坑 ──
 * ① **活頁簿裡有一張叫「可改」的範本分頁**,結構與日分頁一模一樣(連錨點與填報日期
 *    都有,實測 45891 = 最後一天 8/22)。不處理的話那一天會出現兩次,SP3 噴 D1、
 *    累計還被算兩遍。依填報日期去重,保留明細多的那一份。
 * ② **此格式沒有項次欄**,但**每一天都把全部 9 個項目照同一順序列完**(不是只列
 *    當天施作的),所以「出現序」是穩定的位置事實。實測與標價清單逐項同序:
 *    出現序 1~4 = 契約表的 1~4,5~9 對到費用項貳~陸(編號體系不同,靠 SP3 的
 *    名稱後備索引對應,E1 降為軟警告)。
 *
 * ── 此格式沒有的東西 ──
 * 沒有契約單價、沒有任何金額(標價清單在 `基本資料` 分頁上,但那是契約資料不是
 * 日誌內容,不從那裡回填)。沒有星期。材料表實測全空。
 */

const META_VENDOR_KEY = '以勒綠能光電有限公司';

const ANCHOR = '表報編號:';          // despace 會做 NFKC,全形冒號折成半形
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人', '盞']);
const SKIP_ROW = /^(營造業專業工程特定施工項目|[A-Z]\.)$/;
const SECTION = /^[一二三四五六七八九十]+、/;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || /^[-－\s]+$/.test(s) ? null : s;
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

function valueAfter(row, label) {
  const c = colOf(row, label);
  if (c < 0) return null;
  for (let i = c + 1; i < row.length; i++) {
    const s = despace(row[i]);
    if (s === label || s === '') continue;
    return row[i];
  }
  return null;
}

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid 一個日分頁
 * @param {number} a 錨點列
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, serialToISO) {
  const end = grid.length;
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const iso = (v) => {
    const n = num(v);
    return n != null && serialToISO ? serialToISO(n) : null;
  };

  const wr = rowWith(/^本日天氣/);
  const nr = rowWith(/^工程名稱$/);
  const sr = rowWith(/^開工日期$/);
  const pr = rowWith(/^預定進度/);

  const hr = rowWith(/^施工項目$/);
  const dailyRows = [];
  if (hr >= 0) {
    const hdr = grid[hr];
    const c單位 = colOf(hdr, '單位');
    const c契約 = colOf(hdr, '契約數量');
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    if ([c單位, c契約, c本日, c累計].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非以勒格式?)');
    }
    let seq = 0;
    for (let r = hr + 1; r < end; r++) {
      const name = text(at(grid, r, 0));
      if (name != null && SECTION.test(name)) break;
      if (name == null || SKIP_ROW.test(name)) continue;
      seq += 1;                                        // 此格式無項次欄,用出現序(見檔頭②)
      dailyRows.push({
        項次: String(seq),
        工程項目: name,
        單位: unitOf(at(grid, r, c單位)),
        契約單價: null,                                 // 此格式無單價
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                             // 此格式無金額
        累計完成數量: num(at(grid, r, c累計)),
      });
    }
  }

  const extras = {};
  let 出工總人數 = null;
  const cr = rowWith(/^工別$/);
  if (cr >= 0) {
    const hdr = grid[cr];
    const c人數 = colOf(hdr, '本日人數');
    const c機具 = colOf(hdr, '機具名稱');
    const c機數 = colOf(hdr, '本日使用量') >= 0 ? colOf(hdr, '本日使用量') : colOf(hdr, '本日使用數量');
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = cr + 1; r < end; r++) {
      const w = text(at(grid, r, 0));
      const g = c機具 < 0 ? null : text(at(grid, r, c機具));
      if (w != null && SECTION.test(w)) break;
      if (w == null && g == null) continue;
      const n = c人數 < 0 ? null : num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const gn = c機數 < 0 ? null : num(at(grid, r, c機數));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱')),
      填報日期: iso(valueAfter(grid[a], '填報日期:')),
      星期: null,                                       // 此格式不提供
      天氣_上午: wr < 0 ? null : text(valueAfter(grid[wr], '上午:')),
      天氣_下午: wr < 0 ? null : text(valueAfter(grid[wr], '下午:')),
      // 進度保留來源的分數(Excel 系讀取器的既有慣例)
      預定進度: pr < 0 ? null : num(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : num(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                               // 此格式無金額
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : iso(valueAfter(grid[sr], '開工日期')),
    },
    dailyRows,
    extras,
  };
}

function anchorOf(grid) {
  for (let r = 0; r < (grid || []).length; r++) if (despace(at(grid, r, 0)) === ANCHOR) return r;
  return -1;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const days = [];
  for (const name of Object.keys((wb && wb.sheets) || {})) {
    const grid = wb.sheets[name];
    const a = anchorOf(grid);
    if (a < 0) continue;
    days.push(parseDay(grid, a, ft.excelSerialToISO));
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
  if (!days.length) throw new Error('找不到「表報編號」日分頁(此檔非以勒格式,或是掃描件)');
  // 「可改」那張空白範本分頁沒有填報日期(見檔頭①);判定兩個條件並用,
  // 只用「沒有日期」會讓真的漏填日期、但有施工的那天靜默消失。
  const filled = days.filter((d) => d.header.填報日期 != null
    || d.dailyRows.some((r) => r.本日完成數量));
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔錨點雖然對上,版面不是以勒的)');
  }
  // 「可改」那張範本分頁帶著與最後一天相同的填報日期(實測 45891 = 8/22),
  // 不去重會生出 D1「這一天出現兩次」而且累計被算兩遍。保留明細多的那一份。
  const byDate = new Map();
  for (const d of filled) {
    const k = d.header.填報日期;
    const prev = byDate.get(k);
    if (!prev || prev.dailyRows.length < d.dailyRows.length) byDate.set(k, d);
  }
  return [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([, d]) => d);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/** selfTest 用**真實儲存格**(取自 `0820` 分頁,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const put = (r, c, v) => { g[r] = g[r] || []; g[r][c] = v; };
  const span = (r, from, to, v) => { for (let c = from; c <= to; c++) put(r, c, v); };
  span(0, 0, 11, ' 公共工程施工日誌');
  put(1, 0, '表報編號:'); put(1, 1, 11419); put(1, 2, 'P001'); put(1, 3, 45889);
  put(1, 8, '填報日期：'); span(1, 9, 11, 45889);
  put(2, 0, '本日天氣:'); put(2, 1, '上午：'); put(2, 2, '晴'); put(2, 3, '下午：'); put(2, 4, '陰');
  span(3, 0, 1, '工程名稱'); span(3, 2, 5, '測試工程');
  span(3, 6, 7, '承攬廠商名稱'); span(3, 8, 11, META_VENDOR_KEY);
  span(4, 0, 1, '核定工期'); put(4, 2, 30); span(4, 3, 4, '累計工期'); put(4, 5, 10);
  span(5, 0, 2, '開工日期'); span(5, 3, 5, 45880); span(5, 6, 8, '完工日期'); span(5, 9, 11, 45909);
  span(6, 0, 2, '預定進度(%)'); span(6, 3, 5, 0.333);
  span(6, 6, 8, '實際進度(%)'); span(6, 9, 11, 0.0338);
  span(7, 0, 11, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
  span(8, 0, 2, '施工項目'); put(8, 3, '單位'); span(8, 4, 5, '契約數量');
  span(8, 6, 7, '本日完成數量'); span(8, 8, 9, '累計完成數量'); span(8, 10, 11, '備註');
  span(9, 0, 2, '工程告示牌與職安衛告示牌(租用)'); put(9, 3, '式');
  span(9, 4, 5, 1); span(9, 6, 7, 0); span(9, 8, 9, 1);
  span(10, 0, 2, '拆除清運既有天井燈具，安裝LED天井燈具 (200W以上，含配件)');
  put(10, 3, '盞'); span(10, 4, 5, 10); span(10, 6, 9, 0);
  span(11, 0, 2, '職業安全衛生管理費(壹*1%)'); put(11, 3, '式');
  span(11, 4, 5, 1); span(11, 6, 7, 0); span(11, 8, 9, 0.028);
  span(20, 0, 11, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
  span(21, 0, 2, '材料名稱'); put(21, 3, '單位'); span(21, 4, 5, '設計數量');
  span(21, 6, 7, '本日使用數量'); span(21, 8, 9, '累計使用數量'); span(21, 10, 11, '備註');
  span(23, 0, 11, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  span(24, 0, 1, '工別'); span(24, 2, 3, '本日人數'); span(24, 4, 5, '累計人數');
  span(24, 6, 7, '機具名稱'); span(24, 8, 9, '本日使用量'); span(24, 10, 11, '累計使用量');
  span(25, 0, 1, '水電工'); span(25, 2, 5, 2); span(25, 6, 7, '高空作業車'); span(25, 8, 11, 1);
  span(26, 6, 7, '貨車'); span(26, 8, 11, 0);
  span(27, 0, 11, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseDay(g, 1, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2025-08-20') return false;
  if (serial && d.header.開工日期 !== '2025-08-11') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 0.333 || d.header.實際進度 !== 0.0338) return false;
  if (d.header.出工總人數 !== 2) return false;
  if (d.extras.主要機具.length !== 1) return false;      // 貨車 0 不列
  if (d.dailyRows.length !== 3) return false;
  const [r1, r2, fee] = d.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.累計完成數量 !== 1) return false;
  if (r2.項次 !== '2' || r2.單位 !== '盞' || r2.契約數量 !== 10) return false;   // 盞在白名單裡
  if (fee.項次 !== '3' || fee.累計完成數量 !== 0.028) return false;
  if (fee.契約單價 !== null || fee.本日完成金額 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, anchorOf },
};
