/**
 * ruiqi.pmisparser.js — 瑞騏建築經理有限公司施工日誌讀取器
 * (115 年度補助基層運動選手訓練站-改善訓練環境及器材設備)
 *
 * vendorKey 取自日誌每一天的「承攬廠商名稱」欄,與使用者提供檔名前綴「(瑞騏建築經理有限公司)」
 * 一致。⚠️ 尚未拿決標公告的得標廠商核對過;若名稱不同要改 META_VENDOR_KEY,
 * 否則讀取器永遠不會被叫到(見 gen-vendor-parser skill 第 1 點)。
 *
 * ── 版面:工程會標準表單「單聯」,一頁一天 ──
 * 只有「施工項目 / 單位 / 契約數量 / 本日數量 / 累計數量 / 備註」六欄,
 * **沒有項次欄、沒有單價也沒有任何金額**。
 *
 * ── 項次用「出現序」──
 * 每一天都把 18 項(13 施工 + 5 費用)照同一順序印完(26 頁每頁都是 18 列),
 * 不是只列當天施作的,所以出現序是穩定的位置事實(先例:以勒、德信)。
 * 費用項(職安、品管、管理費、保險、營業稅)也是 14~18,靠 SP3 的名稱後備索引對應。
 *
 * ── 欄位一律由表頭推,不寫死 x ──
 * 同一份檔裡第 17 頁整張表右移 ~30pt、表格寬度也縮了(表頭「單位」x304→284),
 * 寫死 x 會讓那天的單位與數值整排落空。數值歸欄用「最近的表頭中心」:
 * 契約數量有的靠右(1.00 c382)有的置中(c362),兩者都離「契約數量」表頭中心最近。
 *
 * ── 跨行名稱:第一行與單位同帶,續行在下面 ──
 * 「沙灘排球場圍網整建(安裝獨立基礎…配合地形施」y574.3、單位 M2 y572.4、
 * 續行「做三種高網 H95cm/H110cm/H125cm)」y562.0 自己一帶、沒有單位也沒有數值。
 * 續行要接到**上面**那一列;只看「離哪一列最近」會在列距 11 的表裡誤判
 * (562.0 離上一列 10.4、離下一列 11.2,差不到 1pt)。
 * 第 17 頁的換行位置不同(「…透空網,」/「配合地形施做…」),規則一樣。
 *
 * ── 工地人員/機具表:值靠左印在欄內,用「最近的表頭起點」歸欄 ──
 * 第 1 頁本日人數值 x91、表頭 x82;累計人數值 x149、表頭 x142;
 * 機具累計值 x449、表頭「累計數量」x455。用區間法 449 會落到「本日數量」。
 *
 * ── 照收不修的來源事實 ──
 * 「職業安全維生管理費」(錯字)、費用項累計印的是比例(0.06480)、
 * 「營造綜合保險費」累計 1.00、進度是百分數(5.96%)——一律照收,由 SP3 判斷。
 */

const META_VENDOR_KEY = '瑞騏建築經理有限公司';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人', '盞']);

// 同一列的名稱/單位/數值 y 差實測 ≤1.9(574.3 vs 572.4);列距 ≥11。
const ROW_TOL = 4;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || /^-+$/.test(s) || s === '－' ? null : s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

const pad2 = (n) => String(Number(n)).padStart(2, '0');

/** 「115年10月1日 (星期四)」→ { iso, 星期 } */
function rocDate(s) {
  const t = despace(s);
  const m = t.match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const w = t.match(/星期([一二三四五六日天])/);
  return { iso: `${Number(m[1]) + 1911}-${pad2(m[2])}-${pad2(m[3])}`, 星期: w ? w[1] : null };
}

