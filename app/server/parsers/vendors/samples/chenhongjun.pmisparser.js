/**
 * chenhongjun.pmisparser.js — 陳宏鈞土木包工業(僑美國小)施工日誌讀取器
 *
 * 來源:`陳宏鈞橋美06日報表.pdf`,38 頁 = 19 天 × 2 頁(奇數頁第一聯、偶數頁第二聯)。
 *
 * ── 為何走座標而非文字 ──
 * 這份的明細抽成純文字後,同一列的數字會黏成「1.00    9,500.00        1.000」,
 * 而且欄位起點隨數字長度浮動(契約單價靠右對齊,x 落在 238~251)。
 * 只有 x/y 座標能還原欄位歸屬,故用 ctx.filetypes.extractItems(見該函式註解)。
 *
 * ── 版面事實(實測第 2 頁)──
 * y 需以容差分組(同一列的 item 會落在 y=722/721,差 1~4)。分組後依 x:
 *   項次 <65 / 工程項目 65~200 / 單位 200~232 / 契約單價 232~305 /
 *   契約數量 305~340 / 本日完成數量·金額·累計完成數量 ≥340(三值黏在一起)
 * 末三欄無施工時是「-」,語意為無資料 → null,不可當 0。
 *
 * 第一聯提供 header(日期/天氣/進度/開工日),第二聯提供明細;兩者依頁序配對。
 */

const META_VENDOR_KEY = '陳宏鈞土木包工業';

const Y_TOL = 4;
const X = { 項次: 65, 名稱: 200, 單位: 232, 單價: 305, 契約數量: 340, 本日金額: 390, 累計: 450 };
const ITEM_NO_RE = /^(\d+|[壹貳參参肆伍陸柒捌玖拾])$/;
// 金額與數量一律兩位以上小數或帶千分位,用這個形態切黏連字串
const NUM_RE = /-?\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;

// 無資料標記(「-」「－」)一律 null,**文字欄也一樣**:大類列「壹 直接工程費」的
// 單位欄印的是「-」,不轉的話 isCategoryRow 判不出它是大類列,於是每一天都會為它
// 生出 A7(契約數量未填)與 E1(項次不在契約表)兩個假硬錯。
const DASH_RE = /^[-－—–]+$/;
const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || DASH_RE.test(s) ? null : s;
};

/** 「-」「－」是無資料標記,語意為 null 而非 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 依 y 容差把 item 分列,列內依 x 排序。 */
function groupRows(items) {
  const buckets = [];
  for (const it of (items || []).filter((i) => String(i.s || '').trim())
    .slice().sort((a, b) => b.y - a.y)) {
    let b = buckets.find((k) => Math.abs(k.y - it.y) <= Y_TOL);
    if (!b) { b = { y: it.y, items: [] }; buckets.push(b); }
    b.items.push(it);
  }
  return buckets.map((b) => ({ y: b.y, items: b.items.sort((p, q) => p.x - q.x) }));
}

/** 取某個 x 區間內的字串(接合)。 */
const between = (row, lo, hi) => row.items
  .filter((i) => i.x >= lo && i.x < hi)
  .map((i) => i.s)
  .join(' ')
  .trim();

/**
 * 一列明細。末三欄(本日數量/本日金額/累計數量)在原檔是黏在一起的單一文字,
 * 依數字形態切開;不足三個就從左往右對應,缺的留 null。
 */
function parseItemRow(row) {
  const 項次 = text(between(row, 0, X.項次));
  if (項次 == null || !ITEM_NO_RE.test(項次)) return null;

  const 單價文字 = between(row, X.單位, X.單價);
  const 數量文字 = between(row, X.單價, X.契約數量);
  // 單價欄的數字若太長會蓋掉契約數量欄(如 393,773.00),此時兩個值會一起落在
  // 單價區間——切出來的第二個數字才是契約數量。
  const 單價數字 = 單價文字.match(NUM_RE) || [];
  const 數量數字 = 數量文字.match(NUM_RE) || [];

  // 末三欄(本日數量/本日金額/累計數量)的落點會因天而異:有施工那天三個值黏成
  // 一格(「1.00    9,500.00        1.000」落在 x≈345),沒施工那天則分散成
  // x≈397「-」與 x≈454「1.000」。只看接合後的數字序列會把「-」那格漏掉,
  // 於是金額被當成累計、累計變 null——數字看起來都在,對到的欄位卻錯了。
  const 本日量文字 = between(row, X.契約數量, X.本日金額);
  const 本日金額文字 = between(row, X.本日金額, X.累計);
  const 累計文字 = between(row, X.累計, Infinity);
  const 黏連 = 本日量文字.match(NUM_RE) || [];
  const 尾數字 = 黏連.length >= 3
    ? 黏連                                   // 三值黏在第一格
    : [黏連[0], (本日金額文字.match(NUM_RE) || [])[0], (累計文字.match(NUM_RE) || [])[0]];

  return {
    項次,
    工程項目: text(between(row, X.項次, X.名稱)),
    單位: text(between(row, X.名稱, X.單位)),
    契約單價: numOf(單價數字[0]),
    契約數量: numOf(數量數字[0] != null ? 數量數字[0] : 單價數字[1]),
    本日完成數量: numOf(尾數字[0]),
    本日完成金額: numOf(尾數字[1]),
    累計完成數量: numOf(尾數字[2]),
  };
}

