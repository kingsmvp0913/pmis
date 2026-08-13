/**
 * mingde.pmisparser.js — 明德土木包工業施工日誌讀取器(嘉義縣立東榮國民中學)
 *
 * vendorKey 取自**決標公告的得標廠商**(東榮國中廁所決標公告 DRJH-1140923、
 * 東榮丹娜絲工程決標公告 DRJH-1141103,兩案同一家);日誌的「承攬廠商名稱」
 * 欄也寫同一個名稱。
 *
 * ── 兩聯分在**兩個 PDF 檔**,各有一半欄位 ──
 *   `…第一聯(1).pdf`(52 頁)天氣、累計進度、承攬廠商、開工/完工日期,明細**沒有
 *     單價也沒有金額**。
 *   `…第二聯.pdf`(26 頁)完整明細:項次、名稱、單位、**契約單價**、契約數量、
 *     本日完成數量、**本日完成金額**、累計完成數量。但沒有天氣也沒有進度。
 *
 * 賜利發那家的兩聯在同一個活頁簿的兩個分頁,讀取器自己合得起來;**這家是兩個檔**,
 * 而 `parseAll` 一次只吃一個檔。故本讀取器**只負責讀單一檔案能讀到的東西**,
 * 缺的欄位一律 null,由上層依填報日期合併(見 `server/daily-log-merge.js`)。
 * 承辦人 2026-08-13 選定的作法:一次上傳兩個檔,系統依日期合併。
 *
 * ── 版面事實(座標為 PDF 點,一頁一天)──
 * 兩聯都用「最近的表頭中心」把值歸欄,**不能用表頭起點當分界**:
 * 第一聯的數值一律比表頭中心偏左 24pt(值 c322 vs 表頭「本日完成數量」c346),
 * 用區間法會整排落到左邊那一欄;第二聯反過來偏右 14pt(單價值 c374 vs 表頭 c360)。
 * 兩種偏移方向相反,而「取最近的表頭中心」兩邊都對。
 *
 *   第一聯 表頭 c: 施工項目97 單位215 契約數量280 本日完成數量346 累計完成數量429 備註531
 *   第二聯 表頭 c: 項次66 工程項目193 單位320 契約單價360 契約數量403
 *                  本日完成數量437 本日完成金額466 累計完成數量494 備註522
 *
 * ── 第一聯的名稱跨行,數值自己一行 ──
 * 「工程告示牌與職安衛告示牌(租用)、施工圍籬…」佔 y664 與 y656 兩行,
 * 而單位與數值在 y660(兩行的**中間**)。故數值帶自己沒有名稱時要**一上一下對稱
 * 收編**(同沅隆那家的作法),用「離最近的名稱行」會把名稱接到隔壁項目上。
 *
 * ── 進度取「累計」那一組 ──
 * 第一聯同時印「預定進度(%) / 實際進度(%)」與「預定累計進度(%) / 實際累計進度(%)」,
 * SP3 的 F3/C4 驗的是累計語意,故取後者。值是**百分數**(0.63%),照收不換算。
 *
 * ⚠️ 第二聯的標題被逐字拆開(「公 共 工 程 施 工 日 誌」= 15 個 item),
 * 錨點一律 despace 後比對。
 */

const META_VENDOR_KEY = '明德土木包工業';

// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

// 分帶容差。實測列距 8~13(y664/660/656、y739/731),取 2 可以把「名稱一行、
// 數值一行」分開,又不會把同一視覺行拆散。
const BAND = 2;

// 第一聯「工程名稱」與「承攬廠商名稱」的值在**同一帶**(工程名稱值 x82、
// 廠商名 x447),而「承攬廠商名稱」的標籤在別的帶。整帶串起來會變成
// 「…採購案明德土木包工業」,只能用 x 切。取兩者中間。
const NAME_SPLIT = 400;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

