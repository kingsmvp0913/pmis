/**
 * youhe.pmisparser.js — 優和建設有限公司施工日誌讀取器(台西國中活動中心舞台整修)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄也是同一個
 * 名稱,兩邊一致。
 *
 * ── 版面事實(實測 2 份 / 45 個日分頁)──
 * 工程會標準表單的單聯版,**一天一個分頁**(分頁名 `1`~`31`、`1101`~`1114`),
 * 錨點是欄 0 去空白後等於「表報編號：」。
 *   a+1  欄0「本日天氣」欄1「上午」欄2=值 欄3「下午」欄4=值 欄7「日期：」欄8=Excel 序號
 *   a+2  欄1=工程名稱  欄10=承攬廠商名稱
 *   a+4  欄3=開工日期(序號)
 *   a+5  預定/實際進度(**分數**,保留原值)
 *   a+7  明細表頭      a+8 起是明細,到「營造業專業工程特定施工項目」或「二、」為止
 *
 * ⚠️ **這家的明細只有「工程項目」一欄有東西**:45 天、27 個相異名稱,
 * **單位/契約數量/本日完成數量/累計完成數量整份全空**(實測 0 個有數值的列)。
 * 那些列因此都符合 `isCategoryRow`(無單位、無單價、無數量),SP3 會整列略過,
 * 每日施工紀錄也寫不出任何數量。**這是來源就沒有,不是讀取器讀不到**——
 * 交付時要講清楚:這家能提供的只有日期、天氣、進度與出工人數。
 * 名稱仍照收(它是那天做了什麼的唯一紀錄),但不硬湊數量。
 *
 * ── 一個坑 ──
 * **名稱欄橫跨欄 0~3,但欄 0 與欄 1~3 是兩個不同的儲存格**(不是一個合併區):
 * 欄 0 放的是簡稱、欄 1~3 放的是完整敘述(「拆除清運既有舞台布幕」vs
 * 「拆除清運既有舞台布幕，既有舞台鋼構架除鏽上漆」)。只讀欄 0 會少掉後半段。
 * 取那一段裡**最長的那個相異值**(短的是長的前綴)。
 */

const META_VENDOR_KEY = '優和建設有限公司';

const ANCHOR = '表報編號:';          // despace 會做 NFKC,全形冒號折成半形
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
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

