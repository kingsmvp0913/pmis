/**
 * longsheng.pmisparser.js — 隆昇土木包工業施工日誌讀取器(永定國小,偏遠地區學校設施設備)
 *
 * vendorKey 取自日誌第一聯的「承攬廠商名稱」欄與承辦人下載檔名上的廠商名(同一字串)。
 *
 * ── 兩聯分在**兩個 PDF 檔**,各有一半欄位(同明德那家)──
 *   `…第一頁(工程會最新版本).pdf`  一頁一天:天氣、預定/實際進度、開工日期、
 *     承攬廠商、出工;明細**只列當天有施作的項目**,沒有項次、沒有單價也沒有金額。
 *   `…第二頁(工程會最新版本).pdf`  一頁一天:**每天印完整清單**,有項次欄、
 *     契約單價、本日/累計完成數量與金額;沒有天氣也沒有進度。
 * `parseAll` 一次只吃一個檔,故本讀取器**只讀單一檔案讀得到的東西**,缺的欄位 null,
 * 由上層依填報日期合併(`server/daily-log-merge.js`,dailyRows 取有契約單價的那份)。
 *
 * ── 兩聯的日期寫法不同 ──
 * 第一聯西元「2026年10月10日」、第二聯民國「115年10月10日」。
 *
 * ── 第二聯的值是**靠右對齊**,表頭靠左 ──
 * 欄寬只有 55pt 上下,值的中心會落到表頭中心與下一欄之間(「24,850.00」中心 366 vs
 * 「契約單價」中心 366、「0.50」中心 423 vs「本日完成數量」中心 418,但「1」中心 332
 * vs「契約數量」中心 307)。改用**右緣對右緣**:值的右緣與各表頭右緣實測差 ≤ 6pt,
 * 欄距 55pt,不會模稜兩可。
 *
 *   第二聯 表頭右緣: 契約數量329 契約單價388 本日完成數量439 本日完成金額498
 *                    累計完成數量553 累計完成金額612
 *
 * ── 第二聯的名稱跨多行,數值印在整塊名稱的垂直中央 ──
 * 項次 1 是五行(757.8、743.5、729.2、714.9、700.6,數值在 729.5),項次 3 是兩行、
 * 數值帶自己沒有名稱(638.4/624.1,數值 631.6)。兩個數值帶之間的名稱行**不能**用
 * 「離誰近」分:項次 7 的末行 444.7 離自己 14.7、離「貳」15.2,只差 0.5pt。
 * 改用對稱:每一列往下收的行數 = 它往上收的行數,剩下的才是下一列的上半
 * (見 rowsOfSecond)。Excel 的垂直置中保證名稱上下行數相等。
 *
 * ── 合計列與「本日完成進度=…」列要擋在明細外 ──
 * 合計列只有兩個金額(本日 12,427 / 累計 29,240)、沒有單位;累計那個當 header 的
 * 本日累計金額。⚠️ 本日那個 12,427 = 12,425 + 0.5 + 0.5 + 1——**費用項的「本日完成
 * 金額」欄廠商填的是數量**(0.50/1.00),合計把它們當錢加進去了。照收不修,讓 SP3 報。
 *
 * ── 進度是百分數但沒有 % 號(第一聯「0.08」「1.94」),照收不換算 ──
 */

const META_VENDOR_KEY = '隆昇土木包工業';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);

// 實測列距 14~15,一列的各段 y 差 ≤ 0.5。
const BAND = 2;

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

// 第一聯 10/20 起單位印成小寫「m2」(第二聯同一項是「M2」)。比對不分大小寫,
// 值照印的收——不認的話那一列整列不見,而且不會有任何欄位變 null。
const unitOf = (v) => {
  const s = despace(v);
  return s && (KNOWN_UNITS.has(s) || KNOWN_UNITS.has(s.toUpperCase())) ? s : null;
};

