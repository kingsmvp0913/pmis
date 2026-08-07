/**
 * huisheng.pmisparser.js — 惠晟工程顧問施工日誌讀取器(光明國中行政大樓外牆與屋頂防水)
 *
 * vendorKey 取自**決標公告的得標廠商**(光明案:惠晟工程顧問股份有限公司)。
 * ⚠️ 日誌 `公共工程施工日誌` r3 欄13 寫的是「惠晟工程顧問 股份有限公司」——
 * **中間多一個空白**。照抄就對不到 vendors 表,故 vendorKey 用決標公告的寫法。
 *
 * ── 版面事實(實測)──
 * .xlsm。`公共工程施工日誌` 只是用公式抓「當前顯示日」的單日列印範本
 * (而且只列出當天有施做的項目),逐日資料全在 `內容` 這張矩陣分頁,**一天一欄**:
 *
 *   r0 欄4=工程名稱   欄10=**當前天序**(= 資料截止在第幾天)  欄11..=天序 1,2,3…
 *   r2 欄4=契約金額
 *   r4 欄11..=累計完成%      r5 欄11..=預定進度%
 *   r6 欄11..=日期序號       r7 欄11..=星期(數字 1=日 … 7=六)
 *   r11 起每列一個項目:欄2=項次 欄3=名稱 欄4=單位 欄5=契約數量 欄6=契約單價,
 *       欄11.. = **本日**完成數量
 *   欄 2 的編號分段:1~499=施工項目、501~599=材料、601~699=工別、701~799=機具
 *
 * ── 三個「看起來有、其實沒有」的欄位 ──
 * ① **逐日天氣讀不到**。r8/r9 的欄 6 雖然標著「上午天氣」「下午天氣」,欄 11.. 放的
 *    卻是 0/1 的篩選旗標(同一列欄 9 是「全部=>」、欄 10 是項目數 144)。
 *    天氣只在單日列印範本上有當天那一個值。一律 null,不拿旗標充數。
 * ② **逐日累計完成數量不存在**。欄 8 的「累計完成」是**整案最終值**(跨天不變),
 *    不是當天的累計。逐日累加本日完成量是推導不是來源值,故 null。
 * ③ **逐項金額不存在**。只有單價;單價 × 數量是推導。
 *
 * ── 資料截止在 r0 欄10 ──
 * 日期欄一路預留到工期末(實測 112 欄),但只有前 N 天有資料,N = r0 欄10。
 * 這家沒有天氣可以拿來判斷「還沒填的天」,截止欄是唯一可靠的信號。
 */

const META_VENDOR_KEY = '惠晟工程顧問股份有限公司';

const SHEET = { 矩陣: '內容', 單日: '公共工程施工日誌' };

const ROW = {
  工程名稱: 0, 契約金額: 2, 累計完成: 4, 預定進度: 5, 日期: 6, 星期: 7, 首項: 11,
};
const COL = { 項次: 2, 名稱: 3, 單位: 4, 契約數量: 5, 契約單價: 6, 首日: 11, 截止: 10 };
// 欄 2 的編號分段
const SEG = { 項目: [1, 499], 材料: [501, 599], 工別: [601, 699], 機具: [701, 799] };

const WEEKDAY = ['', '日', '一', '二', '三', '四', '五', '六'];

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', 'CM', 'MM', 'KG', 'kg',
  '噸', 'T', '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間',
  '天', '日', '趟', '才', '公尺', '公斤', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '張', '盞', '針']);

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' || s === '－' ? null : s;
};

function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

function unitOf(v) {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;
}

/** 星期是數字 1~7(1=日)。轉成與其他讀取器一致的「星期一」形狀。 */
function weekdayOf(v) {
  const n = numOf(v);
  if (n == null || n < 1 || n > 7) return null;
  return `星期${WEEKDAY[n]}`;
}

/** 依欄 2 的編號分段抓出各區的定義列。 */
function rowsInSegment(grid, [lo, hi]) {
  const out = [];
  for (let r = ROW.首項; r < grid.length; r++) {
    const no = numOf(at(grid, r, COL.項次));
    if (no == null || no < lo || no > hi) continue;
    const name = text(at(grid, r, COL.名稱));
    if (name == null) continue;
    out.push({ r, no: String(no), name });
  }
  return out;
}

