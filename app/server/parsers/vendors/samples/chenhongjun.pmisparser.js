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
 *   項次 <65 / 工程項目 65~200 / 單位、單價、契約數量 200~330 /
 *   本日完成數量 330~380 / 本日完成金額 380~435 / 累計完成數量 ≥435。
 * 新版把中間三欄整體左移；舊版則會把末三值黏在 x≈345，故仍須相容。
 * 末三欄無施工時是「-」,語意為無資料 → null,不可當 0。
 *
 * 第一聯提供 header(日期/天氣/進度/開工日),第二聯提供明細;兩者依頁序配對。
 */

const META_VENDOR_KEY = '陳宏鈞土木包工業';

const Y_TOL = 6;
const X = { 項次: 65, 名稱: 200, 本日數量: 330, 本日金額: 380, 累計: 435 };
const ITEM_NO_RE = /^(\d+|[壹貳參参肆伍陸柒捌玖拾])$/;
const UNIT_RE = /^(M2|M3|M|式|組|才|片|支|個|面|座|間|處|扇|樘|KG|kg|只|台)(?=\s|$)/;
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

function unitOf(v) {
  const s = text(v);
  const m = s && UNIT_RE.exec(s);
  return m ? m[1] : null;
}

/** 「-」「－」是無資料標記,語意為 null 而非 0。 */
function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 依 y 容差把 item 分列,列內依 x 排序。
 *
 * ⚠️ **帶的錨點必須跟著項次那一行走,不能用「第一個進來的 item」。**
 * 一列的 item y 是散開的(項次3 實測:名稱 676.5 與 669.5、項次與單價 668.0、
 * 單位 667.5、**契約數量 664.5**),整列跨了 12pt,而列距只有 16.5——
 * 容差開大到蓋得住 12 就會併掉相鄰列。
 *
 * 名稱換行時第一個進來的是名稱續行(669.5),帶就被錨在那裡,
 * 於是 664.5 的契約數量差 5 > 容差 4 而自己開一個新帶,**那一欄整份消失**。
 * 名稱沒換行的列錨點剛好就是數值帶,所以 29 項裡只有項次 3 與 26 中招
 * (兩者都是長名稱)——**缺的是欄位不是列,完整性統計看得到、逐格比對看不到**。
 *
 * 改成:項次 id 那個 item 一進來就把帶的 y 重新錨到它身上。項次是一列裡位置
 * 最穩的東西,錨過去之後偏移量才量得準。
 *
 * 錨好之後量全 19 天:契約數量相對項次的 Δy 有 508 次是 −1.1~−1.3,
 * 但有 35 次落在 −3.5~−5.6(同一份檔的偏移量逐頁不同),所以容差 4 → 6。
 * **列距實測最小 12.8**(646 列裡只有 4 列 <13),容差 6 仍小於半個列距 6.4,
 * 不會把相鄰列併進來;而 `find` 取最上面的帶,兩列之間的 item 也會歸給上一列——
 * 契約數量印在項次下方,正是要歸上一列。
 */
function groupRows(items) {
  const buckets = [];
  for (const it of (items || []).filter((i) => String(i.s || '').trim())
    .slice().sort((a, b) => b.y - a.y)) {
    let b = buckets.find((k) => Math.abs(k.y - it.y) <= Y_TOL);
    if (!b) { b = { y: it.y, items: [] }; buckets.push(b); }
    b.items.push(it);
    if (it.x < X.項次 && ITEM_NO_RE.test(String(it.s).trim())) b.y = it.y;
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

  const 契約文字 = between(row, X.名稱, X.本日數量);
  // 單價欄的長數字與契約數量皆由數字順序辨識(如 393,773.00、1.00)。
  const 契約數字 = 契約文字.replace(UNIT_RE, '').match(NUM_RE) || [];

  // 末三欄(本日數量/本日金額/累計數量)的落點會因天而異:有施工那天三個值黏成
  // 一格(「1.00    9,500.00        1.000」落在 x≈345),沒施工那天則分散成
  // x≈397「-」與 x≈454「1.000」。只看接合後的數字序列會把「-」那格漏掉,
  // 於是金額被當成累計、累計變 null——數字看起來都在,對到的欄位卻錯了。
  const 本日量文字 = between(row, X.本日數量, X.本日金額);
  const 本日金額文字 = between(row, X.本日金額, X.累計);
  const 累計文字 = between(row, X.累計, Infinity);
  const 黏連 = 本日量文字.match(NUM_RE) || [];
  const 尾數字 = 黏連.length >= 3
    ? 黏連                                   // 三值黏在第一格
    : [黏連[0], (本日金額文字.match(NUM_RE) || [])[0], (累計文字.match(NUM_RE) || [])[0]];

  const 單位 = unitOf(契約文字);
  return {
    項次,
    工程項目: text(between(row, X.項次, X.名稱)),
    單位,
    契約單價: 單位 ? numOf(契約數字[0]) : null,
    契約數量: 單位 ? numOf(契約數字[1]) : null,
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

/** PDF 匯出時「第 二 聯」可能在字間插入空白，聯別判定不可要求字元緊連。 */
function pageKind(rows) {
  const all = rows.flatMap((r) => r.items.map((i) => String(i.s || ''))).join('');
  if (/第?\s*二\s*聯/.test(all)) return 'second';
  if (/第?\s*一\s*聯/.test(all)) return 'first';
  return null;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少 ctx.filetypes(檔型工具需由 registry 注入)');
  const pages = await ft.extractItems(filePath);

  const firsts = [];
  const seconds = [];
  for (const p of pages) {
    const rows = groupRows(p.items);
    const kind = pageKind(rows);
    if (kind === 'first') firsts.push(rows);
    else if (kind === 'second') seconds.push(rows);
  }

  if (!firsts.length || !seconds.length || firsts.length !== seconds.length) {
    throw new Error(`施工日誌第一聯/第二聯數量不一致(第一聯 ${firsts.length} 頁、第二聯 ${seconds.length} 頁)`);
  }
  const n = firsts.length;
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
    version: '1.1.0',
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
  _internal: { groupRows, parseItemRow, parseFirstSheet, pageKind, rocToISO },
};