/** 「2026/9/18」→ ISO */
function slashDate(s) {
  const m = despace(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : null;
}

const centerOf = (it) => it.x + it.w / 2;
const sameLine = (a, b, tol = 3) => Math.abs(a.y - b.y) <= tol;

/** 同一行、在 label 右邊的 item(依 x 排序);可給右界。 */
function rightOf(items, label, rightBound = Infinity) {
  return items
    .filter((it) => it !== label && sameLine(it, label) && it.x >= label.x + label.w - 1
      && it.x < rightBound)
    .sort((a, b) => a.x - b.x);
}

const find = (items, re) => items.find((it) => re.test(despace(it.s)));

function nearestKey(cols, x) {
  let best = null;
  let bestD = Infinity;
  for (const [k, c] of Object.entries(cols)) {
    const d = Math.abs(c - x);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

const TABLE_COLS = { 單位: '單位', 契約數量: '契約數量', 本日完成數量: '本日數量', 累計完成數量: '累計數量', 備註: '備註' };

/** 明細表:表頭帶 → 名稱/單位/數值。 */
function parseItemsTable(items) {
  const head = items.find((it) => despace(it.s) === '施工項目');
  if (!head) return null;
  const cols = {};
  for (const [k, label] of Object.entries(TABLE_COLS)) {
    const h = items.find((it) => despace(it.s) === label && sameLine(it, head));
    if (h) cols[k] = centerOf(h);
  }
  if (cols.單位 == null || cols.契約數量 == null || cols.本日完成數量 == null || cols.累計完成數量 == null) return null;
  const end = items.find((it) => /^二、工地材料/.test(despace(it.s)) && it.y < head.y);
  const floor = end ? end.y + 3 : -Infinity;
  const body = items.filter((it) => it.y < head.y - 3 && it.y > floor);

  // 名稱區右界:「施工項目」與「單位」兩個表頭中心的中點。名稱 item 很長
  // (第 17 頁有一筆一路長到 x305,越過單位表頭起點),所以一律用中心判斷。
  const nameRight = (centerOf(head) + cols.單位) / 2;
  const isUnit = (it) => unitOf(it.s) && nearestKey(cols, centerOf(it)) === '單位';
  const isValue = (it) => num(it.s) != null && centerOf(it) > nameRight;

  // 每一列由「單位」定錨(18 項每一列都有單位)
  const rows = body.filter(isUnit).sort((a, b) => b.y - a.y).map((u) => ({
    y: u.y, 單位: unitOf(u.s), names: [], 契約數量: null, 本日完成數量: null, 累計完成數量: null,
  }));
  if (!rows.length) return [];

  const rowAt = (it) => {
    let best = null;
    for (const r of rows) {
      if (Math.abs(r.y - it.y) <= ROW_TOL && (!best || Math.abs(r.y - it.y) < Math.abs(best.y - it.y))) best = r;
    }
    return best;
  };

  for (const it of body) {
    if (isUnit(it)) continue;
    if (isValue(it)) {
      const r = rowAt(it);
      const k = nearestKey(cols, centerOf(it));
      if (r && k && k !== '單位' && k !== '備註' && r[k] == null) r[k] = num(it.s);
      continue;
    }
    if (centerOf(it) >= nameRight) continue;
    // 名稱:同帶就是自己那列;否則是**上面那一列**的續行(見檔頭)
    let r = rowAt(it);
    if (!r) r = rows.filter((x) => x.y > it.y).pop() || null;
    if (r) r.names.push(it);
  }

  let seq = 0;
  return rows.map((r) => {
    seq += 1;                                            // 此格式無項次欄,用出現序(見檔頭)
    const 工程項目 = text(r.names.sort((a, b) => b.y - a.y || a.x - b.x).map((it) => it.s).join(''));
    return {
      項次: String(seq), 工程項目, 單位: r.單位,
      契約單價: null, 契約數量: r.契約數量,
      本日完成數量: r.本日完成數量, 本日完成金額: null, 累計完成數量: r.累計完成數量,
    };
  });
}

/** 工地人員/機具表:值靠左印,用「最近的表頭起點」歸欄。 */
function parseCrew(items) {
  const h = items.find((it) => despace(it.s) === '工別');
  if (!h) return { 出工明細: [], 主要機具: [] };
  const lab = (s) => items.find((it) => despace(it.s) === s && sameLine(it, h));
  const 本日人數 = lab('本日人數'); const 累計人數 = lab('累計人數');
  const 機具名稱 = lab('機具名稱'); const 本日數量 = lab('本日數量'); const 累計數量 = lab('累計數量');
  const end = items.find((it) => /^四、/.test(despace(it.s)) && it.y < h.y);
  const body = items.filter((it) => it.y < h.y - 3 && (!end || it.y > end.y + 3));
  const crewCols = {}; const machCols = {};
  if (本日人數) crewCols.本日 = 本日人數.x;
  if (累計人數) crewCols.累計 = 累計人數.x;
  if (本日數量) machCols.本日 = 本日數量.x;
  if (累計數量) machCols.累計 = 累計數量.x;
  const split = 機具名稱 ? 機具名稱.x - 5 : Infinity;

  const 出工明細 = []; const 主要機具 = [];
  const names = body.filter((it) => num(it.s) == null && text(it.s));
  for (const n of names) {
    const left = n.x < split;
    const cols = left ? crewCols : machCols;
    const vals = body.filter((it) => num(it.s) != null && sameLine(it, n)
      && it.x > n.x && (left ? it.x < split : it.x >= split));
    let today = null;
    for (const v of vals) if (nearestKey(cols, v.x) === '本日') today = num(v.s);
    if (today == null) continue;
    if (left) 出工明細.push({ 工別: text(n.s), 人數: today });
    else 主要機具.push({ 名稱: text(n.s), 數量: today });
  }
  return { 出工明細, 主要機具 };
}

/** 單頁(單日)解析;不是本格式回 null。 */
function parsePage(items) {
  const dateIt = items.find((it) => rocDate(it.s));
  const dailyRows = parseItemsTable(items);
  if (!dateIt || !dailyRows) return null;
  const d = rocDate(dateIt.s);

  const am = find(items, /^上午[:：]$/);
  const pm = find(items, /^下午[:：]$/);
  const fill = find(items, /^填報日期/);
  const wx = (lab, bound) => (lab ? text(rightOf(items, lab, bound).map((it) => it.s).join('')) : null);

  const nameLab = find(items, /^工程名稱$/);
  const vendorLab = find(items, /^承攬廠商名/);
  const 工程名稱 = nameLab ? text(rightOf(items, nameLab, vendorLab ? vendorLab.x : Infinity)
    .map((it) => it.s).join('')) : null;
  const 承包廠商 = vendorLab ? text(rightOf(items, vendorLab).map((it) => it.s).join('')) : null;

  const startLab = find(items, /^開工日期$/);
  const startIt = startLab ? rightOf(items, startLab)[0] : null;
  const pctAfter = (re) => {
    const lab = find(items, re);
    const v = lab ? rightOf(items, lab)[0] : null;
    return v && /%$/.test(despace(v.s)) ? num(v.s) : null;
  };

  const { 出工明細, 主要機具 } = parseCrew(items);
  const extras = {};
  if (出工明細.length) extras.出工明細 = 出工明細;
  if (主要機具.length) extras.主要機具 = 主要機具;

  return {
    header: {
      工程名稱,
      填報日期: d.iso,
      星期: d.星期,
      天氣_上午: wx(am, pm ? pm.x : Infinity),
      天氣_下午: wx(pm, fill ? fill.x : Infinity),
      預定進度: pctAfter(/^預定進度$/),
      實際進度: pctAfter(/^實際進度$/),
      出工總人數: 出工明細.length ? 出工明細.reduce((a, r) => a + r.人數, 0) : null,
      本日累計金額: null,
      承包廠商,
      開工日期: startIt ? slashDate(startIt.s) : null,
    },
    dailyRows,
    extras,
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  if (!pages.some((p) => ((p && p.items) || []).length)) {
    throw new Error('PDF 沒有文字層(掃描件),瑞騏讀取器讀不動');
  }
  const byDate = new Map();
  for (const p of pages) {
    const d = parsePage((p && p.items) || []);
    if (!d) continue;
    const prev = byDate.get(d.header.填報日期);
    if (!prev || prev.dailyRows.length < d.dailyRows.length) byDate.set(d.header.填報日期, d);
  }
  // 共通錨點(施工項目/表報編號)多家都有;讀不到任何一天就明確擋下,不回空陣列
  if (!byDate.size) throw new Error('找不到瑞騏施工日誌的版面(此檔非瑞騏日誌)');
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => d);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**(取自樣本第 1 頁,只換工程名稱):
 * 契約數量靠右(1.00 x372.8)與置中(x352.4)兩種、跨行名稱的續行接回上一列、
 * 費用項累計 0.06480、工人值靠左歸「本日人數」。
 */
function selfTest() {
  const it = (y, x, w, s) => ({ y, x, w, s });
  const items = [
    it(764.7, 82.2, 23.4, '上午:'), it(764.7, 142.5, 9.4, '晴'), it(764.7, 202.7, 28.1, '下午:'),
    it(764.7, 299.1, 9.4, '晴'), it(762.8, 363.2, 56.4, '填報日期:'),
    it(764.3, 462.5, 103.3, '115年10月1日 (星期四)'),
    it(750.7, 32.2, 37.4, '工程名稱'), it(750.7, 82.2, 60, '測試工程'),
    it(750.7, 394.9, 56.2, '承攬廠商名稱'), it(750.7, 455.1, 93.6, '瑞騏建築經理有限公司'),
    it(737.3, 152.7, 37.4, '開工日期'), it(737.3, 244.6, 42.1, '2026/9/18'),
    it(710.4, 32.2, 37.4, '預定進度'), it(710.4, 99.4, 23.4, '5.96%'),
    it(710.4, 152.7, 37.4, '實際進度'), it(710.4, 254.0, 23.4, '6.46%'),
    it(682.4, 140.5, 37.4, '施工項目'), it(682.4, 304.5, 18.7, '單位'), it(682.4, 343.0, 37.4, '契約數量'),
    it(682.4, 405.1, 37.4, '本日數量'), it(682.4, 465.3, 37.4, '累計數量'), it(682.4, 535.0, 18.7, '備註'),
    it(669.0, 309.2, 9.4, '式'), it(669.0, 372.8, 18.7, '1.00'), it(669.0, 493.3, 18.7, '1.00'),
    it(668.4, 22.0, 196.6, '工程告示牌、職安告示牌與交通管制措施(租用)'),
    it(574.3, 22.0, 266.8, '沙灘排球場圍網整建(安裝獨立基礎鍍鋅烤漆透空網,配合地形施'),
    it(572.4, 309.2, 9.4, 'M2'), it(572.4, 347.7, 28.1, '118.00'),
    it(562.0, 22.0, 145.1, '做三種高網 H95cm/H110cm/H125cm)'),
    it(550.8, 309.2, 9.4, '組'), it(550.8, 352.4, 18.7, '1.00'),
    it(550.6, 22.0, 154.4, '沙灘排球場安裝單開門附鎖件共 3 樘'),
    it(482.2, 21.7, 69.1, '職業安全維生管理費'), it(481.6, 309.2, 9.4, '式'),
    it(481.6, 352.4, 18.7, '1.00'), it(481.6, 479.3, 32.8, '0.06480'),
    it(413.6, 22.2, 327.1, '二、工地材料管理概況(含約定之重要材料使用狀況及數量等):'),
    it(373.5, 22.0, 19.0, '工別'), it(373.5, 82.2, 37.9, '本日人數'), it(373.5, 142.5, 37.9, '累計人數'),
    it(373.5, 331.0, 37.9, '機具名稱'), it(373.5, 394.9, 37.9, '本日數量'), it(373.5, 455.1, 37.9, '累計數量'),
    it(346.6, 22.0, 19.0, '大工'), it(346.6, 91, 5, '1'), it(346.6, 149, 5, '3'),
    it(346.6, 331.0, 19.0, '山貓'), it(346.6, 449, 5, '1'),
    it(321.3, 21.8, 519.7, '四、本日施工項目是否有須依'),
  ];
  const d = parsePage(items);
  if (!d) return false;
  const h = d.header;
  if (h.填報日期 !== '2026-10-01' || h.星期 !== '四' || h.工程名稱 !== '測試工程') return false;
  if (h.天氣_上午 !== '晴' || h.天氣_下午 !== '晴' || h.開工日期 !== '2026-09-18') return false;
  if (h.預定進度 !== 5.96 || h.實際進度 !== 6.46 || h.承包廠商 !== META_VENDOR_KEY) return false;
  if (h.出工總人數 !== 1) return false;
  if (d.extras.主要機具) return false;                     // 機具只有累計 1,本日空
  const r = d.dailyRows;
  if (r.length !== 4) return false;
  if (r[0].項次 !== '1' || r[0].契約數量 !== 1 || r[0].累計完成數量 !== 1 || r[0].本日完成數量 !== null) return false;
  if (r[1].工程項目 !== '沙灘排球場圍網整建(安裝獨立基礎鍍鋅烤漆透空網,配合地形施做三種高網 H95cm/H110cm/H125cm)') return false;
  if (r[1].單位 !== 'M2' || r[1].契約數量 !== 118) return false;
  if (r[2].工程項目 !== '沙灘排球場安裝單開門附鎖件共 3 樘') return false;
  if (r[3].項次 !== '4' || r[3].累計完成數量 !== 0.0648) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parsePage, parseItemsTable, parseCrew },
};
