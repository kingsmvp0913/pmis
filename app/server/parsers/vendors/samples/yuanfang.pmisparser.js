/**
 * ⚠️⚠️ **這支還沒交付,有一個已知的讀錯,不要安裝到 data/vendor-parsers/** ⚠️⚠️
 *
 * **跨三行的名稱只收到後半段。** 實測古坑國小 595 列裡有 34 列(每天 2 列)
 * 中招:項次 4 真正的名稱是「4.既有牆面、地坪、磁磚、衛生設備、給排水設施、
 * 搗擺及天花板等拆除(含切割)及運棄」,讀出來只有「設施、搗擺及天花板等拆除
 * (含切割)及運棄」——前半段掉了,連帶 splitNo 切不出項次、項次變成名稱本身。
 * 國中案 612 列裡 102 列中招(每天 6 列)。
 *
 * 根因在 `rowsFrom` 的對稱收編:名稱佔三帶(上/中/下)而數值在中間那帶時,
 * `for k=1..2 && !名.length` 在 k=1 找到東西就停,收到的順序與完整性都不對。
 * 要改成「往上連續收到遇見非純名稱帶為止,往下同理」,並保持上→下的順序。
 *
 * 其餘部分實測是對的:兩案各 17 天、每天 35 列、單位零缺漏、header 九欄
 * (含星期、進度、開工日)全部正確、第二聯的單價與金額也對。
 * **修完那一條之後要重跑 check-parser 三關才算完成。**
 *
 * ─────────────────────────────────────────────────────────────────────
 *
 * yuanfang.pmisparser.js — 元方營造有限公司施工日誌讀取器(古坑國中小老舊廁所整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(古坑國中小廁所決標公告 A1150508);
 * 日誌每一天的「承攬廠商名稱」欄也寫同一個名稱。
 *
 * ── 頁面結構:封面 1 頁 + 每天 3 頁(52 = 1 + 17×3)──
 * ```
 * 頁1        封面(承攬廠商簽章、月報標題),沒有錨點
 * 頁2,5,8…   第一聯:「表報編號:N」+ header + 明細(**沒有單價也沒有金額**)
 * 頁3,6,9…   第二聯「第 1 頁共 2 頁」:明細**有契約單價與本日/累計金額**
 * 頁4,7,10…  第二聯「第 2 頁共 2 頁」:同一天的明細接續
 * ```
 * **同一天的兩張第二聯要接起來,不可以去重**——去重會靜靜丟掉一半的項目,
 * 而剩下的那一半自己完全自洽,沒有任何地方看得出來少了東西。
 *
 * ── 兩聯的欄位不同,同一天要合併 ──
 * 第一聯有天氣、預定/實際進度、承攬廠商、開工日期;第二聯有單價與金額。
 * 兩邊都在同一個 PDF 裡,所以本讀取器自己合(明德那家的兩聯在兩個檔,
 * 那才需要上層的多檔合併)。
 *
 * ── 欄位歸位一律用「最近的表頭中心」──
 * 第一聯的數值比表頭中心偏右 25~34pt(值 c307 vs「契約數量」c282),
 * 用表頭起點當分界會整排落到左邊那一欄。
 *
 *   第一聯 表頭 c: 施工項目135 單位231 契約數量282 本日完成數量361 累計完成數量446 備註524
 *   第二聯 主表頭 c: 施工項目134 單位230 備註524
 *          副表頭 c: 契約數量258 契約單價297 本日數量341 本日金額382 累計數量422 累計金額466
 *
 * ── 項次嵌在名稱開頭 ──
 * 「1.乙種施工圍籬…」「2.工程告示牌…」,費用項寫成「伍、營造綜合保險費」。
 * 沒有獨立的項次欄,只能從名稱切。
 *
 * ── 名稱跨行,數值自己一行 ──
 * 名稱佔 y655 與 y643 兩帶,而單位與數值在數值帶。數值帶自己沒有名稱時要
 * 一上一下對稱收編(同沅隆/明德的作法)。
 *
 * ── 進度是 PDF 印的百分數(0.33%),照收不換算。
 */

const META_VENDOR_KEY = '元方營造有限公司';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

