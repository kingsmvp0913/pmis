/**
 * jingwei.pmisparser.js — 經緯營造施工日誌讀取器(龍井國小新建綜合球場)
 *
 * vendorKey 取自**決標公告的得標廠商**(龍井球場案:經緯營造股份有限公司),
 * 日誌 a+1 欄 15 的「承攬廠商名稱」也載明同一個名稱,兩邊一致。
 *
 * ── 版面事實(實測)──
 * .xls 單一分頁 `Sheet1`,一天一區塊垂直堆疊(實測間距 51 列,但以錨點偵測不寫死)。
 * 錨點:欄 0 以「本日天氣」開頭——**天氣的標籤與值黏在同一格**(「本日天氣：上午：晴」),
 * 這也是全份唯一穩定的區塊起點。
 *
 * 相對錨點列 a:
 *   a+0  欄0=「本日天氣：上午：X」 欄4=「下午：X」 欄16/18/20=民國年/月/日(三個獨立的格)
 *   a+1  欄1=工程名稱  欄15=承攬廠商名稱
 *   a+3  欄1=開工日期(Excel 序號)
 *   a+4  欄1=預定進度  欄18=累計實際進度
 *   a+6  明細表頭      a+7 起是明細,到欄 0 的「營造業專業工程特定施工項目」為止
 *
 * ── 數值欄要「往右掃到第一個數字」,不能只讀合併起點欄 ──
 * 表頭的「契約數量」橫跨欄 7~9、「本日完成數量」跨 10~12、「累計完成數量」跨 13~16,
 * 但**每一列的合併範圍不一樣**:項次 1 那列欄 8 是「面」(單位跨進來了)、
 * 項次 11 那列欄 8 卻是 5(數量)。只認合併起點欄會在某些列讀到單位字串,
 * numOf 把它變成 null——列還在、名稱也對,看起來就像廠商漏填。
 *
 * ── 沒有的欄位就留 null ──
 * 此格式**沒有項次欄、沒有契約單價、沒有任何金額**。項次以「出現序」補
 * (與長澤同一個理由:那是位置事實);單價與金額一律 null,不由別處回推。
 */

const META_VENDOR_KEY = '經緯營造股份有限公司';

const SHEET = 'Sheet1';
const ANCHOR_PREFIX = '本日天氣';
const END_MARK = '營造業專業工程特定施工項目';

const OFF = { 名稱: 1, 開工: 3, 進度: 4, 表頭: 6 };

// 各欄的**掃描範圍**(合併範圍逐列不同,見檔頭)
const SPAN = {
  單位: [6, 6],
  契約數量: [7, 9],
  本日完成數量: [10, 12],
  累計完成數量: [13, 16],
};

// 單位一律走白名單:名稱裡的 RC/PVC/AC/PU 這類縮寫會被任何「大寫字母」規則誤判
// (金大踩過,整列錯位且沒有錯誤訊息)。
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間', '天', '日', '趟',
  '公尺', '公斤', '台', '套', '包', '車', '批']);

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

/** 在 [from,to] 這段裡取第一個數字;整段都不是數字回 null。 */
function numInSpan(grid, r, [from, to]) {
  for (let c = from; c <= to; c++) {
    const n = numOf(at(grid, r, c));
    if (n != null) return n;
  }
  return null;
}

/** 單位:白名單比對,不在字典裡就是 null(讓完整性關卡看得見)。 */
function unitOf(grid, r) {
  const v = text(at(grid, r, SPAN.單位[0]));
  if (v == null) return null;
  const s = String(v).normalize('NFKC').trim();
  return KNOWN_UNITS.has(s) ? s : null;
}

/** 「本日天氣：上午：晴」/「下午：晴」→ 取冒號後的值。 */
function weatherOf(v) {
  const s = v == null ? '' : String(v).replace(/[\s　]/g, '');
  const m = /(?:上午|下午)[:：](.*)$/.exec(s);
  return text(m ? m[1] : null);
}

