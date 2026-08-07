/**
 * dexin.pmisparser.js — 德信土木包工業施工日誌讀取器(石龜國小漏水改善)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄也是同一個
 * 名稱,兩邊一致。
 *
 * ── 版面事實(實測 2 份 xlsx / 32 天)──
 * 工程會標準表單的單聯版,單一分頁 `工作表1` 由「表報編號：」切成一天一個區塊。
 *   a+1  欄0=天氣(整句「本日天氣：上午：晴 下午：晴」) 欄11「填表日期:」欄13=Excel 序號
 *   a+2  欄3=工程名稱  欄12=承攬廠商名稱
 *   a+4  欄3=開工日期(字串「115年3月30日」)
 *   a+5  欄3=預定進度  欄12=實際進度(**分數**,保留原值不換算)
 *   a+7  明細表頭      a+8 起是明細,到「二、」為止
 * 明細表頭右邊還有三個**表格外**的欄:欄17=單價、欄18=複價、欄19=完成數量*單價。
 * 欄位落點一律由表頭標籤定位(表頭右邊那三欄也是),不寫死。
 *
 * ── 三個坑 ──
 * ① **欄19「完成數量*單價」不是本日完成金額,是累計完成金額**。標籤沒說是哪一個
 *    完成數量,拿算式在整份檔上核對才看得出來:第 20 天項次 1 的本日完成數量是
 *    空的、累計是 1,而欄19 = 50000 = 1 × 50000(若是本日 × 單價應為 0)。
 *    費用項那幾列更明顯(本日 0.02、累計 0.26,欄19 = 0.26 × 單價)。
 *    照標籤收會讓 SP3 的 B3/B4 每天硬錯。**本日完成金額本格式沒有 → null 不回推**
 *    (用「本日數量 × 單價」是推導不是來源值);累計完成金額不在 schema 內。
 * ② **此格式沒有項次欄**,但**每一天都把全部 18 個項目照同一順序列完**(不是只列
 *    當天施作的),所以「排除大類後的出現序」是穩定的位置事實——跨天、跨檔都一致。
 *    實測與發包後經費總表逐項同序:出現序 1~13 = 契約表的 1~13,14~18 則對到費用項
 *    貳~陸(編號體系不同,靠 SP3 的名稱後備索引對應,E1 降為軟警告)。
 * ③ **契約數量欄橫跨欄 5~7,但欄 6 是單位字串**(「式」)、欄 7 是數量的複本。
 *    取合併範圍的第一欄(5)才拿得到數字;取欄 6 會是字串 → null。
 *
 * ── 此格式沒有的東西 ──
 * 沒有星期、沒有日層級的累計金額。材料表實測 32 天全空(程式照收,有才填)。
 * 同案兩份 PDF 與 xlsx 是同一批日子,不另做;PDF 餵給 SheetJS 會回空活頁簿,
 * 那時要 throw 而不是回空陣列。
 */

const META_VENDOR_KEY = '德信土木包工業';

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
  return s === '' || s === '-' || s === '－' ? null : s;
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