function text(v) {
  const s = nfkc(v).replace(/[\r\n]+/g, '').trim();
  return s === '' || s === '-' || s === '－' || /^-+$/.test(s) ? null : s;
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

/** 西元斜線日期「2026/7/6」→ ISO。這家用西元不是民國。 */
function slashDate(s) {
  const m = despace(s).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

/** 第二聯的日期寫成「2026 年 7 月 6 日」。 */
function cjkDate(s) {
  const m = despace(s).match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

const centerOf = (it) => it.x + it.w / 2;

/** 依 y 分視覺行(y 由大到小 = 頁面由上到下)。 */
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

/** 找內容(去空白後)符合 re 的第一個帶。 */
function findBand(bs, re) {
  for (const b of bs) if (re.test(despace(bandText(b)))) return b;
  return null;
}

/**
 * 用「最近的表頭中心」把一個值歸欄。
 *
 * **不可以用表頭起點當分界**:第一聯的數值比表頭中心偏左 24pt、第二聯偏右 14pt,
 * 兩邊方向相反,任何單向的區間法都會有一邊整排錯位。
 * 距離超過 `maxDist` 就不指派——留 null 讓完整性關卡看得見,不猜一個看起來合理的欄。
 */
function assignByNearest(cols, cx, maxDist = 40) {
  let best = null;
  let bestD = Infinity;
  for (const [key, c] of Object.entries(cols)) {
    const d = Math.abs(c - cx);
    if (d < bestD) { bestD = d; best = key; }
  }
  return bestD <= maxDist ? best : null;
}

/** 表頭帶 → { 欄名: 中心 x }。找不到任何一欄回 null。 */
function headerCols(b, labels) {
  if (!b) return null;
  const cols = {};
  for (const it of b.items) {
    const s = despace(it.s);
    for (const [key, names] of Object.entries(labels)) {
      if (names.some((n) => s === n)) cols[key] = centerOf(it);
    }
  }
  return Object.keys(cols).length ? cols : null;
}

// ── 第一聯 ────────────────────────────────────────────────────────────

const L1_COLS = {
  單位: ['單位'],
  契約數量: ['契約數量'],
  本日完成數量: ['本日完成數量'],
  累計完成數量: ['累計完成數量'],
  備註: ['備註'],
};

function parseFirst(items) {
  const bs = bands(items);
  const wb = findBand(bs, /^本日天氣/);
  if (!wb) return null;
  const wt = despace(bandText(wb));
  const am = wt.match(/上午[:：]([^\s下]+?)(?=[.。]|下午|填表|$)/);
  const pm = wt.match(/下午[:：]([^\s填]+?)(?=[.。]|填表|$)/);

  const nb = findBand(bs, /^工程名稱/);
  const sb = findBand(bs, /^開工日期/);
  // 進度取「累計」那一組(SP3 的 F3/C4 驗的是累計語意)
  const pb = findBand(bs, /^預定累計進度/);
  const pt = pb ? despace(bandText(pb)) : '';
  const pm2 = pt.match(/預定累計進度\(%\)([\d.]+)%/);
  const am2 = pt.match(/實際累計進度\(%\)([\d.]+)%/);

  const hb = findBand(bs, /^施工項目.*備註$/);
  const cols = headerCols(hb, L1_COLS);
  const dailyRows = [];
  if (hb && cols) {
    // 明細帶:表頭之下。名稱在最左(表頭「施工項目」的左邊),數值靠白名單單位認。
    const 名稱左界 = Math.min(...Object.values(cols)) - 60;
    const body = bs.filter((b) => b.y < hb.y);
    for (let i = 0; i < body.length; i++) {
      const b = body[i];
      const 值 = b.items.filter((it) => centerOf(it) > 名稱左界);
      const u = 值.map((it) => unitOf(it.s)).find((x) => x);
      if (!u) continue;                                   // 沒有單位的帶不是數值帶
      // 數值帶自己沒有名稱 → 一上一下對稱收編(見檔頭)
      const 名 = [];
      const own = b.items.filter((it) => centerOf(it) <= 名稱左界).map((it) => it.s).join('');
      if (text(own)) 名.push(own);
      for (let k = 1; k <= 2 && !名.length; k++) {
        const up = body[i - k];
        const dn = body[i + k];
        for (const nb2 of [up, dn]) {
          if (!nb2) continue;
          const only = nb2.items.every((it) => centerOf(it) <= 名稱左界);
          if (!only) continue;
          const t = bandText(nb2);
          if (text(t)) 名.push(t);
        }
      }
      const 工程項目 = text(名.join(''));
      if (!工程項目) continue;
      const row = {
        項次: 工程項目, 工程項目, 單位: u,
        契約單價: null, 契約數量: null,                    // 第一聯沒有單價
        本日完成數量: null, 本日完成金額: null, 累計完成數量: null,
      };
      for (const it of 值) {
        const key = assignByNearest(cols, centerOf(it));
        if (!key || key === '備註' || key === '單位') continue;
        const v = num(it.s);
        if (v != null && row[key] == null) row[key] = v;
      }
      dailyRows.push(row);
    }
  }

  return {
    header: {
      // 「承攬廠商名稱」的**標籤在別的帶**(y770/761),值卻與工程名稱同一帶,
      // 所以整帶串起來會變成「…採購案明德土木包工業」。用 x 切:工程名稱的值在
      // 左半(標籤 x28 之後),廠商名在右半(x447)。以 NAME_SPLIT 為界。
      工程名稱: nb ? text(nb.items.filter((i) => centerOf(i) < NAME_SPLIT)
        .map((i) => i.s).join('').replace(/^\s*工程名稱\s*/, '')) : null,
      填報日期: slashDate(bandText(wb)),
      星期: null,
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      預定進度: pm2 ? num(pm2[1]) : null,
      實際進度: am2 ? num(am2[1]) : null,
      出工總人數: null,
      本日累計金額: null,
      承包廠商: nb ? text(nb.items.filter((i) => centerOf(i) >= NAME_SPLIT)
        .map((i) => i.s).join('')) : null,
      開工日期: sb ? slashDate(bandText(sb)) : null,
    },
    dailyRows,
    extras: {},
  };
}

// ── 第二聯 ────────────────────────────────────────────────────────────

const L2_COLS = {
  項次: ['項次'],
  單位: ['單位'],
  契約單價: ['契約單價'],
  契約數量: ['契約數量'],
  本日完成數量: ['本日完成數量'],
  本日完成金額: ['本日完成金額'],
  累計完成數量: ['累計完成數量'],
  備註: ['備註'],
};

function parseSecond(items) {
  const bs = bands(items);
  const hb = findBand(bs, /項次.*工程項目.*單位.*契約單價/);
  if (!hb) return null;
  // 「本日/累計完成數量」的表頭跨兩帶(「本日」在上、「完成數量」在下),
  // 合併相鄰帶再取欄名。
  const idx = bs.indexOf(hb);
  const merged = { y: hb.y, items: [...hb.items, ...((bs[idx - 1] || {}).items || []), ...((bs[idx + 1] || {}).items || [])] };
  const cols = headerCols(hb, L2_COLS) || {};
  for (const b of [bs[idx - 1], bs[idx + 1]]) {
    if (!b) continue;
    for (const it of b.items) {
      const s = despace(it.s);
      if (s === '完成數量' || s === '完成金額') {
        // 「本日完成數量 / 本日完成金額 / 累計完成數量」三欄的下半段,依 x 順序補
        const key = cols.本日完成數量 == null ? '本日完成數量'
          : (cols.本日完成金額 == null ? '本日完成金額'
            : (cols.累計完成數量 == null ? '累計完成數量' : null));
        if (key) cols[key] = centerOf(it);
      }
    }
  }
  if (cols.契約單價 == null || cols.本日完成數量 == null) return null;

  const db = findBand(bs, /^工程名稱[::]/);
  const 名稱左界 = (cols.單位 || 320) - 60;
  const dailyRows = [];
  for (const b of bs.filter((x) => x.y < hb.y)) {
    const u = b.items.map((it) => unitOf(it.s)).find((x) => x);
    if (!u) continue;
    const 名 = b.items.filter((it) => centerOf(it) < 名稱左界 && centerOf(it) > (cols.項次 || 66) + 20)
      .map((it) => it.s).join('');
    const 工程項目 = text(名);
    if (!工程項目) continue;
    const row = {
      項次: null, 工程項目, 單位: u,
      契約單價: null, 契約數量: null,
      本日完成數量: null, 本日完成金額: null, 累計完成數量: null,
    };
    for (const it of b.items) {
      const key = assignByNearest(cols, centerOf(it));
      if (!key || key === '備註' || key === '單位') continue;
      if (key === '項次') { if (row.項次 == null) row.項次 = text(it.s); continue; }
      const v = num(it.s);
      if (v != null && row[key] == null) row[key] = v;
    }
    dailyRows.push(row);
  }

  return {
    header: {
      工程名稱: db ? text((despace(bandText(db)).match(/^工程名稱[::](.+?)(日期|$)/) || [])[1]) : null,
      填報日期: db ? cjkDate(bandText(db)) : null,
      星期: null,
      天氣_上午: null, 天氣_下午: null,                    // 第二聯沒有天氣
      預定進度: null, 實際進度: null,                      // 第二聯沒有進度
      出工總人數: null, 本日累計金額: null,
      承包廠商: null, 開工日期: null,
    },
    dailyRows,
    extras: {},
  };
}

/** 依填報日期去重(保留明細多的那一份),並照時序輸出。 */
function dedupe(days) {
  const byDate = new Map();
  for (const d of days) {
    const k = d.header.填報日期;
    if (!k) continue;
    const prev = byDate.get(k);
    if (!prev || prev.dailyRows.length < d.dailyRows.length) byDate.set(k, d);
  }
  return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => d);
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
  const pages = await ft.extractItems(filePath);
  const days = [];
  for (const p of pages) {
    const items = (p && p.items) || p || [];
    if (!items.length) continue;
    const d = parseSecond(items) || parseFirst(items);
    if (d && d.header.填報日期) days.push(d);
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
  if (!days.length) {
    throw new Error('找不到明德的第一聯或第二聯版面(此檔非明德日誌,或是無文字層的掃描件)');
  }
  return dedupe(days);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造一頁第二聯(取自 `…第二聯.pdf` 第 1 頁,只換工程名稱)。
 * 斷言對著兩個坑:值比表頭中心偏右 14pt(用區間法會落到左邊那欄)、
 * 表頭「本日/累計完成數量」跨兩帶。
 */
function selfTest() {
  const it = (s, cx, y, w = 12) => ({ s, x: cx - w / 2, y, w, h: 8 });
  const items = [
    it('工程名稱:測試工程', 120, 762, 150), it('日期 :2026 年 7 月 6 日(星期一)', 460, 762, 90),
    // 表頭跨兩帶:上帶「本日/本日/累計」、主帶其餘、下帶「完成數量/完成金額/完成數量」
    it('本日', 437, 754, 16), it('本日', 466, 754, 16), it('累計', 494, 754, 16),
    it('項次', 66, 751, 16), it('工程項目', 193, 751, 32), it('單位', 320, 751, 16),
    it('契約單價', 360, 751, 32), it('契約數量', 403, 751, 32), it('備註', 522, 751, 16),
    it('完成數量', 437, 747, 32), it('完成金額', 466, 747, 32), it('完成數量', 494, 747, 32),
    // 值:單價偏右 14pt(c374 vs 表頭 c360)
    it('1', 65, 739, 4), it('工程告示牌與職安衛告示牌(租', 186, 739, 120), it('式', 319, 739, 7),
    it('11,000', 374, 739, 24), it('1', 403, 739, 4),
    it('1.000', 436, 739, 20), it('11,000.00', 467, 739, 32), it('1.000', 500, 739, 20),
    it('2', 65, 731, 4), it('施工動線開闢與損壞復', 163, 731, 96), it('式', 319, 731, 7),
    it('10,000', 374, 731, 24), it('1', 403, 731, 4),
    it('1.000', 436, 731, 20), it('10,000.00', 467, 731, 32), it('1.000', 500, 731, 20),
  ];
  const d = parseSecond(items);
  if (!d) return false;
  if (d.header.填報日期 !== '2026-07-06') return false;
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.dailyRows.length !== 2) return false;
  const [r1, r2] = d.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== '式') return false;
  // 單價 11,000 落在「契約單價」而不是「單位」或「契約數量」——偏右 14pt 的那個坑
  if (r1.契約單價 !== 11000 || r1.契約數量 !== 1) return false;
  if (r1.本日完成數量 !== 1 || r1.本日完成金額 !== 11000 || r1.累計完成數量 !== 1) return false;
  if (r1.工程項目 !== '工程告示牌與職安衛告示牌(租') return false;
  if (r2.契約單價 !== 10000) return false;
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
  _internal: { parseFirst, parseSecond, bands, dedupe },
};