/** 民國年/月/日三個獨立的格 → 'YYYY-MM-DD'。 */
function rocParts(y, m, d) {
  const yy = numOf(y); const mm = numOf(m); const dd = numOf(d);
  if (yy == null || mm == null || dd == null) return null;
  const year = yy < 1911 ? yy + 1911 : yy;
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(mm)}-${p(dd)}`;
}

/**
 * 解析一天區塊(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid
 * @param {number} a 錨點列
 * @param {number} end 下一個錨點列(或 grid 尾)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseBlock(grid, a, end, serialToISO) {
  const dailyRows = [];
  let seq = 0;
  for (let r = a + OFF.表頭 + 1; r < end; r++) {
    const 工程項目 = text(at(grid, r, 0));
    if (工程項目 == null) break;
    if (工程項目 === END_MARK) break;
    const 單位 = unitOf(grid, r);
    const 契約數量 = numInSpan(grid, r, SPAN.契約數量);
    const isCategory = 單位 == null && 契約數量 == null;
    if (!isCategory) seq++;
    dailyRows.push({
      // 此格式沒有項次欄;以「排除大類後的出現序」補(位置事實,不是推導數值)。
      項次: isCategory ? null : String(seq),
      工程項目,
      單位,
      契約單價: null,          // 此格式無單價
      契約數量,
      本日完成數量: numInSpan(grid, r, SPAN.本日完成數量),
      本日完成金額: null,      // 此格式無金額,不由別處回推
      累計完成數量: numInSpan(grid, r, SPAN.累計完成數量),
    });
  }

  // 出工/機具:表頭在「工 別」那列,本日人數在欄 2~3、累計在欄 4~6;
  // 沒出工時廠商只填累計那一欄,取錯欄會讓出工總人數整份偏高。
  const extras = {};
  let 出工總人數 = null;
  let crewRow = -1;
  for (let r = a + OFF.表頭; r < end; r++) {
    if (String(text(at(grid, r, 0)) || '').replace(/\s/g, '') === '工別') { crewRow = r; break; }
  }
  if (crewRow >= 0) {
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = crewRow + 1; r < end; r++) {
      const 工別 = text(at(grid, r, 0));
      if (工別 != null && /^[一二三四五六七八]、/.test(工別)) break;
      const 機具 = text(at(grid, r, 7));
      if (工別 != null) 出工明細.push({ 工別, 人數: numInSpan(grid, r, [2, 3]) });
      if (機具 != null) 主要機具.push({ 名稱: 機具, 數量: numInSpan(grid, r, [12, 14]) });
      if (工別 == null && 機具 == null) continue;
    }
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: text(at(grid, a + OFF.名稱, 1)),
      填報日期: rocParts(at(grid, a, 16), at(grid, a, 18), at(grid, a, 20)),
      星期: null,                                     // 此格式不提供
      天氣_上午: weatherOf(at(grid, a, 0)),
      天氣_下午: weatherOf(at(grid, a, 4)),
      預定進度: numOf(at(grid, a + OFF.進度, 1)),
      實際進度: numOf(at(grid, a + OFF.進度, 18)),
      出工總人數,
      本日累計金額: null,                              // 此格式無金額
      承包廠商: text(at(grid, a + OFF.名稱, 15)),
      開工日期: serialToISO ? serialToISO(numOf(at(grid, a + OFF.開工, 1))) : null,
    },
    dailyRows,
    extras,
  };
}

function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const v = text(at(grid, r, 0));
    if (v != null && String(v).startsWith(ANCHOR_PREFIX)) out.push(r);
  }
  return out;
}

/**
 * 「還沒填的天」判定:整個工期的區塊一次建好,檔尾有一批只剩範本的空區塊。
 * **只憑「沒日期」丟掉是危險的**——有資料卻讀不到日期時會靜默少一天,
 * 故要求整天也沒有任何本日完成量。
 */
function isUnfilled(day) {
  if (day.header.填報日期 != null) return false;
  const blank = (v) => v == null || v === 0;
  return (day.dailyRows || []).every((r) => blank(r.本日完成數量));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const grid = wb.sheets[SHEET];
  const starts = grid ? blockStarts(grid) : [];
  if (!starts.length) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過,那是最糟的失敗方式。
    throw new Error(`找不到「${ANCHOR_PREFIX}」天區塊(此檔非經緯格式)`);
  }
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : grid.length;
    const day = parseBlock(grid, starts[i], end, ft.excelSerialToISO);
    if (isUnfilled(day)) continue;
    out.push(day);
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造一個最小區塊(取自龍井第一天,只換工程名稱)。
 * 要驗的是兩件最容易寫錯的事:數值欄要往右掃到第一個數字(合併範圍逐列不同),
 * 以及天氣的標籤與值黏在同一格。
 */
function selfTest(ft) {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  set(0, 0, '本日天氣：上午：晴'); set(0, 4, '下午：陰');
  set(0, 13, '填報日期：'); set(0, 16, 114); set(0, 18, 2); set(0, 20, 26);
  set(1, 0, '工程名稱'); set(1, 1, '測試工程'); set(1, 15, META_VENDOR_KEY);
  set(3, 0, '開工日期  '); set(3, 1, 45714);
  set(4, 0, '預定進度'); set(4, 1, 0.00391); set(4, 18, 0.0123);
  set(6, 0, '施 工 項 目'); set(6, 6, '單位'); set(6, 7, '契約數量');
  set(6, 10, '本日完成數量'); set(6, 13, '累計完成數量');
  // 項次 1:欄 8 是「面」(單位跨進了契約數量的合併範圍),只讀欄 8 會讀到字串
  set(7, 0, '工程告示牌(租用)'); set(7, 6, '面'); set(7, 7, 1); set(7, 8, '面'); set(7, 9, 1);
  set(7, 13, 0); set(7, 14, 0);
  // 項次 2:同一個欄 8 這次是數量
  set(8, 0, '鋪設3mm壓克力球場面層'); set(8, 6, '場'); set(8, 7, 5); set(8, 8, 5); set(8, 9, 5);
  set(8, 10, 2); set(8, 13, 3);
  set(9, 0, END_MARK);
  set(11, 0, '工 別'); set(11, 2, '本日人數'); set(11, 4, '累計人數'); set(11, 7, '機 具 名 稱');
  set(11, 12, '本日使用數量'); set(11, 15, '累計使用數量');
  set(12, 0, '技工'); set(12, 4, 3); set(12, 7, '挖土機'); set(12, 15, 0);   // 只有累計 → 本日 null
  set(13, 0, '普通工'); set(13, 2, 4); set(13, 4, 9);
  set(14, 0, '四、本日施工項目是否有須依');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseBlock(g, 0, g.length, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d.header.填報日期 !== '2025-02-26') return false;          // 民國年/月/日三個獨立的格
  if (serial && d.header.開工日期 !== '2025-02-26') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 0.00391 || d.header.實際進度 !== 0.0123) return false;
  if (d.dailyRows.length !== 2) return false;
  const [r1, r2] = d.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== '面') return false;
  if (r1.契約數量 !== 1) return false;                           // 欄 8 的「面」不可讓它變 null
  if (r1.本日完成數量 !== null || r1.累計完成數量 !== 0) return false;
  if (r2.項次 !== '2' || r2.契約數量 !== 5) return false;
  if (r2.本日完成數量 !== 2 || r2.累計完成數量 !== 3) return false;
  if (r2.契約單價 !== null || r2.本日完成金額 !== null) return false;  // 此格式無單價與金額
  if (d.header.出工總人數 !== 4) return false;                   // 技工只有累計欄,不計
  if (d.extras.出工明細.find((c) => c.工別 === '技工').人數 !== null) return false;
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
  _internal: { parseBlock, blockStarts, numInSpan, unitOf, weatherOf, rocParts },
};