/** 民國/西元字串「115年3月30日」→ ISO。 */
function rocTextToISO(v) {
  const m = despace(v).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 在某列找第一個去空白後等於 label 的欄(合併填充後同值連續,取最左)。 */
function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

/** 取 label 右邊第一個「與 label 不同」的非空值。 */
function valueAfter(row, label) {
  const c = colOf(row, label);
  if (c < 0) return null;
  const lab = despace(row[c]);
  for (let i = c + 1; i < row.length; i++) {
    if (despace(row[i]) === lab) continue;
    if (row[i] == null || String(row[i]).trim() === '') continue;
    return row[i];
  }
  return null;
}

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid `工作表1`
 * @param {number} a 錨點列
 * @param {number} end 下一個錨點列(或分頁末)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };

  const wr = rowWith(/^本日天氣/);
  const wt = wr < 0 ? '' : nfkc(at(grid, wr, 0));
  const am = wt.match(/上午[:：]\s*(\S+?)(?=\s|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=\s|$)/);
  const serial = wr < 0 ? null : num(valueAfter(grid[wr], '填表日期:'));
  const 填報日期 = serial != null && serialToISO ? serialToISO(serial) : null;

  const nr = rowWith(/^工程名稱$/);
  const pr = rowWith(/^預定進度/);
  const sr = rowWith(/^開工日期$/);

  const hr = rowWith(/^施工項目$/);
  const dailyRows = [];
  if (hr >= 0) {
    const hdr = grid[hr];
    const c單位 = colOf(hdr, '單位');
    const c契約 = colOf(hdr, '契約數量');          // 合併 5~7,取最左才是數字(見檔頭③)
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    const c單價 = colOf(hdr, '單價');              // 表格右外側
    if ([c單位, c契約, c本日, c累計].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非德信格式?)');
    }
    let seq = 0;
    for (let r = hr + 1; r < end; r++) {
      const name = text(at(grid, r, 0));
      if (name != null && SECTION.test(name)) break;
      if (name == null || SKIP_ROW.test(name)) continue;
      seq += 1;                                    // 此格式無項次欄,用出現序(見檔頭②)
      dailyRows.push({
        項次: String(seq),
        工程項目: name,
        單位: unitOf(at(grid, r, c單位)),
        契約單價: c單價 < 0 ? null : num(at(grid, r, c單價)),
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                        // 欄19 是累計金額不是本日,見檔頭①
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
      const n = num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = text(at(grid, r, c機具));
      const gn = num(at(grid, r, c機數));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }
  const mr = rowWith(/^材料名稱$/);
  if (mr >= 0) {
    const hdr = grid[mr];
    const c單位 = colOf(hdr, '單位');
    const c本日 = colOf(hdr, '本日使用數量');
    const 主要材料 = [];
    for (let r = mr + 1; r < end; r++) {
      const n = text(at(grid, r, 0));
      if (n != null && SECTION.test(n)) break;
      if (n == null || SKIP_ROW.test(n)) continue;
      主要材料.push({ 名稱: n, 單位: unitOf(at(grid, r, c單位)), 數量: num(at(grid, r, c本日)) });
    }
    if (主要材料.length) extras.主要材料 = 主要材料;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱')),
      填報日期,
      星期: null,                                  // 此格式不提供
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      // 進度是分數(0.0079 = 0.79%),保留原值:Excel 系讀取器的既有慣例,
      // 換算成百分數會撞上 SP3 的 H1(值 <= 1 就當分數)而每天噴假警報。
      預定進度: pr < 0 ? null : num(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : num(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                          // 此格式無日層級合計
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : rocTextToISO(valueAfter(grid[sr], '開工日期')),
    },
    dailyRows,
    extras,
  };
}

function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < (grid || []).length; r++) if (despace(at(grid, r, 0)) === ANCHOR) out.push(r);
  return out;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const days = [];
  for (const name of Object.keys((wb && wb.sheets) || {})) {
    const grid = wb.sheets[name];
    const starts = blockStarts(grid);
    for (let i = 0; i < starts.length; i++) {
      days.push(parseDay(grid, starts[i], i + 1 < starts.length ? starts[i + 1] : grid.length, ft.excelSerialToISO));
    }
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過(PDF 餵給 SheetJS 就是走到這裡)。
  if (!days.length) throw new Error('找不到「表報編號」區塊(此檔非德信日誌,或是 PDF/掃描件)');
  const filled = days.filter((d) => d.header.填報日期 != null || d.dailyRows.length > 0);
  // 工程會標準表單很多家在用,錨點會碰巧命中別家的檔:讀得出天數卻一天都沒有日期。
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填表日期(此檔錨點雖然對上,版面不是德信的)');
  }
  return filled.sort((x, y) => String(x.header.填報日期).localeCompare(String(y.header.填報日期)));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造一天(取自 `石龜施工日誌.xlsx` 第 20 天,只換工程名稱)。
 * 挑第 20 天是因為它是唯一驗得到「欄19 是累計金額不是本日金額」的形狀:
 * 本日完成數量空著、累計有值,而欄19 等於累計 × 單價。
 */
function selfTest(ft) {
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  set(0, 0, 15, '公共工程施工日誌');
  set(1, 0, 0, '表報編號：  '); set(1, 1, 1, 20);
  set(2, 0, 0, '本日天氣：上午：晴 下午：陰');
  set(2, 11, 12, '填表日期:'); set(2, 13, 15, 46130);
  set(3, 0, 2, '工程名稱'); set(3, 3, 8, '測試工程');
  set(3, 9, 11, '承攬廠商名稱'); set(3, 12, 15, META_VENDOR_KEY);
  set(4, 0, 0, '核定工期'); set(4, 1, 1, 50); set(4, 2, 2, '工作天');
  set(5, 0, 2, '開工日期'); set(5, 3, 8, '115年3月30日');
  set(5, 9, 11, '完工日期'); set(5, 12, 15, '115年5月18日');
  set(6, 0, 2, '預定進度(%)'); set(6, 3, 8, 0.00786);
  set(6, 9, 11, '實際進度(%)'); set(6, 12, 15, 0.027465862202147067);
  set(7, 0, 15, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
  set(8, 0, 3, '施工項目'); set(8, 4, 4, '單位'); set(8, 5, 7, '契約數量');
  set(8, 8, 10, '本日完成數量'); set(8, 11, 12, '累計完成數量'); set(8, 13, 15, '備註');
  set(8, 17, 17, '單價'); set(8, 18, 18, '複價'); set(8, 19, 19, '完成數量*單價');
  // 第 1 列:本日空著、累計 1 —— 欄19 = 50000 = 累計 × 單價(不是本日 × 單價)
  set(9, 0, 3, '工程告示牌、交通管制與防護措施(租用)'); set(9, 4, 4, '式');
  set(9, 5, 5, 1); set(9, 6, 6, '式'); set(9, 7, 7, 1);
  set(9, 11, 12, 1); set(9, 17, 18, 50000); set(9, 19, 19, 50000);
  // 第 2 列:本日 110、累計 110
  set(10, 0, 3, '包角收邊與防水處理(鍍鋅SMP烤漆鋼板，0.5t)'); set(10, 4, 4, 'M');
  set(10, 5, 5, 212); set(10, 6, 6, 'M'); set(10, 7, 7, 212);
  set(10, 8, 10, 110); set(10, 11, 12, 110); set(10, 17, 17, 400); set(10, 18, 18, 84800);
  set(10, 19, 19, 44000);
  // 費用項:本日 0.02、累計 0.26 —— 欄19 = 0.26 × 17490
  set(11, 0, 3, '職業安全衛生管理費（壹*1%）'); set(11, 4, 4, '式');
  set(11, 5, 5, 1); set(11, 6, 6, '式'); set(11, 7, 7, 1);
  set(11, 8, 10, 0.02); set(11, 11, 12, 0.26); set(11, 17, 18, 17490); set(11, 19, 19, 4547.4);
  set(12, 0, 15, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
  set(13, 0, 3, '材料名稱'); set(13, 4, 4, '單位'); set(13, 5, 7, '契約數量');
  set(13, 8, 10, '本日使用數量'); set(13, 11, 12, '累計使用數量'); set(13, 13, 15, '備註');
  set(14, 0, 15, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  set(15, 0, 1, '工別'); set(15, 2, 5, '本日人數'); set(15, 6, 9, '累計人數');
  set(15, 10, 12, '機具名稱'); set(15, 13, 13, '本日使用數量'); set(15, 14, 15, '累計使用數量');
  set(16, 0, 1, '大工'); set(16, 2, 9, 1);
  set(17, 0, 1, '小工'); set(17, 2, 9, 1);
  set(18, 0, 15, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseDay(g, 1, g.length, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d.header.開工日期 !== '2026-03-30') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 0.00786) return false;          // 分數保留原值
  if (d.header.出工總人數 !== 2) return false;
  if (d.dailyRows.length !== 3) return false;
  const [r1, r2, fee] = d.dailyRows;
  // 出現序當項次(此格式沒有項次欄),與發包後經費總表逐項同序
  if (r1.項次 !== '1' || r2.項次 !== '2' || fee.項次 !== '3') return false;
  // 契約數量在合併範圍的最左欄;取欄 6 會拿到單位字串「式」而變 null
  if (r1.契約數量 !== 1 || r1.單位 !== '式' || r1.契約單價 !== 50000) return false;
  if (r1.本日完成數量 !== null || r1.累計完成數量 !== 1) return false;
  // 欄19(完成數量*單價)是累計金額,不可收成本日完成金額
  if (r1.本日完成金額 !== null || r2.本日完成金額 !== null || fee.本日完成金額 !== null) return false;
  if (r2.本日完成數量 !== 110 || r2.契約單價 !== 400) return false;
  if (fee.本日完成數量 !== 0.02 || fee.累計完成數量 !== 0.26) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, blockStarts },
};