const pad = (n) => String(Number(n)).padStart(2, '0');

/** 「2026年10月10日」或民國「115年10月10日」→ ISO。 */
function cjkDate(s) {
  const m = despace(s).match(/(\d{3,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const y = Number(m[1]) < 1911 ? Number(m[1]) + 1911 : Number(m[1]);
  return `${y}-${pad(m[2])}-${pad(m[3])}`;
}

const centerOf = (it) => it.x + it.w / 2;
const rightOf = (it) => it.x + it.w;

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

function findBand(bs, re) {
  for (const b of bs) if (re.test(despace(bandText(b)))) return b;
  return null;
}

/** 表頭帶 → { 欄名: 取 pick(item) }。 */
function headerCols(b, labels, pick) {
  const cols = {};
  if (!b) return cols;
  for (const it of b.items) {
    const s = despace(it.s);
    for (const [key, names] of Object.entries(labels)) {
      if (names.includes(s) && cols[key] == null) cols[key] = pick(it);
    }
  }
  return cols;
}

/** 最近的欄;距離超過 maxDist 不指派(留 null 讓完整性關卡看得見)。 */
function nearest(cols, x, maxDist) {
  let best = null;
  let bestD = Infinity;
  for (const [key, c] of Object.entries(cols)) {
    const d = Math.abs(c - x);
    if (d < bestD) { bestD = d; best = key; }
  }
  return bestD <= maxDist ? best : null;
}

/**
 * 把「數值帶」與它們之間的名稱行配成列(兩聯共用)。
 *
 * 每個數值帶往上收的名稱行數記為 up;它往下最多收 up 行,其餘歸下一個數值帶的上半。
 * 第一個數值帶之上的名稱行全歸它。`isValueBand` 決定哪些帶是數值帶,
 * `isNameBand` 決定哪些帶可以被收編(其他帶——大類列、表頭——會把累積的名稱清掉)。
 */
function pairNames(body, isValueBand, isNameBand, nameOf) {
  const rows = [];
  let pending = [];                                   // 尚未歸屬的名稱行(由上而下)
  let prev = null;                                    // 上一個數值列
  const flush = () => {
    // pending 先還給上一列(它上面收幾行,下面就收幾行),剩下的留給下一列
    if (prev) {
      const give = pending.splice(0, Math.min(prev.up, pending.length));
      prev.below.push(...give);
    }
  };
  for (const b of body) {
    if (isValueBand(b)) {
      flush();
      const row = { band: b, above: pending, below: [], up: pending.length };
      rows.push(row);
      prev = row;
      pending = [];
    } else if (isNameBand(b)) {
      pending.push(nameOf(b));
    } else {
      flush();
      pending = [];
      prev = null;
    }
  }
  flush();
  return rows;
}

// ── 第一聯 ────────────────────────────────────────────────────────────

const L1_COLS = {
  契約數量: ['契約數量'],
  本日完成數量: ['本日完成數量'],
  累計完成數量: ['累計完成數量'],
  備註: ['備註'],
};

/** 出工/機具表:值靠右對齊在欄格內,欄界取各表頭的起點(值 x 落在 [本欄起點, 下欄起點))。 */
function crewAndMachines(bs) {
  const hb = findBand(bs, /^工別本日人數累計人數機具名稱/);
  if (!hb) return { 出工明細: [], 主要機具: [] };
  const starts = headerCols(hb, {
    工別: ['工別'], 本日人數: ['本日人數'], 累計人數: ['累計人數'],
    機具名稱: ['機具名稱'], 本日使用數量: ['本日使用數量'], 累計使用數量: ['累計使用數量'],
  }, (it) => it.x);
  const order = Object.entries(starts).sort((a, b) => a[1] - b[1]);
  const colOf = (it) => {
    let key = null;
    for (const [k, x0] of order) if (it.x >= x0 - 40) key = k;
    return key;
  };
  const 出工明細 = [];
  const 主要機具 = [];
  for (const b of bs.filter((x) => x.y < hb.y)) {
    if (/^四、/.test(despace(bandText(b)))) break;
    const cell = {};
    for (const it of b.items) {
      const k = colOf(it);
      if (!k) continue;
      cell[k] = (cell[k] || '') + it.s;
    }
    const 工別 = text(cell.工別 && cell.工別.replace(/\d.*$/, ''));
    if (工別 && num(cell.本日人數) != null) 出工明細.push({ 工別, 人數: num(cell.本日人數) });
    const 機具 = text(cell.機具名稱);
    if (機具 && num(cell.本日使用數量) != null) 主要機具.push({ 名稱: 機具, 數量: num(cell.本日使用數量) });
  }
  return { 出工明細, 主要機具 };
}

function parseFirst(items) {
  const bs = bands(items);
  const wb = findBand(bs, /^本日天氣/);
  if (!wb) return null;
  const wt = despace(bandText(wb));
  const am = wt.match(/上午[:]([^下]+?)(?=下午|填報|$)/);
  const pm = wt.match(/下午[:](.+?)(?=填報|$)/);
  const dm = wt.match(/填報日期[:](\d{3,4}年\d{1,2}月\d{1,2}日)/);
  const wk = wt.match(/星期([一二三四五六日天])/);

  // 工程名稱的值跨兩行(825.4 / 811.0),標籤「工程名稱」在兩行中間(818.2),
  // 同一帶右邊還有「承攬廠商名稱 隆昇土木包工業」。值一律取標籤右邊、廠商標籤左邊。
  const nb = findBand(bs, /^工程名稱/);
  let 工程名稱 = null;
  let 承包廠商 = null;
  if (nb) {
    const label = nb.items.find((i) => despace(i.s) === '工程名稱');
    const vlabel = nb.items.find((i) => despace(i.s) === '承攬廠商名稱');
    const lo = label ? rightOf(label) : 0;
    const hi = vlabel ? vlabel.x : Infinity;
    const near = items.filter((i) => Math.abs(i.y - nb.y) <= 10 && i.x >= lo && i.x < hi)
      .sort((a, b) => b.y - a.y || a.x - b.x);
    工程名稱 = text(near.map((i) => i.s).join(''));
    if (vlabel) 承包廠商 = text(nb.items.filter((i) => i.x > rightOf(vlabel)).map((i) => i.s).join(''));
  }
  const sb = findBand(bs, /^開工日期/);
  const pb = findBand(bs, /^預定進度/);
  const pt = pb ? despace(bandText(pb)) : '';
  const pg = pt.match(/預定進度\(%\)([\d.]+)實際進度\(%\)([\d.]+)/);

  const hb = findBand(bs, /^施工項目.*備註$/);
  const dailyRows = [];
  if (hb) {
    const cols = headerCols(hb, L1_COLS, centerOf);
    const unitHead = hb.items.find((i) => despace(i.s) === '單位');
    const 名稱右界 = unitHead ? unitHead.x - 10 : 240;
    const end = bs.findIndex((b) => b.y < hb.y && /^營造業專業工程特定施工項目/.test(despace(bandText(b))));
    const body = bs.filter((b, i) => b.y < hb.y && (end < 0 || i < end));
    const isValue = (b) => b.items.some((it) => unitOf(it.s) && it.x > 名稱右界);
    const isName = (b) => b.items.every((it) => centerOf(it) < 名稱右界) && !!text(bandText(b));
    const nameOf = (b) => bandText(b);
    for (const r of pairNames(body, isValue, isName, nameOf)) {
      const own = r.band.items.filter((it) => centerOf(it) < 名稱右界).map((it) => it.s).join('');
      const 工程項目 = text([...r.above, own, ...r.below].join(''));
      if (!工程項目) continue;
      const row = {
        項次: 工程項目, 工程項目,                         // 第一聯沒有項次,只列當天施作的(用名稱)
        單位: null, 契約單價: null, 契約數量: null,
        本日完成數量: null, 本日完成金額: null, 累計完成數量: null,
      };
      for (const it of r.band.items) {
        if (centerOf(it) < 名稱右界) continue;
        const u = unitOf(it.s);
        if (u) { if (!row.單位) row.單位 = u; continue; }
        const key = nearest(cols, centerOf(it), 40);
        if (!key || key === '備註') continue;
        const v = num(it.s);
        if (v != null && row[key] == null) row[key] = v;
      }
      dailyRows.push(row);
    }
  }

  const crew = crewAndMachines(bs);
  const extras = {};
  if (crew.出工明細.length) extras.出工明細 = crew.出工明細;
  if (crew.主要機具.length) extras.主要機具 = crew.主要機具;

  return {
    header: {
      工程名稱,
      填報日期: dm ? cjkDate(dm[1]) : null,
      星期: wk ? wk[1] : null,
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      預定進度: pg ? num(pg[1]) : null,
      實際進度: pg ? num(pg[2]) : null,
      出工總人數: crew.出工明細.length ? crew.出工明細.reduce((s, c) => s + c.人數, 0) : null,
      本日累計金額: null,
      承包廠商,
      開工日期: sb ? cjkDate(bandText(sb)) : null,
    },
    dailyRows,
    extras,
  };
}

// ── 第二聯 ────────────────────────────────────────────────────────────

const L2_COLS = {
  契約數量: ['契約數量'],
  契約單價: ['契約單價'],
  本日完成數量: ['本日完成數量'],
  本日完成金額: ['本日完成金額'],
  累計完成數量: ['累計完成數量'],
  累計完成金額: ['累計完成金額'],
};

const 項次形 = /^(\d{1,3}|[壹貳參参肆伍陸柒捌玖拾]+)$/;
const 大類 = /^[壹]$/;          // 直接工程費;貳~陸 是費用項本身,要輸出

function parseSecond(items) {
  const bs = bands(items);
  const hb = findBand(bs, /^項次工程項目單位/);
  if (!hb) return null;
  // 「本日完成數量/本日完成金額/累計…」與主表頭 y 差 0.6~1.7,有的會分到隔壁帶
  const near = bs.filter((b) => Math.abs(b.y - hb.y) <= 3);
  const cols = {};
  for (const b of near) Object.assign(cols, headerCols(b, L2_COLS, rightOf), cols);
  if (cols.契約單價 == null || cols.本日完成數量 == null || cols.累計完成數量 == null) return null;
  const top = Math.min(...near.map((b) => b.y));
  const noHead = hb.items.find((i) => despace(i.s) === '項次');
  const unitHead = hb.items.find((i) => despace(i.s) === '單位');
  const 項次右界 = noHead ? rightOf(noHead) + 10 : 70;
  const 名稱右界 = unitHead ? unitHead.x - 3 : 247;

  const db = findBand(bs, /^工程名稱[:]/);
  const dt = db ? despace(bandText(db)) : '';
  const 工程名稱 = db ? text(db.items.filter((i) => !/^(工程名稱|日期)[:]?$/.test(despace(i.s)) && !cjkDate(i.s))
    .map((i) => i.s).join('')) : null;

  // 資料區到合計列或「…完成進度=」為止。合計列的標籤每天不同:第 1 天沒有標籤、
  // 第 2 天「發包工作費總計」、其餘只剩一個「計」(「合」沒印出來)——所以認
  // 「沒有單位、有數字、文字只能是 …計」,不認標籤字面。
  const body = [];
  let 合計 = null;
  for (const b of bs) {
    if (b.y >= top) continue;
    const t = despace(bandText(b));
    if (/完成進度=|^承包廠商/.test(t)) break;
    const hasUnit = b.items.some((it) => unitOf(it.s));
    const nums = b.items.filter((it) => num(it.s) != null);
    if (!hasUnit && nums.length && nums.every((it) => it.x > 名稱右界)
      && b.items.every((it) => num(it.s) != null || /計$/.test(despace(it.s)))) { 合計 = b; break; }
    body.push(b);
  }

  const isValue = (b) => b.items.some((it) => unitOf(it.s) && it.x >= 名稱右界 - 10);
  const isName = (b) => b.items.every((it) => it.x >= 項次右界 && rightOf(it) <= 名稱右界 + 5)
    && !!text(bandText(b));
  const nameOf = (b) => bandText(b);

  const dailyRows = [];
  for (const r of pairNames(body, isValue, isName, nameOf)) {
    const noIt = r.band.items.find((it) => rightOf(it) <= 項次右界 && 項次形.test(despace(it.s)));
    const own = r.band.items.filter((it) => it.x >= 項次右界 && rightOf(it) <= 名稱右界 + 5)
      .map((it) => it.s).join('');
    const 工程項目 = text([...r.above, own, ...r.below].join(''));
    const row = {
      項次: noIt ? despace(noIt.s) : null, 工程項目, 單位: null,
      契約單價: null, 契約數量: null,
      本日完成數量: null, 本日完成金額: null, 累計完成數量: null,
    };
    for (const it of r.band.items) {
      if (it.x < 名稱右界 - 10) continue;
      const u = unitOf(it.s);
      if (u) { if (!row.單位) row.單位 = u; continue; }
      const key = nearest(cols, rightOf(it), 20);
      if (!key || key === '累計完成金額') continue;      // 累計金額不在 schema 裡
      const v = num(it.s);
      if (v != null && row[key] == null) row[key] = v;
    }
    dailyRows.push(row);
  }

  let 本日累計金額 = null;
  if (合計) {
    for (const it of 合計.items) {
      if (nearest(cols, rightOf(it), 20) === '累計完成金額') 本日累計金額 = num(it.s);
    }
  }

  return {
    header: {
      工程名稱,
      填報日期: cjkDate(dt),
      星期: null,
      天氣_上午: null, 天氣_下午: null,                    // 第二聯沒有天氣
      預定進度: null, 實際進度: null,                      // 第二聯沒有進度
      出工總人數: null,
      本日累計金額,
      承包廠商: null, 開工日期: null,
    },
    dailyRows: dailyRows.filter((r) => !大類.test(r.項次 || '')),
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
    const second = parseSecond(items);
    const d = second || parseFirst(items);
    if (d && d.header.填報日期) days.push({ ...d, 聯別: second ? '第二聯' : '第一聯' });
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
  if (!days.length) {
    throw new Error('找不到隆昇的第一聯或第二聯版面(此檔非隆昇日誌,或是無文字層的掃描件)');
  }
  return dedupe(days);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造一頁第二聯(取自 `…第二頁….pdf` 第 1 頁,只換工程名稱)。
 * 斷言對著三個坑:值靠右對齊(用中心會錯欄)、五行名稱數值在中央、
 * 項次 3 的數值帶自己沒有名稱(上下各一行)。
 */
function selfTest() {
  const it = (s, x, y, w) => ({ s, x, y, w, h: 8 });
  const items = [
    it('工程名稱:', 20.3, 804.0, 55.0), it('測試工程', 75.1, 804.0, 44.0),
    it('日期:', 405.1, 804.0, 33.0), it('115年10月10日', 462.0, 804.4, 71.6),
    it('本日完成數量', 397.2, 790.0, 41.5), it('累計完成數量', 501.0, 789.2, 52.2),
    it('本日完成金額', 442.3, 788.9, 55.3), it('累計完成金額', 556.5, 788.9, 55.3),
    it('項次', 35.3, 788.3, 22.0), it('工程項目', 75.1, 788.3, 44.0), it('單位', 250.3, 788.3, 22.0),
    it('契約數量', 284.9, 788.3, 44.0), it('契約單價', 344.3, 788.3, 44.0),
    it('壹', 40.7, 774.8, 11.0), it('直接工程費', 131.9, 774.8, 55.0),
    it('工程告示牌與職安衛告示牌(租', 75.1, 757.8, 148.5),
    it('用)、施工圍籬、警示帶、安全警', 75.1, 743.5, 159.5),
    it('1', 330.0, 729.5, 5.0), it('24,850.00', 343.5, 729.5, 45.0), it('0.50', 413.3, 729.5, 20.0),
    it('12,425.00', 447.4, 729.5, 45.0), it('0.50', 527.9, 729.5, 20.0), it('12,425.00', 561.3, 729.5, 45.0),
    it('1', 43.6, 729.2, 5.5), it('示燈等安全措施(租用);移動施工', 75.1, 729.2, 165.0), it('式', 255.8, 729.2, 11.0),
    it('架(租用);廢棄物清運處理(含合', 75.1, 714.9, 159.5),
    it('法證明)與環境清潔', 75.1, 700.6, 93.5),
    it('風雨走廊遮雨棚更換3mm塑鋁板(含', 75.1, 683.0, 165.0),
    it('1', 330.0, 669.0, 5.0), it('310,000.00', 338.5, 669.0, 50.0), it('0.00', 472.3, 669.0, 20.0),
    it('0.00', 527.9, 669.0, 20.0), it('0.00', 586.2, 669.0, 20.0),
    it('2', 43.6, 668.7, 5.5), it('原PC板拆除清運、天溝清淤與防水', 75.1, 668.7, 165.0), it('式', 255.8, 668.7, 11.0),
    it('填縫)', 75.1, 654.4, 27.5),
    it('安裝遮陽百葉(高0.8M以上),含固', 75.1, 638.4, 165.1),
    it('635', 320.0, 631.6, 15.0), it('400.00', 358.4, 631.6, 30.0), it('0.00', 472.3, 631.6, 20.0),
    it('0.00', 527.9, 631.6, 20.0), it('0.00', 586.2, 631.6, 20.0),
    it('3', 43.6, 631.3, 5.5), it('才', 255.8, 631.3, 11.0),
    it('定五金', 75.1, 624.1, 33.0),
    it('12,427.00', 447.4, 354.8, 45.0), it('29,240.00', 561.3, 354.8, 45.0),
  ];
  const d = parseSecond(items);
  if (!d) return false;
  if (d.header.填報日期 !== '2026-10-10' || d.header.工程名稱 !== '測試工程') return false;
  if (d.header.本日累計金額 !== 29240) return false;
  if (d.dailyRows.length !== 3) return false;
  const [r1, r2, r3] = d.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約數量 !== 1 || r1.契約單價 !== 24850) return false;
  if (r1.本日完成數量 !== 0.5 || r1.本日完成金額 !== 12425 || r1.累計完成數量 !== 0.5) return false;
  if (r1.工程項目 !== '工程告示牌與職安衛告示牌(租用)、施工圍籬、警示帶、安全警示燈等安全措施(租用);移動施工架(租用);廢棄物清運處理(含合法證明)與環境清潔') return false;
  if (r2.工程項目 !== '風雨走廊遮雨棚更換3mm塑鋁板(含原PC板拆除清運、天溝清淤與防水填縫)') return false;
  if (r2.本日完成數量 !== null || r2.本日完成金額 !== 0) return false;
  if (r3.項次 !== '3' || r3.工程項目 !== '安裝遮陽百葉(高0.8M以上),含固定五金' || r3.契約數量 !== 635) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    // 兩聯分在兩個檔:上傳只收到其中一聯時,由上層直接擋下並講缺哪一聯
    // (見 daily-log-merge 的 missingCopy)。
    copies: ['第一聯', '第二聯'],
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseFirst, parseSecond, bands, dedupe },
};