/**
 * 組一天(純函式;selfTest 重用之)。
 * @param {object} src { grid, items, crew, tools, 工程名稱, 承包廠商, 開工序號 }
 * @param {number} c 該天的欄
 */
function buildDay(src, c, serialToISO) {
  const { grid, items, crew, tools } = src;
  const serial = numOf(at(grid, ROW.日期, c));

  const dailyRows = items.map((it) => ({
    項次: it.no,
    工程項目: it.name,
    單位: unitOf(at(grid, it.r, COL.單位)),
    契約單價: numOf(at(grid, it.r, COL.契約單價)),
    契約數量: numOf(at(grid, it.r, COL.契約數量)),
    本日完成數量: numOf(at(grid, it.r, c)),
    本日完成金額: null,      // 只有單價,單價 × 數量是推導不是來源值
    累計完成數量: null,      // 欄 8 的「累計完成」是整案最終值,不是當天的累計
  }));

  const extras = {};
  let 出工總人數 = null;
  const 出工明細 = crew.map((x) => ({ 工別: x.name, 人數: numOf(at(grid, x.r, c)) }));
  const 主要機具 = tools.map((x) => ({ 名稱: x.name, 數量: numOf(at(grid, x.r, c)) }));
  if (出工明細.length) {
    extras.出工明細 = 出工明細;
    const n = 出工明細.filter((x) => x.人數 != null);
    if (n.length) 出工總人數 = n.reduce((s, x) => s + x.人數, 0);
  }
  if (主要機具.length) extras.主要機具 = 主要機具;

  return {
    header: {
      工程名稱: src.工程名稱,
      填報日期: serial != null && serialToISO ? serialToISO(serial) : null,
      星期: weekdayOf(at(grid, ROW.星期, c)),
      天氣_上午: null,        // 見檔頭①:那兩列的欄 11.. 是篩選旗標不是天氣
      天氣_下午: null,
      預定進度: numOf(at(grid, ROW.預定進度, c)),
      實際進度: numOf(at(grid, ROW.累計完成, c)),
      出工總人數,
      本日累計金額: null,     // 此格式無逐日金額
      承包廠商: src.承包廠商,
      開工日期: src.開工序號 != null && serialToISO ? serialToISO(src.開工序號) : null,
    },
    dailyRows,
    extras,
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const grid = wb.sheets[SHEET.矩陣];
  const one = wb.sheets[SHEET.單日];
  if (!grid || !one) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
    throw new Error(`缺少「${SHEET.矩陣}/${SHEET.單日}」分頁(此檔非惠晟格式,或是無文字層的掃描件)`);
  }

  const items = rowsInSegment(grid, SEG.項目);
  if (!items.length) throw new Error('「內容」分頁裡找不到任何施工項目列');

  // 資料截止在第 N 天(r0 欄10);日期欄一路預留到工期末,不設界會多出一批空白天。
  // 這家沒有逐日天氣可以當「還沒填」的信號,截止欄是唯一可靠的。
  const total = numOf(at(grid, ROW.工程名稱, COL.截止));
  const src = {
    grid, items,
    crew: rowsInSegment(grid, SEG.工別),
    tools: rowsInSegment(grid, SEG.機具),
    工程名稱: text(at(grid, ROW.工程名稱, 4)),
    // 單日範本上的廠商名中間多一個空白(「惠晟工程顧問 股份有限公司」),
    // 去掉空白才與決標公告一致。
    承包廠商: (() => {
      const v = text(at(one, 3, 13));
      return v == null ? null : String(v).replace(/[\s　]/g, '');
    })(),
    開工序號: numOf(at(one, 5, 4)),
  };

  const out = [];
  const width = (grid[ROW.日期] || []).length;
  for (let c = COL.首日; c < width; c++) {
    const serial = numOf(at(grid, ROW.日期, c));
    if (serial == null) break;
    if (total != null && c - COL.首日 >= total) break;
    out.push(buildDay(src, c, ft.excelSerialToISO));
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/** selfTest 用**真實座標**造一份最小矩陣(取自光明前兩天,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  set(0, 3, '工程名稱：'); set(0, 4, '測試工程'); set(0, 10, 2);   // 資料只到第 2 天
  set(2, 3, '契約金額：'); set(2, 4, 2560000);
  set(4, 6, '累計完成%'); set(4, 11, 10.35); set(4, 12, 12.39);
  set(5, 6, '預定進度%'); set(5, 11, 0.14); set(5, 12, 0.28);
  set(6, 6, '日期'); set(6, 10, 46127); set(6, 11, 46076); set(6, 12, 46077); set(6, 13, 46078);
  set(7, 6, '星期'); set(7, 11, 2); set(7, 12, 3); set(7, 13, 4);
  // r8/r9 標著天氣,值卻是 0/1 的篩選旗標 —— 不可拿來當天氣
  set(8, 6, '上午天氣'); set(8, 9, '全部=>'); set(8, 10, 144); set(8, 11, 1); set(8, 12, 1);
  set(9, 6, '下午天氣'); set(9, 9, '區間=>'); set(9, 10, 25); set(9, 11, 1); set(9, 12, 0);
  set(10, 3, '一、重要施工項目完成數量：'); set(10, 4, '單位'); set(10, 5, '契約數量');
  set(10, 6, '契約單價'); set(10, 8, '累計完成'); set(10, 11, '完成數量==>');
  set(11, 2, 1); set(11, 3, '工程告示牌(租用)'); set(11, 4, '面'); set(11, 5, 1);
  set(11, 6, 1899); set(11, 8, 1); set(11, 11, 1);
  set(12, 2, 7); set(12, 3, '施工架(CNS4750)'); set(12, 4, 'M2'); set(12, 5, 821);
  set(12, 6, 475); set(12, 8, 821); set(12, 11, 300); set(12, 12, 95);
  set(13, 2, 140);                                   // 名稱空的預留列
  set(20, 2, 501); set(20, 3, '鋼筋'); set(20, 4, '噸');          // 材料段,不是施工項目
  set(30, 2, 608); set(30, 3, '油漆工'); set(30, 12, 1);
  set(31, 2, 612); set(31, 3, '粗工'); set(31, 11, 3); set(31, 12, 3);
  set(40, 2, 701); set(40, 3, '50型怪手'); set(40, 12, 1);

  const one = [];
  const set1 = (r, c, v) => { (one[r] = one[r] || [])[c] = v; };
  set1(3, 13, '惠晟工程顧問 股份有限公司');            // 中間多一個空白
  set1(5, 4, 46076);

  const items = rowsInSegment(g, SEG.項目);
  if (items.length !== 2) return false;                // 材料/工別/機具段不可混進來
  const src = {
    grid: g, items,
    crew: rowsInSegment(g, SEG.工別), tools: rowsInSegment(g, SEG.機具),
    工程名稱: text(at(g, 0, 4)),
    承包廠商: String(text(at(one, 3, 13))).replace(/[\s　]/g, ''),
    開工序號: numOf(at(one, 5, 4)),
  };
  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d1 = buildDay(src, 11, serial);
  const d2 = buildDay(src, 12, serial);

  if (d1.header.工程名稱 !== '測試工程') return false;
  if (d1.header.承包廠商 !== META_VENDOR_KEY) return false;   // 去空白後要等於決標公告的寫法
  if (serial && d1.header.填報日期 !== '2026-02-23') return false;
  if (serial && d1.header.開工日期 !== '2026-02-23') return false;
  if (d1.header.星期 !== '星期一' || d2.header.星期 !== '星期二') return false;
  if (d1.header.天氣_上午 !== null || d1.header.天氣_下午 !== null) return false;  // 旗標不是天氣
  if (d1.header.預定進度 !== 0.14 || d1.header.實際進度 !== 10.35) return false;
  if (d1.dailyRows.length !== 2) return false;
  const [a1, a2] = d1.dailyRows;
  if (a1.項次 !== '1' || a1.單位 !== '面' || a1.契約單價 !== 1899) return false;
  if (a1.本日完成數量 !== 1) return false;
  if (a2.項次 !== '7' || a2.本日完成數量 !== 300) return false;
  if (d2.dailyRows[1].本日完成數量 !== 95) return false;
  if (a1.累計完成數量 !== null || a1.本日完成金額 !== null) return false;  // 兩者此格式都沒有
  if (d1.header.出工總人數 !== 3) return false;               // 油漆工那天沒填
  if (d2.header.出工總人數 !== 4) return false;
  if (d2.extras.主要機具[0].數量 !== 1) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量', '本日完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { buildDay, rowsInSegment, weekdayOf },
};