/** 名稱欄橫跨數欄且欄 0 與其餘欄是兩個儲存格:取最長的那個相異值(見檔頭)。 */
function longestIn(row, from, to) {
  let best = null;
  for (let c = from; c < to; c++) {
    const s = text((row || [])[c]);
    if (s && (!best || s.length > best.length)) best = s;
  }
  return best;
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

  const wr = rowWith(/^本日天氣$/);
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
      throw new Error('明細表頭欄位找不到(非優和格式?)');
    }
    for (let r = hr + 1; r < end; r++) {
      const name = longestIn(grid[r], 0, c單位);
      if (name != null && SECTION.test(name)) break;
      if (name == null || SKIP_ROW.test(name)) continue;
      dailyRows.push({
        // 此格式沒有項次欄,而且逐日只寫當天做了什麼 —— 名稱是唯一的識別
        項次: name,
        工程項目: name,
        單位: unitOf(at(grid, r, c單位)),
        契約單價: null,                                  // 此格式無單價
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                              // 此格式無金額
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
    const c機數 = colOf(hdr, '本日使用數量');
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = cr + 1; r < end; r++) {
      const w = text(at(grid, r, 0));
      if (w != null && SECTION.test(w)) break;
      const n = c人數 < 0 ? null : num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = c機具 < 0 ? null : text(at(grid, r, c機具));
      const gn = c機數 < 0 ? null : num(at(grid, r, c機數));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : longestIn(grid[nr], 1, 8),
      填報日期: wr < 0 ? null : iso(valueAfter(grid[wr], '日期:')),
      星期: null,                                        // 此格式不提供
      天氣_上午: wr < 0 ? null : text(valueAfter(grid[wr], '上午')),
      天氣_下午: wr < 0 ? null : text(valueAfter(grid[wr], '下午')),
      // 進度保留來源的分數(Excel 系讀取器的既有慣例)
      預定進度: pr < 0 ? null : num(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : num(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                                // 此格式無金額
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : iso(valueAfter(grid[sr], '開工日期')),
    },
    dailyRows,
    extras,
  };
}

/** 一天一分頁:回該分頁的錨點列,找不到就不是日分頁。 */
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
  if (!days.length) throw new Error('找不到「表報編號」日分頁(此檔非優和格式,或是掃描件)');
  const filled = days.filter((d) => d.header.填報日期 != null || d.dailyRows.length > 0);
  // 工程會標準表單很多家在用,錨點會碰巧命中別家的檔。
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到日期(此檔錨點雖然對上,版面不是優和的)');
  }
  // 兩份檔的日分頁會重疊,同一份裡也可能有同日期的複本:依日期去重、保留明細多的那份
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

/** selfTest 用**真實儲存格**(取自 `…-1103.xls` 的日分頁,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const put = (r, c, v) => { g[r] = g[r] || []; g[r][c] = v; };
  const span = (r, from, to, v) => { for (let c = from; c <= to; c++) put(r, c, v); };
  put(1, 0, '表報編號：'); put(1, 1, 'A1141004');
  put(2, 0, '本日天氣'); put(2, 1, '上午'); put(2, 2, '晴'); put(2, 3, '下午'); put(2, 4, '陰');
  put(2, 7, '日期：'); span(2, 8, 11, 45934);
  put(3, 0, '工程名稱'); span(3, 1, 7, '測試工程');
  span(3, 8, 9, '承攬廠商名稱'); span(3, 10, 12, META_VENDOR_KEY);
  put(4, 0, '契約工期'); span(4, 1, 2, 60);
  span(5, 0, 2, '開工日期'); span(5, 3, 6, 45931);
  span(5, 7, 9, '完工日期'); span(5, 10, 12, 45991);
  span(6, 0, 2, '預定進度(%)'); span(6, 3, 6, 0.06666666666666667);
  span(6, 7, 9, '實際進度(%)'); span(6, 10, 12, 0.10709286364686536);
  span(7, 0, 12, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
  span(8, 0, 3, '施工項目'); put(8, 4, '單位'); span(8, 5, 6, '契約數量');
  span(8, 7, 8, '本日完成數量'); span(8, 9, 10, '累計完成數量'); span(8, 11, 12, '備註');
  // 欄 0 是簡稱、欄 1~3 是完整敘述(兩個不同的儲存格)
  span(9, 0, 3, '拆除側面下方櫃體板材');
  put(10, 0, '拆除清運既有舞台布幕');
  span(10, 1, 3, '拆除清運既有舞台布幕，既有舞台鋼構架除鏽上漆');
  span(15, 0, 3, '營造業專業工程特定施工項目');
  span(16, 0, 3, 'A.'); span(17, 0, 3, 'B.');
  span(18, 0, 12, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
  span(19, 0, 3, '材料名稱'); put(19, 4, '單位'); span(19, 5, 6, '契約數量');
  span(19, 7, 8, '本日使用數量'); span(19, 9, 10, '累計使用數量'); span(19, 11, 12, '備註');
  span(25, 0, 12, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  span(26, 0, 1, '工別'); span(26, 2, 3, '本日人數'); span(26, 4, 6, '累計人數');
  span(26, 7, 8, '機具名稱'); span(26, 9, 10, '本日使用數量'); span(26, 11, 12, '累計使用數量');
  span(27, 0, 1, '工程師');
  span(28, 0, 1, '大工'); span(28, 2, 3, 1); span(28, 4, 6, 44);
  span(29, 0, 1, '小工'); span(29, 2, 3, 2); span(29, 4, 6, 57);
  span(32, 0, 12, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseDay(g, 1, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2025-10-04') return false;
  if (serial && d.header.開工日期 !== '2025-10-01') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 0.06666666666666667) return false;   // 分數保留原值
  if (d.header.出工總人數 !== 3) return false;                    // 累計 44/57 不可混進來
  if (d.extras.出工明細.length !== 2) return false;               // 沒填人數的工程師不列
  if (d.dailyRows.length !== 2) return false;                     // A./B. 標籤不算明細
  // 欄 0 只有簡稱,完整敘述在欄 1~3:取最長的那個
  if (d.dailyRows[1].工程項目 !== '拆除清運既有舞台布幕,既有舞台鋼構架除鏽上漆') return false;
  if (d.dailyRows[1].項次 !== d.dailyRows[1].工程項目) return false;
  // 這家的明細只有名稱,數量欄整份都是空的
  for (const r of d.dailyRows) {
    if (r.單位 !== null || r.契約數量 !== null || r.本日完成數量 !== null) return false;
    if (r.契約單價 !== null || r.本日完成金額 !== null) return false;
  }
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, anchorOf, longestIn },
};