// 實測列距 11~12,一列的各段 y 差 1~2。取 2 可以把「名稱一行、數值一行」分開,
// 又不會把同一視覺行拆散。
const BAND = 2;
// 值與表頭中心的偏移實測 25~34pt。超過這個距離就不指派,留 null 讓完整性關卡看得見。
const MAX_DIST = 42;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || /^-+$/.test(s) || s === '－' ? null : s;
}

function num(v) {
  const s = nfkc(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const unitOf = (v) => {
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

/** 民國年月日「115年7月15日」→ 西元 ISO。 */
function rocDate(s) {
  const m = despace(s).match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

const centerOf = (it) => it.x + it.w / 2;

function bands(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) <= BAND) { last.items.push(it); continue; }
    out.push({ y: it.y, items: [it] });
  }
  for (const b of out) b.items.sort((a, b2) => a.x - b2.x);
  return out;
}

const bandText = (b) => b.items.map((i) => i.s).join('');
const findBand = (bs, re) => bs.find((b) => re.test(despace(bandText(b)))) || null;

/** 最近的表頭中心;超過 MAX_DIST 就不指派(見檔頭)。 */
function nearest(cols, cx) {
  let best = null;
  let bestD = Infinity;
  for (const [k, c] of Object.entries(cols)) {
    const d = Math.abs(c - cx);
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= MAX_DIST ? best : null;
}

/** 項次嵌在名稱開頭:「1.乙種施工圍籬…」「伍、營造綜合保險費」。 */
function splitNo(name) {
  const m = despace(name).match(/^([0-9]{1,3}|[壹貳參肆伍陸柒捌玖拾一二三四五六七八九十]{1,3})[.、]\s*(.+)$/);
  if (!m) return { 項次: null, 名稱: text(name) };
  return { 項次: m[1], 名稱: text(m[2]) };
}

/**
 * 明細帶 → 列。名稱在最左(表頭「施工項目」左右),數值靠白名單單位認。
 * 數值帶自己沒有名稱時一上一下對稱收編。
 */
function rowsFrom(bs, hb, cols, 名稱右界) {
  const out = [];
  const body = bs.filter((b) => b.y < hb.y);
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    const u = b.items.map((it) => unitOf(it.s)).find((x) => x);
    if (!u) continue;
    const own = b.items.filter((it) => centerOf(it) < 名稱右界).map((it) => it.s).join('');
    const 名 = [];
    if (text(own)) 名.push(own);
    for (let k = 1; k <= 2 && !名.length; k++) {
      for (const nb of [body[i - k], body[i + k]]) {
        if (!nb) continue;
        if (!nb.items.every((it) => centerOf(it) < 名稱右界)) continue;
        const t = bandText(nb);
        if (text(t)) 名.push(t);
      }
    }
    const { 項次, 名稱 } = splitNo(名.join(''));
    if (!名稱) continue;
    const row = {
      項次: 項次 || 名稱, 工程項目: 名稱, 單位: u,
      契約單價: null, 契約數量: null,
      本日完成數量: null, 本日完成金額: null, 累計完成數量: null,
    };
    for (const it of b.items) {
      if (centerOf(it) < 名稱右界) continue;
      const key = nearest(cols, centerOf(it));
      if (!key || key === '備註' || key === '單位') continue;
      const v = num(it.s);
      if (v != null && row[key] == null) row[key] = v;
    }
    out.push(row);
  }
  return out;
}

const L1_LABELS = {
  單位: '單位', 契約數量: '契約數量', 本日完成數量: '本日完成數量',
  累計完成數量: '累計完成數量', 備註: '備註',
};

/** 第一聯:header + 明細(無單價金額)。不是第一聯回 null。 */
function parseFirst(bs) {
  const wb = findBand(bs, /^本日天氣/);
  if (!wb) return null;
  const wt = despace(bandText(wb));
  const am = wt.match(/上午([^\s下]+?)(?=下午|日期|$)/);
  const pm = wt.match(/下午([^\s日]+?)(?=日期|$)/);
  const nb = findBand(bs, /承攬廠商名?稱?/);
  const sb = findBand(bs, /^開工日期/);
  const pb = findBand(bs, /^預定進度/);
  const pt = pb ? despace(bandText(pb)) : '';
  const pv = pt.match(/預定進度\(%\)([\d.]+)%/);
  const av = pt.match(/實際進度\(%\)([\d.]+)%/);

  const hb = findBand(bs, /^施工項目單位契約數量/);
  const cols = {};
  if (hb) {
    for (const it of hb.items) {
      const s = despace(it.s);
      for (const [k, lab] of Object.entries(L1_LABELS)) if (s === lab) cols[k] = centerOf(it);
    }
  }
  const dailyRows = hb && cols.單位 ? rowsFrom(bs, hb, cols, cols.單位 - 20) : [];

  return {
    聯: 1,
    header: {
      工程名稱: nb ? text(nb.items.filter((i) => centerOf(i) < 300).map((i) => i.s).join('')
        .replace(/^\s*工程名稱\s*/, '')) : null,
      填報日期: rocDate(bandText(wb)) || (findBand(bs, /日期[::]/) ? rocDate(bandText(findBand(bs, /日期[::]/))) : null),
      星期: (despace(bandText(wb)).match(/星期([一二三四五六日])/) || [])[1] || null,
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      預定進度: pv ? num(pv[1]) : null,
      實際進度: av ? num(av[1]) : null,
      出工總人數: null,
      本日累計金額: null,
      承包廠商: nb ? text(nb.items.filter((i) => centerOf(i) >= 300).map((i) => i.s).join('')
        .replace(/^\s*承攬廠商名?稱?\s*/, '')) : null,
      開工日期: sb ? rocDate(bandText(sb)) : null,
    },
    dailyRows,
  };
}

/** 第二聯:明細有契約單價與本日/累計金額。不是第二聯回 null。 */
function parseSecond(bs) {
  const hb = findBand(bs, /^施工項目單位/);
  if (!hb) return null;
  const idx = bs.indexOf(hb);
  const sub = bs[idx + 1];
  if (!sub) return null;
  // 副表頭是「數量 單價 數量 金額 數量 金額」六格,依 x 由左到右對應
  const seq = sub.items.filter((it) => ['數量', '單價', '金額'].includes(despace(it.s)))
    .sort((a, b) => a.x - b.x);
  if (seq.length < 6) return null;
  const cols = {
    單位: (hb.items.find((it) => despace(it.s) === '單位') || {}).x,
    契約數量: centerOf(seq[0]), 契約單價: centerOf(seq[1]),
    本日完成數量: centerOf(seq[2]), 本日完成金額: centerOf(seq[3]),
    累計完成數量: centerOf(seq[4]), 累計完成金額: centerOf(seq[5]),
  };
  const 單位c = (hb.items.find((it) => despace(it.s) === '單位') || {});
  cols.單位 = 單位c.x != null ? centerOf(單位c) : 230;
  const rows = rowsFrom(bs, sub, cols, cols.單位 - 20)
    .map(({ 累計完成金額, ...r }) => r);                 // schema 沒有累計金額欄
  const db = findBand(bs, /\d{2,3}年\d{1,2}月\d{1,2}日/);
  return {
    聯: 2,
    header: { 填報日期: db ? rocDate(bandText(db)) : null },
    dailyRows: rows,
  };
}

/**
 * 依填報日期把同一天的頁合起來(純函式;selfTest 重用之)。
 *
 * **同一天的兩張第二聯要接起來,不可以去重**:去重會靜靜丟掉一半的項目,
 * 而剩下的那一半自己完全自洽,沒有任何地方看得出來少了東西。
 */
function groupByDate(pages) {
  const map = new Map();
  for (const p of pages) {
    const d = p.header.填報日期;
    if (!d) continue;
    if (!map.has(d)) map.set(d, { header: {}, L1: [], L2: [] });
    const g = map.get(d);
    for (const [k, v] of Object.entries(p.header)) {
      if (v != null && v !== '' && (g.header[k] == null || g.header[k] === '')) g.header[k] = v;
    }
    (p.聯 === 2 ? g.L2 : g.L1).push(...p.dailyRows);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([日期, g]) => ({
    header: {
      工程名稱: null, 填報日期: 日期, 星期: null, 天氣_上午: null, 天氣_下午: null,
      預定進度: null, 實際進度: null, 出工總人數: null, 本日累計金額: null,
      承包廠商: null, 開工日期: null, ...g.header,
    },
    // 第二聯有單價與金額,是比較完整的那一份;沒有第二聯才退回第一聯
    dailyRows: g.L2.length ? g.L2 : g.L1,
    extras: {},
  }));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  const parsed = [];
  for (const p of pages) {
    const items = (p && p.items) || p || [];
    if (!items.length) continue;
    const bs = bands(items);
    const d = parseFirst(bs) || parseSecond(bs);
    if (d && d.header.填報日期) parsed.push(d);
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
  if (!parsed.length) {
    throw new Error('找不到元方的第一聯或第二聯版面(此檔非元方日誌,或是無文字層的掃描件)');
  }
  return groupByDate(parsed);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造一天:一張第一聯 + 兩張第二聯。
 * 斷言對著兩個坑:兩張第二聯要接起來(不是去重)、數值比表頭中心偏右 25~34pt。
 */
function selfTest() {
  const it = (s, cx, y, w = 12) => ({ s, x: cx - w / 2, y, w, h: 8 });
  const l1 = bands([
    it('表報編號:', 69, 748, 30), it('1', 98, 748, 4),
    it('本日天氣', 66, 738, 32), it('上午', 104, 738, 16), it('晴', 141, 738, 8),
    it('下午', 185, 738, 16), it('晴', 223, 738, 8),
    it('日期:', 341, 738, 20), it('115年7月15日', 383, 738, 50), it('星期三', 501, 738, 24),
    it('工程名稱', 57, 725, 32), it('114年度老舊廁所整修工程-國小', 97, 726, 120),
    it('承攬廠商名稱', 377, 726, 48), it('元方營造有限公司', 468, 726, 64),
    it('開工日期', 98, 702, 32), it('115年7月15日', 225, 702, 50),
    it('預定進度(%)', 92, 690, 44), it('0.33%', 239, 690, 20),
    it('實際進度(%)', 359, 690, 44), it('1.63%', 490, 690, 20),
    it('施工項目', 135, 667, 32), it('單位', 231, 666, 16), it('契約數量', 282, 667, 32),
    it('本日完成數量', 361, 667, 48), it('累計完成數量', 446, 667, 48), it('備註', 524, 667, 16),
    it('1.乙種施工圍籬、警示帶', 101, 655, 88),
    it('式', 231, 655, 7), it('1.00', 307, 655, 16), it('1.00', 392, 655, 16), it('1.00', 480, 655, 16),
  ]);
  const mkL2 = (name, unit) => bands([
    it('115年7月15日', 383, 700, 50),
    it('施工項目', 134, 678, 32), it('單位', 230, 678, 16), it('備註', 524, 678, 16),
    it('數量', 258, 670, 16), it('單價', 297, 670, 16), it('數量', 341, 670, 16),
    it('金額', 382, 670, 16), it('數量', 422, 670, 16), it('金額', 466, 670, 16),
    it(name, 134, 642, 88),
    it(unit, 230, 637, 7), it('1.00', 262, 637, 16), it('2,750.00', 302, 637, 32),
    it('1.00', 349, 637, 16), it('2,750.00', 383, 637, 32),
    it('1.00', 431, 637, 16), it('2,750.00', 470, 637, 32),
  ]);

  const pages = [parseFirst(l1), parseSecond(mkL2('1.乙種施工圍籬、警示帶', '式')),
    parseSecond(mkL2('2.工程告示牌與職安衛告', '式'))].filter(Boolean);
  if (pages.length !== 3) return false;
  const days = groupByDate(pages);
  if (days.length !== 1) return false;
  const d = days[0];
  if (d.header.填報日期 !== '2026-07-15') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '晴') return false;
  if (d.header.預定進度 !== 0.33 || d.header.實際進度 !== 1.63) return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d.header.開工日期 !== '2026-07-15') return false;
  if (d.header.星期 !== '三') return false;
  // 兩張第二聯要接起來,不是去重成一張
  if (d.dailyRows.length !== 2) return false;
  const r = d.dailyRows[0];
  if (r.項次 !== '1' || r.工程項目 !== '乙種施工圍籬、警示帶') return false;
  if (r.單位 !== '式' || r.契約數量 !== 1 || r.契約單價 !== 2750) return false;
  if (r.本日完成數量 !== 1 || r.本日完成金額 !== 2750 || r.累計完成數量 !== 1) return false;
  if (d.dailyRows[1].項次 !== '2') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseFirst, parseSecond, groupByDate, bands },
};