/**
 * 逐列組明細,並把跨行的項目名稱接回來。
 *
 * 名稱過長時原檔會拆成兩列,而**續行印在項次列的上一列**(實測:"工程告示牌與職安衛
 * 告示牌(租" 在上、"1 安全警示燈等安全措施(租用)" 在下)。不接回來的話,
 * 每一列的名稱都是殘缺的後半段,與契約表比對時整份都判不一致。
 */
function collectRows(rows) {
  const out = [];
  let 續行 = [];
  for (const row of rows) {
    const r = parseItemRow(row);
    if (!r) {
      // 無項次但落在名稱區間的列 = 上一段名稱
      const seg = between(row, X.項次, X.名稱);
      if (seg && !/^[-－—–\s]*$/.test(seg)) 續行.push(seg);
      else 續行 = [];
      continue;
    }
    if (續行.length) {
      r.工程項目 = [...續行, r.工程項目].filter(Boolean).join('');
      續行 = [];
    }
    out.push(r);
  }
  return out;
}

/** 民國「115 年 6 月 12 日」(字元間可能夾空白)→ ISO。 */
function rocToISO(s) {
  const t = String(s == null ? '' : s).replace(/[\s　]/g, '');
  const m = /(\d{2,3})年(\d{1,2})月(\d{1,2})/.exec(t);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${Number(m[1]) + 1911}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

/** 從第一聯抽 header。以標籤文字定位,不靠寫死的 y。 */
function parseFirstSheet(rows) {
  const flat = rows.map((r) => r.items.map((i) => i.s).join(' '));
  const all = flat.join('\n');
  const 找 = (re) => { const m = re.exec(all); return m ? m[1] : null; };

  const 日期列 = flat.find((l) => /日\s*期/.test(l) && /年/.test(l)) || '';
  const 氣候列 = flat.find((l) => /氣\s*候/.test(l)) || '';
  const wm = /上午[:：]?\s*(\S+)?.*?下午[:：]?\s*(\S+)?/.exec(氣候列.replace(/\s{2,}/g, ' ')) || [];

  return {
    工程名稱: 找(/工\s*程\s*名\s*稱\s+(\S+)/),
    填報日期: rocToISO(日期列),
    星期: 找(/(星期[一二三四五六日天])/),
    天氣_上午: text(wm[1]),
    天氣_下午: text(wm[2]),
    預定進度: numOf(找(/本\s*日\s*預\s*定\s*進\s*度\s+([\d.]+)/)),
    實際進度: numOf(找(/本\s*日\s*實\s*際\s*進\s*度\s+([\d.]+)/)),
    出工總人數: null,
    本日累計金額: null,
    契約金額: numOf(找(/契\s*約\s*金\s*額\s+([\d,]+)/)),
    開工日期: rocToISO((flat.find((l) => /開\s*工\s*日\s*期/.test(l)) || '')),
  };
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const pages = await ft.extractItems(filePath);

  const firsts = [];
  const seconds = [];
  for (const p of pages) {
    const rows = groupRows(p.items);
    const kind = rows.some((r) => r.items.some((i) => /第二聯/.test(i.s))) ? 'second'
      : (rows.some((r) => r.items.some((i) => /第一聯/.test(i.s))) ? 'first' : null);
    if (kind === 'first') firsts.push(rows);
    else if (kind === 'second') seconds.push(rows);
  }

  const n = Math.min(firsts.length, seconds.length);
  const out = [];
  for (let k = 0; k < n; k++) {
    const dailyRows = collectRows(seconds[k]);
    out.push({ header: parseFirstSheet(firsts[k]), dailyRows, extras: {} });
  }
  return out;
}

async function parse(filePath, ctx) {
  const all = await parseAll(filePath, ctx);
  return all[0] || null;
}

// 內建座標小樣本;不需注入也不 require node_modules。
function selfTest() {
  const row = {
    y: 100,
    items: [
      { x: 56, y: 100, s: '1' },
      { x: 69, y: 100, s: '安全警示燈等安全措施(租用)' },
      { x: 212, y: 100, s: '式' },
      { x: 251, y: 100, s: '9,500.0' },
      { x: 313, y: 100, s: '1.00' },
      { x: 345, y: 100, s: '1.00    9,500.00        1.000' },
    ],
  };
  const r = parseItemRow(row);
  if (!r || r.項次 !== '1' || r.單位 !== '式') return false;
  if (r.契約單價 !== 9500 || r.契約數量 !== 1) return false;
  if (r.本日完成數量 !== 1 || r.本日完成金額 !== 9500 || r.累計完成數量 !== 1) return false;

  // 單價太長蓋掉契約數量欄時,第二個數字才是契約數量
  const wide = {
    y: 90,
    items: [
      { x: 56, y: 90, s: '3' }, { x: 69, y: 90, s: '拆除' },
      { x: 212, y: 90, s: '式' }, { x: 238, y: 90, s: '393,773.00 1.00' },
      { x: 397, y: 90, s: '-' },
    ],
  };
  const w = parseItemRow(wide);
  if (!w || w.契約單價 !== 393773 || w.契約數量 !== 1) return false;
  if (w.本日完成數量 !== null) return false;   // 「-」是無資料,不可變 0

  if (rocToISO('115  年  6  月  12 日') !== '2026-06-12') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '契約金額', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { groupRows, parseItemRow, parseFirstSheet, rocToISO },
};
