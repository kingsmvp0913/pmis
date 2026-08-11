/**
 * yiqian.pmisparser.js — 宜謙營造工程有限公司施工日誌讀取器
 *
 * vendorKey 取自**決標公告的得標廠商**(5 案一致寫「宜謙營造工程有限公司」),
 * 日誌第一聯的「承攬廠商名稱」欄也是同一個名稱,兩邊一致。
 *
 * ⚠️ **25 份日誌裡只有 14 份讀得動。** 檔名帶「掃描」的那 11 份(7~68MB)是紙本
 * 掃描件,沒有文字層(extractItems 抽得到頁數但一個字都沒有);11301 忠信案的
 * 兩份日誌**全部**是掃描件,等於整案沒有可讀日誌。交付時要說清楚覆蓋率是
 * 14/25(4 案),不是「已完成」。
 *
 * ── 版面事實(實測 4 案 15 份)──
 * 同一套表單有 PDF 與 xlsx 兩種產出,**版面完全相同**,故兩條路徑共用同一組
 * 欄位規則,只有「怎麼取到一列」不同(PDF 靠座標分帶、Excel 靠表頭欄位)。
 *   第一聯「公共工程施工日誌」:天氣/填表日期/工程名稱/進度/出工/機具/材料。
 *     它的「一、施工項目」表**只列當天有施作的項目**,不是完整明細,不採用。
 *   第二聯「完成工程詳細表」:**完整明細**(項次/工程項目/單位/合約數量/
 *     本日完成數量/累計完成數量),逐日重印一份。dailyRows 一律取這一聯。
 * PDF 一天固定兩頁(一聯一頁),但配對仍以「第一聯開新的一天、第二聯的填報日期
 * 必須與該天相同」為準,不寫死 2 的倍數。
 *
 * ── 三個會讀錯的坑 ──
 * ① **表頭左對齊、數值右對齊**,用表頭欄界 `[x, x+w]` 判定會落在界外:
 *    合約數量表頭是 [416.6, 444.4],而值「1.00」的中心在 444.45——差 0.05 就
 *    整欄變 null。改用「以各表頭的**起點 x** 為分界」的區間法(第一聯與第二聯
 *    都成立)。
 * ② **項次、名稱、數值三者的 y 不同**(750.7 / 750.9 / 750.7),照 y 逐一分行會
 *    把一列拆成三列;而列距只有 8pt,容差開大又會把相鄰兩列併起來。故以 2pt
 *    分帶:同一帶內再靠 x 歸位。
 * ③ **項次每個中類各自從 1 編號**(鎮西/棒球場有「一/二/三」中類),不加前綴會
 *    在同一天出現多個「1」,SP3 的 prevCum/dailySum 以項次為鍵會把不同項目的
 *    累計混在一起。故數字項次一律前綴所屬**中類**:一.1 / 三.12。
 *    - 只用中類(小寫一二三),**不用大類**(大寫壹貳參):石榴/饒平沒有中類,
 *      項次就是 1..N,與發包後經費總表逐項同號,加了「壹.」反而全部對不上。
 *    - 費用項(貳~陸)本身就是頂層編號,不加前綴。
 *    - 大類/中類的判定是**單位欄為空**(招式:費用項的項次也是中文數字,
 *      但它們有單位有數量,是真項目)。
 *
 * ── 此格式沒有的東西 ──
 * **兩聯都沒有單價、也沒有任何金額**,契約單價/本日完成金額/本日累計金額一律
 * null,不用「數量×別處的單價」回推。
 * 「二、工地材料管理概況」那張表實測 366 天全空,程式照收(有才填),不是略過。
 */

const META_VENDOR_KEY = '宜謙營造工程有限公司';

// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)。
// 實測出現過的只有 式/M/M2/場/支/組/座,其餘是同型表單的常見單位。
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '天', '日', '人', '才', '式(含)']);

// 項次:阿拉伯數字、中文大寫(壹貳參肆伍陸=大類與費用項)、中文小寫(一二三=中類)。
// 「参」是實測到的異體字(鎮西第二聯的第三個費用項)。
const NO_RE = /^(\d{1,3}|[壹貳參参肆伍陸柒捌玖拾]+|[一二三四五六七八九十]+)$/;
const MINOR_RE = /^[一二三四五六七八九十]+$/;
const SECTION_RE = /^[一二三四五六七八九十]+、/;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');

/** 儲存格/PDF token → 字串;空白、「-」視為未填。Excel 的手動換行併掉不留空白。 */
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
  const s = text(v);
  return s != null && KNOWN_UNITS.has(s.replace(/[\s　]/g, '')) ? s.replace(/[\s　]/g, '') : null;
};

/** 民國⇄西元雙制:年份小於 1911 一律當民國。 */
function toISO(y, m, d) {
  let year = Number(y);
  if (!Number.isFinite(year)) return null;
  if (year < 1911) year += 1911;
  return `${year}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/** 「填表日期:113年6月1日(星期六)」/「填報日期:…」→ { 填報日期, 星期 } */
function dateOf(t) {
  const m = nfkc(t).match(/填[表報]日期[:：]?\s*(\d{2,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[(（]?\s*(星期[一二三四五六日天])?/);
  if (!m) return { 填報日期: null, 星期: null };
  return { 填報日期: toISO(m[1], m[2], m[3]), 星期: m[4] || null };
}

/** 「本日天氣: 上午:晴 下午:晴」→ { 上午, 下午 } */
function weatherOf(t) {
  const s = nfkc(t);
  const a = s.match(/上午[:：]\s*(\S+?)(?=\s|下午|$)/);
  const p = s.match(/下午[:：]\s*(\S+?)(?=\s|填[表報]|$)/);
  return { 上午: a ? text(a[1]) : null, 下午: p ? text(p[1]) : null };
}

/**
 * 進度欄的兩種載體:PDF 是字串「0.34 %」(已是百分比數),Excel 是數值 0.0034
 * (儲存格格式才是 %)。混著收會差 100 倍,依型別分流。
 */
function pctOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e6) / 1e4 : null;
  return num(v);
}

/** 大類/中類列:單位、合約數量都空著(費用項有單位有數量,不是大類)。 */
const isHeading = (r) => r.單位 == null && r.契約數量 == null
  && r.本日完成數量 == null && r.累計完成數量 == null;

/**
 * 原始列(項次/名稱/單位/三個數量)→ 統一 schema 的 dailyRows。
 * 兩條路徑(PDF、Excel)取到原始列的方式不同,但前綴與大類規則共用這一份。
 */
function buildRows(raw) {
  const out = [];
  let prefix = null;
  for (const r of raw) {
    const 項次 = r.項次 == null ? null : String(r.項次).trim();
    const 工程項目 = r.名稱;
    const row = {
      項次,
      工程項目,
      單位: r.單位,
      契約單價: null,                                  // 此格式無單價
      契約數量: r.契約數量,
      本日完成數量: r.本日完成數量,
      本日完成金額: null,                              // 此格式無金額
      累計完成數量: r.累計完成數量,
    };
    if (isHeading(row)) {
      // 中類才當前綴;大類(壹)不當前綴——石榴/饒平只有大類,項次與經費總表同號。
      prefix = 項次 != null && MINOR_RE.test(項次) ? 項次 : null;
      out.push(row);
      continue;
    }
    if (項次 != null && prefix && /^\d+$/.test(項次)) row.項次 = `${prefix}.${項次}`;
    out.push(row);
  }
  return out;
}

/* ───────────────────────── PDF(座標)───────────────────────── */

/**
 * 依 y 分帶。一列的項次/名稱/數值 y 差 0.3 以內,列距 8pt,故容差取 2:
 * 帶的基準 y 固定用第一個(最上面)的 item,不隨新成員位移,免得一路飄。
 */
function bands(items, tol = 2) {
  const out = [];
  for (const it of items.slice().sort((a, b) => b.y - a.y)) {
    const last = out[out.length - 1];
    if (last && last.y - it.y <= tol) last.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  for (const b of out) b.items.sort((a, b2) => a.x - b2.x);
  return out;
}

const bandText = (b) => b.items.map((i) => i.s).join('');

/**
 * 以「各表頭的起點 x」為分界把一帶的 item 歸欄(見檔頭①)。
 * 第一欄的界是 -Infinity:名稱/工別的值都印在表頭左邊(名稱 x36 vs 表頭 x83)。
 */
function byColumn(band, xs) {
  const cells = xs.map(() => []);
  for (const it of band.items) {
    const c = it.x + (it.w || 0) / 2;
    let k = 0;
    while (k + 1 < xs.length && c >= xs[k + 1]) k++;
    cells[k].push(it);
  }
  return cells.map((g) => g.map((i) => i.s).join('').trim());
}


// 「單位」表頭是直排的兩個小字,**掃描件上 OCR 常常整個偵測不到**
// (饒平 8/1-8/2 真掃描件實測:項次/合約數量/本日完/累計完 四個錨點都讀到,只缺它)。
// 少這一個就整份 throw,太可惜——單位是封閉白名單、幾乎每列都有,而且欄內的**值**
// 讀得清清楚楚(那兩頁各 9 個與 12 個,x 全部落在 3 點之內)。故從值回推欄界。
//
// 校準:文字層樣本(yiqian.pdf 第 2 頁)表頭 x=392.9、單位值最小 x=393.2,差 0.3。
// 取「叢集最小 x − 0.5」等於還原表頭位置。byColumn 是用中心點分欄,這個界要落在
// 值的左緣**之前**,否則單位會被歸到名稱欄。
const UNIT_CLUSTER_TOLERANCE = 5;   // 同一欄的值 x 落差(實測 <3)
const MIN_UNIT_SAMPLES = 3;         // 太少就不敢推:可能是名稱裡剛好有「面」「處」

function unitColumnX(items, hNo, hQty) {
  const xs = items
    .filter((it) => KNOWN_UNITS.has(String(it.s).trim()) && it.x > hNo.x && it.x < hQty.x)
    .map((it) => it.x)
    .sort((a, b) => a - b);
  if (xs.length < MIN_UNIT_SAMPLES) return null;
  // 取中位數附近的叢集再取最小值:直接用 min 會被單一離群值(名稱片段)拉走
  const mid = xs[Math.floor(xs.length / 2)];
  const cluster = xs.filter((x) => Math.abs(x - mid) <= UNIT_CLUSTER_TOLERANCE);
  if (cluster.length < MIN_UNIT_SAMPLES) return null;
  return cluster[0] - 0.5;
}

/** 第二聯(完成工程詳細表)一頁 → 原始列。 */
function detailRows(items) {
  const find = (re) => items.find((it) => re.test(it.s.trim()));
  const hNo = find(/^項次$/);
  const hQty = find(/^合約數量$/);
  const hToday = find(/^本日完/);
  const hCum = find(/^累計完/);
  const hUnit = items.find((it) => /^單$|^單\s*位$/.test(it.s.trim()) && hQty && it.x < hQty.x && it.x > 300);
  if (!hNo || !hQty || !hToday || !hCum) throw new Error('第二聯表頭欄位找不到(非宜謙格式?)');
  const unitX = hUnit ? hUnit.x : unitColumnX(items, hNo, hQty);
  if (unitX == null) throw new Error('第二聯找不到單位欄(表頭與欄內值都認不出來)');
  const xs = [-Infinity, unitX, hQty.x, hToday.x, hCum.x];

  const raw = [];
  for (const b of bands(items)) {
    if (b.y >= hNo.y - 0.5) continue;                   // 表頭與標題列
    const t = bandText(b).trim();
    if (t === '' || /^(單|位|成數量|備註)+$/.test(t)) continue;   // 表頭的第二行
    const [left, 單位, 合約, 本日, 累計] = byColumn(b, xs);
    const parts = b.items.filter((i) => i.x + (i.w || 0) / 2 < unitX);
    let 項次 = null;
    let name = left;
    if (parts.length && NO_RE.test(parts[0].s.trim())) {
      項次 = parts[0].s.trim();
      name = parts.slice(1).map((i) => i.s).join('').trim();
    }
    const row = {
      項次,
      名稱: text(name),
      單位: unitOf(單位),
      契約數量: num(合約),
      本日完成數量: num(本日),
      累計完成數量: num(累計),
    };
    // 只有名稱、什麼都沒有的帶 → 上一列名稱的續行(長名稱會被拆成兩個 item)
    if (row.項次 == null && row.名稱 != null && row.單位 == null
      && row.契約數量 == null && row.本日完成數量 == null && row.累計完成數量 == null
      && raw.length) {
      const prev = raw[raw.length - 1];
      prev.名稱 = (prev.名稱 || '') + row.名稱;
      continue;
    }
    if (row.項次 == null && row.名稱 == null) continue;
    raw.push(row);
  }
  return raw;
}

/** 第二聯頁首的工程名稱(最上面那一個 item;第一聯的名稱是斷成兩段的)。 */
function detailTitle(items) {
  let top = null;
  for (const it of items) if (!top || it.y > top.y) top = it;
  return top ? text(top.s) : null;
}

/** 第一聯的一張子表(材料 / 出工機具):表頭帶 → 到下一個「N、」段落為止。 */
function subTable(allBands, headerRe, labels) {
  const hi = allBands.findIndex((b) => labels.every((L) => b.items.some((i) => i.s.trim() === L))
    && headerRe.test(bandText(b)));
  if (hi < 0) return null;
  const hdr = allBands[hi];
  const xs = [-Infinity];
  for (const L of labels.slice(1)) xs.push(hdr.items.find((i) => i.s.trim() === L).x);
  const rows = [];
  for (let i = hi + 1; i < allBands.length; i++) {
    const t = bandText(allBands[i]).trim();
    if (SECTION_RE.test(t)) break;
    rows.push(byColumn(allBands[i], xs));
  }
  return rows;
}

/** 第一聯(公共工程施工日誌)一頁 → header 片段 + extras。 */
function parseCover(items) {
  const all = bands(items);
  const joined = items.map((i) => i.s).join(' ');
  const { 填報日期, 星期 } = dateOf(joined);
  const { 上午, 下午 } = weatherOf(joined);

  // 進度:同一帶內「預定進度(%)」右邊第一個數字。
  const pb = all.find((b) => b.items.some((i) => /^預定進度/.test(i.s.trim())));
  const after = (label) => {
    if (!pb) return null;
    const k = pb.items.findIndex((i) => i.s.trim().startsWith(label));
    if (k < 0) return null;
    for (let j = k + 1; j < pb.items.length; j++) {
      const n = num(pb.items[j].s);
      if (n != null) return n;
    }
    return null;
  };

  const extras = {};
  let 出工總人數 = null;
  const crew = subTable(all, /工別/, ['工別', '本日人數', '累計人數', '機具名稱', '本日使用數量', '累計使用數量']);
  if (crew) {
    const 出工明細 = [];
    const 主要機具 = [];
    for (const [工別, 本日, , 機具, 機具本日] of crew) {
      const w = text(工別);
      const n = num(本日);
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = text(機具);
      const gn = num(機具本日);
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }
  const mats = subTable(all, /材料名稱/, ['材料名稱', '單位', '契約數量', '本日使用數量', '累計使用數量', '備註']);
  if (mats) {
    const 主要材料 = [];
    for (const [名稱, 單位, , 本日] of mats) {
      const n = text(名稱);
      if (n != null) 主要材料.push({ 名稱: n, 單位: unitOf(單位), 數量: num(本日) });
    }
    if (主要材料.length) extras.主要材料 = 主要材料;
  }

  return {
    填報日期,
    星期,
    天氣_上午: 上午,
    天氣_下午: 下午,
    預定進度: after('預定進度'),
    實際進度: after('實際進度'),
    出工總人數,
    extras,
  };
}

const pageKind = (items) => {
  for (const it of items) {
    if (it.s.includes('第一聯')) return 'cover';
    if (it.s.includes('第二聯')) return 'detail';
  }
  return null;
};

function parsePages(pages) {
  const total = pages.reduce((a, p) => a + (p.items || []).length, 0);
  // 回空陣列會被上游當成「這份沒有資料」靜靜略過。掃描件一定要明講。
  if (!total) throw new Error('PDF 沒有文字層(掃描件),無法解析');

  const groups = [];
  let cur = null;
  for (const p of pages) {
    const items = p.items || [];
    const kind = pageKind(items);
    if (kind === 'cover') {
      cur = { cover: items, details: [] };
      groups.push(cur);
    } else if (kind === 'detail') {
      // 第一聯缺頁/讀不到時,不能把這一頁掛到前一天:日期不同就自成一天。
      const d = dateOf(items.map((i) => i.s).join(' ')).填報日期;
      if (!cur || (cur.date && d && cur.date !== d)) {
        cur = { cover: null, details: [] };
        groups.push(cur);
      }
      if (d) cur.date = d;
      cur.details.push(items);
    }
  }

  return groups.map((g) => {
    const c = g.cover ? parseCover(g.cover) : { extras: {} };
    const raw = [];
    for (const d of g.details) raw.push(...detailRows(d));
    const detailDate = g.details.length
      ? dateOf(g.details[0].map((i) => i.s).join(' ')) : { 填報日期: null, 星期: null };
    return {
      header: {
        工程名稱: (g.details.length && detailTitle(g.details[0])) || null,
        填報日期: c.填報日期 || detailDate.填報日期 || null,
        星期: c.星期 || detailDate.星期 || null,
        天氣_上午: c.天氣_上午 || null,
        天氣_下午: c.天氣_下午 || null,
        預定進度: c.預定進度 == null ? null : c.預定進度,
        實際進度: c.實際進度 == null ? null : c.實際進度,
        出工總人數: c.出工總人數 == null ? null : c.出工總人數,
        本日累計金額: null,                             // 此格式無金額
        承包廠商: META_VENDOR_KEY,
      },
      dailyRows: buildRows(raw),
      extras: c.extras || {},
    };
  });
}

/* ───────────────────────── Excel(表頭欄位)───────────────────────── */

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);
const rowText = (row) => (row || []).map((v) => nfkc(v)).join(' ');

/** 在某列找第一個等於 label 的欄(合併填充後同值會連續,取最左那欄)。 */
function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) {
    if (nfkc(row[c]).replace(/[\s　]/g, '') === label) return c;
  }
  return -1;
}

/** 一天的區塊(第一聯列 → 下一個第一聯列)→ 單日結構。 */
function parseBlock(grid, from, to) {
  const line = (re) => {
    for (let r = from; r < to; r++) if (re.test(nfkc(at(grid, r, 0)))) return r;
    return -1;
  };
  const wr = line(/本日天氣/);
  const { 填報日期, 星期 } = dateOf(wr < 0 ? '' : nfkc(at(grid, wr, 0)));
  const { 上午, 下午 } = weatherOf(wr < 0 ? '' : nfkc(at(grid, wr, 0)));

  // 進度列:標籤後面第一個數值(標籤本身因合併填充會重複好幾欄)。
  const pr = line(/^預定進度/);
  const pick = (label) => {
    if (pr < 0) return null;
    const row = grid[pr] || [];
    let seen = false;
    for (let c = 0; c < row.length; c++) {
      const s = nfkc(row[c]).replace(/[\s　]/g, '');
      if (s.startsWith(label)) { seen = true; continue; }
      if (seen && /進度/.test(s)) return null;
      if (seen && row[c] != null && s !== '') return pctOf(row[c]);
    }
    return null;
  };

  const extras = {};
  let 出工總人數 = null;
  const cr = line(/^工別$/);
  if (cr >= 0) {
    const hdr = grid[cr];
    const c本日 = colOf(hdr, '本日人數');
    const c機具 = colOf(hdr, '機具名稱');
    const c機本日 = colOf(hdr, '本日使用數量');
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = cr + 1; r < to; r++) {
      const w = text(at(grid, r, 0));
      if (w == null || SECTION_RE.test(w)) break;
      const n = num(at(grid, r, c本日));
      if (n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = text(at(grid, r, c機具));
      const gn = num(at(grid, r, c機本日));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }
  const mr = line(/^材料名稱$/);
  if (mr >= 0) {
    const hdr = grid[mr];
    const c單位 = colOf(hdr, '單位');
    const c本日 = colOf(hdr, '本日使用數量');
    const 主要材料 = [];
    for (let r = mr + 1; r < to; r++) {
      const n = text(at(grid, r, 0));
      if (n == null || SECTION_RE.test(n)) break;
      主要材料.push({ 名稱: n, 單位: unitOf(at(grid, r, c單位)), 數量: num(at(grid, r, c本日)) });
    }
    if (主要材料.length) extras.主要材料 = 主要材料;
  }

  // 第二聯:表頭寫「合約數量」(第一聯那張寫「契約數量」),用它定位不會挑錯表。
  let hr = -1;
  for (let r = from; r < to; r++) if (colOf(grid[r], '合約數量') >= 0) { hr = r; break; }
  const raw = [];
  let 工程名稱 = null;
  if (hr >= 0) {
    const hdr = grid[hr];
    const c項次 = colOf(hdr, '項次');
    const c名稱 = colOf(hdr, '工程項目');
    const c單位 = colOf(hdr, '單位');
    const c合約 = colOf(hdr, '合約數量');
    const c本日 = colOf(hdr, '本日完');
    const c累計 = colOf(hdr, '累計完');
    if ([c項次, c名稱, c單位, c合約, c本日, c累計].some((c) => c < 0)) {
      throw new Error('第二聯表頭欄位找不到(非宜謙格式?)');
    }
    for (let r = hr + 1; r < to; r++) {
      const 項次 = text(at(grid, r, c項次));
      const 名稱 = text(at(grid, r, c名稱));
      if (項次 == null && 名稱 == null) continue;
      if (項次 === '項次') continue;                     // 表頭的第二行
      raw.push({
        項次: 項次 != null && NO_RE.test(項次) ? 項次 : 項次,
        名稱,
        單位: unitOf(at(grid, r, c單位)),
        契約數量: num(at(grid, r, c合約)),
        本日完成數量: num(at(grid, r, c本日)),
        累計完成數量: num(at(grid, r, c累計)),
      });
    }
    // 工程名稱在第二聯抬頭(「施 工 日 報 表」的上一列)。那格從欄 2 才開始,
    // 不在欄 0——只看欄 0 會找不到,退回第一聯那格則會拿到帶手動換行的版本。
    for (let r = hr - 1; r >= from; r--) {
      if (/施\s*工\s*日\s*報\s*表/.test(rowText(grid[r]))) {
        for (const v of grid[r - 1] || []) { const t = text(v); if (t) { 工程名稱 = t; break; } }
        break;
      }
    }
  }
  if (工程名稱 == null) {
    const nr = line(/^工程名稱$/);
    if (nr >= 0) {
      for (const v of grid[nr] || []) {
        const t = text(v);
        if (t && t !== '工程名稱') { 工程名稱 = t; break; }
      }
    }
  }

  return {
    header: {
      工程名稱,
      填報日期,
      星期,
      天氣_上午: 上午,
      天氣_下午: 下午,
      預定進度: pick('預定進度'),
      實際進度: pick('實際進度'),
      出工總人數,
      本日累計金額: null,                               // 此格式無金額
      承包廠商: META_VENDOR_KEY,
    },
    dailyRows: buildRows(raw),
    extras,
  };
}

function parseGrid(grid) {
  const starts = [];
  for (let r = 0; r < (grid || []).length; r++) {
    if (nfkc(at(grid, r, 0)).replace(/[\s　]/g, '') === '第一聯') starts.push(r);
  }
  if (!starts.length) return [];
  return starts.map((s, i) => parseBlock(grid, s, i + 1 < starts.length ? starts[i + 1] : grid.length));
}

/* ───────────────────────── 對外介面 ───────────────────────── */

/**
 * 還沒填的天要濾掉,否則 SP3 噴一整片 A1/A2 把真問題淹掉。判定兩個條件並用:
 * 沒有填報日期 **且** 整天沒有任何本日完成量(只用前者會讓真的漏填的日子消失)。
 */
const hasWork = (d) => (d.dailyRows || []).some((r) => r.本日完成數量 != null && r.本日完成數量 !== 0);
const filled = (d) => d.header.填報日期 != null || hasWork(d);

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少注入的 filetypes');
  let days;
  if (/\.xls[xmb]?$/i.test(filePath)) {
    if (typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
    const wb = ft.readWorkbook(filePath);
    days = [];
    for (const name of Object.keys((wb && wb.sheets) || {})) days.push(...parseGrid(wb.sheets[name]));
    if (!days.length) throw new Error('活頁簿裡找不到「第一聯」區塊(非宜謙格式?)');
  } else {
    if (typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
    days = parsePages(await ft.extractItems(filePath));
    if (!days.length) throw new Error('PDF 裡找不到第一聯/第二聯(非宜謙格式?)');
  }
  return days.filter(filled);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標/真實儲存格**:PDF 取自鎮西 `0601A-0630A.pdf` 第 1~2 頁、
 * Excel 取自棒球場 `1001A-1031A.xlsx`(只換工程名稱)。自己編一組整齊的座標會
 * 驗不到真實版面的形狀,而這裡最容易錯的三件事全都是形狀問題:
 * 值右對齊會超出表頭欄界、一列的三個部分 y 不同、中類各自從 1 編號。
 */
function selfTest() {
  const it = (x, y, w, s) => ({ x, y, w, s });

  // ── 第一聯(真實座標)──
  const cover = [
    it(232.4, 786.0, 129.6, '公共工程施工日誌'),
    it(36.4, 771.0, 347.0, '第一聯                    '),
    it(36.4, 756.1, 160.9, '   本日天氣:   上午:晴   下午:雨'),
    it(415.9, 756.1, 140.9, '填表日期:113年6月1日(星期六)'),
    it(67.2, 678.7, 66.0, '預定進度(%)'), it(213.3, 678.7, 36.0, '0.34 %'),
    it(329.4, 678.7, 66.0, '實際進度(%)'), it(475.4, 678.7, 36.0, '0.87 %'),
    it(36.1, 450.3, 236.6, '二、工地材料管理概況(含約定之重要材料使用狀況及數量等):'),
    it(83.9, 434.2, 32.6, '材料名稱'), it(190.3, 434.2, 16.3, '單位'), it(247.7, 434.2, 32.6, '契約數量'),
    it(316.0, 434.2, 49.0, '本日使用數量'), it(403.4, 434.2, 49.0, '累計使用數量'), it(507.1, 434.2, 16.3, '備註'),
    it(515.0, 423.4, 0.5, '1'),
    it(36.1, 361.7, 261.1, '三、工地人員及機具管理(含約定之出工人數及機具使用情形及數量):'),
    it(70.2, 345.6, 16.3, '工別'), it(149.4, 345.6, 32.6, '本日人數'), it(236.8, 345.6, 32.6, '累計人數'),
    it(324.2, 345.6, 32.6, '機具名稱'), it(403.4, 345.6, 49.0, '本日使用數量'), it(490.8, 345.6, 49.0, '累計使用數量'),
    it(58.0, 332.8, 40.8, '現場工程師'), it(163.7, 332.8, 4.0, '1'), it(251.1, 332.8, 4.0, '2'),
    it(328.3, 332.8, 24.5, '挖土機'), it(425.9, 332.8, 4.0, '1'), it(513.2, 332.8, 4.0, '1'),
    it(66.1, 323.3, 24.5, '鋼筋工'), it(163.7, 323.3, 4.0, '0'), it(251.1, 323.3, 4.0, '0'),
    it(332.4, 323.3, 16.3, '卡車'), it(425.9, 323.3, 4.0, '0'), it(513.2, 323.3, 4.0, '0'),
    it(66.1, 313.8, 24.5, '普通工'), it(163.7, 313.8, 4.0, '2'), it(247.0, 313.8, 12.2, '112'),
    it(36.1, 246.6, 514.1, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…'),
  ];

  // ── 第二聯(真實座標;含「值右對齊超出表頭欄界」與「中類重編號」)──
  const detail = [
    it(178.0, 811.1, 247.1, '測試工程'),
    it(258.9, 802.2, 85.7, '施  工  日  報   表'),
    it(61.7, 794.0, 76.6, '第二聯  完成工程詳細表'),
    it(422.0, 793.8, 107.3, '填報日期:113年6月1日(星期六)'),
    it(392.9, 785.3, 6.5, '單'), it(465.3, 784.7, 20.9, '本日完'), it(510.2, 784.7, 20.9, '累計完'),
    it(227.7, 780.7, 27.8, '工程項目'), it(72.2, 780.6, 13.9, '項次'), it(416.6, 780.6, 27.8, '合約數量'),
    it(392.9, 776.5, 6.5, '位'), it(465.3, 775.8, 20.9, '成數量'), it(510.2, 775.8, 20.9, '成數量'),
    it(99.1, 767.5, 23.0, '直接工程'), it(76.1, 767.3, 7.0, '壹'),
    it(99.1, 759.2, 45.9, 'PU跑道與線溝工程'), it(76.1, 759.0, 7.0, '一'),
    it(99.1, 750.9, 218.5, '假設工程(含工程告示牌)'), it(77.8, 750.7, 3.5, '1'),
    it(393.2, 750.7, 7.0, '式'), it(437.5, 750.7, 13.9, '1.00'), it(482.4, 750.7, 13.9, '0.00'), it(527.3, 750.7, 13.9, '0.50'),
    it(99.1, 717.8, 95.1, '刨除與清運既有跑道面層與AC面層'), it(77.8, 717.6, 3.5, '5'),
    it(393.2, 717.6, 7.0, 'M2'), it(427.1, 717.6, 24.4, '1162.00'), it(475.4, 717.6, 20.9, '200.00'), it(520.3, 717.6, 20.9, '200.00'),
    it(36.1, 709.7, 12.2, '3cm'),
    it(99.1, 643.3, 94.8, '擴充PU跑道第6道'), it(76.1, 643.0, 7.0, '二'),
    it(99.1, 635.0, 86.4, '產品,施工測量,全場測量與放樣'), it(77.8, 634.8, 3.5, '1'),
    it(393.2, 634.8, 7.0, '式'), it(437.5, 634.8, 13.9, '1.00'), it(482.4, 634.8, 13.9, '0.00'), it(527.3, 634.8, 13.9, '0.00'),
    it(99.1, 394.9, 83.5, '職業安全衛生管理費(壹*0.6%)'), it(76.1, 394.6, 7.0, '貳'),
    it(393.2, 394.6, 7.0, '式'), it(437.5, 394.6, 13.9, '1.00'), it(475.4, 394.6, 20.9, '0.0048'), it(520.3, 394.6, 20.9, '0.0087'),
  ];

  const days = parsePages([{ page: 1, items: cover }, { page: 2, items: detail }]);
  if (days.length !== 1) return false;
  const d = days[0];
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.填報日期 !== '2024-06-01' || d.header.星期 !== '星期六') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '雨') return false;
  if (d.header.預定進度 !== 0.34 || d.header.實際進度 !== 0.87) return false;
  if (d.header.出工總人數 !== 3) return false;                     // 1+0+2,累計欄不計
  if (d.header.本日累計金額 !== null) return false;
  if (d.extras.出工明細.length !== 2) return false;                // 0 人的鋼筋工不列
  if (d.extras.主要機具.length !== 1 || d.extras.主要機具[0].名稱 !== '挖土機') return false;
  if (d.extras.主要材料) return false;                              // 材料表全空
  const rows = d.dailyRows;
  if (rows.length !== 7) return false;
  if (rows[0].項次 !== '壹' || rows[0].單位 !== null) return false;  // 大類:單位空
  if (rows[2].項次 !== '一.1') return false;                        // 中類前綴
  if (rows[2].契約數量 !== 1 || rows[2].累計完成數量 !== 0.5) return false; // 右對齊超界的那一欄
  if (rows[3].項次 !== '一.5' || rows[3].契約數量 !== 1162) return false;
  if (rows[3].工程項目 !== '刨除與清運既有跑道面層與AC面層3cm') return false;  // 名稱續行要接回來
  if (rows[3].本日完成數量 !== 200 || rows[3].累計完成數量 !== 200) return false;
  if (rows[5].項次 !== '二.1') return false;                        // 第二個中類重新編號
  const fee = rows[rows.length - 1];
  if (fee.項次 !== '貳' || fee.單位 !== '式' || fee.本日完成數量 !== 0.0048) return false; // 費用項不加前綴
  if (fee.契約單價 !== null || fee.本日完成金額 !== null) return false;

  // ── Excel 路徑(真實儲存格,合併填充後的樣子)──
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  set(0, 0, 0, '第一聯'); set(0, 1, 16, '公共工程施工日誌');
  set(1, 0, 16, '本日天氣:   上午:晴   下午:陰                    填表日期:114年10月21日(星期二)');
  set(2, 0, 2, '工程名稱'); set(2, 3, 7, '測試工程\r\n第二行');
  set(5, 0, 4, '預定進度(%)'); set(5, 5, 7, 0.0104); set(5, 8, 11, '實際進度(%)'); set(5, 12, 15, 0.0293);
  set(6, 0, 15, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
  set(7, 0, 4, '施工項目'); set(7, 5, 6, '單位'); set(7, 7, 7, '契約數量');
  set(7, 8, 10, '本日完成數量'); set(7, 11, 12, '累計完成數量'); set(7, 13, 15, '備註');
  set(8, 0, 4, '產品，整地'); set(8, 5, 6, 'M2'); set(8, 7, 7, 15093); set(8, 8, 10, 2500); set(8, 11, 12, 5000);
  set(9, 0, 15, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
  set(10, 0, 4, '材料名稱'); set(10, 5, 6, '單位'); set(10, 7, 7, '契約數量');
  set(10, 8, 10, '本日使用數量'); set(10, 11, 12, '累計使用數量'); set(10, 13, 15, '備註');
  set(11, 0, 15, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  set(12, 0, 3, '工別'); set(12, 4, 5, '本日人數'); set(12, 6, 7, '累計人數');
  set(12, 8, 10, '機具名稱'); set(12, 11, 12, '本日使用數量'); set(12, 13, 15, '累計使用數量');
  set(13, 0, 3, '現場工程師'); set(13, 4, 7, 1); set(13, 8, 10, '挖土機'); set(13, 11, 15, 0);
  set(14, 0, 3, '普通工'); set(14, 4, 5, 4); set(14, 6, 7, 30); set(14, 8, 10, '卡車'); set(14, 11, 12, 2); set(14, 13, 15, 9);
  set(15, 0, 15, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');
  set(16, 0, 14, '測試工程');
  set(17, 2, 8, '施 工 日 報 表');
  set(18, 0, 8, '第二聯  完成工程詳細表'); set(18, 11, 14, '填報日期:114年10月21日(星期二)');
  set(19, 0, 1, '項次'); set(19, 2, 8, '工程項目'); set(19, 9, 10, '單 位');
  set(19, 11, 11, '合約數量'); set(19, 12, 12, '本日完'); set(19, 13, 14, '累計完');
  set(20, 0, 1, '項次'); set(20, 2, 8, '工程項目'); set(20, 9, 10, '單 位');
  set(20, 11, 11, '合約數量'); set(20, 12, 14, '成數量');
  set(21, 0, 1, '壹'); set(21, 2, 8, '直接工程');
  set(22, 0, 1, '一'); set(22, 2, 8, '假設工程');
  set(23, 0, 1, '1'); set(23, 2, 8, '產品，工程告示牌及工地標誌'); set(23, 9, 10, '式'); set(23, 11, 11, 1); set(23, 12, 14, 0);
  set(24, 0, 1, '三'); set(24, 2, 8, '棒球場與練習場工程');
  set(25, 0, 1, '1'); set(25, 2, 8, '產品，整地，開挖多餘土方回填基\r\n地南側整平'); set(25, 9, 10, 'M2');
  set(25, 11, 11, 15093); set(25, 12, 12, 2500); set(25, 13, 14, 5000);
  set(26, 0, 1, '貳'); set(26, 2, 8, '職業安全衛生管理費（壹*1%）'); set(26, 9, 10, '式');
  set(26, 11, 11, 1); set(26, 12, 12, 0.0048); set(26, 13, 14, 0.0087);

  const xd = parseGrid(g);
  if (xd.length !== 1) return false;
  const x = xd[0];
  if (x.header.工程名稱 !== '測試工程') return false;
  if (x.header.填報日期 !== '2025-10-21' || x.header.星期 !== '星期二') return false;
  if (x.header.天氣_上午 !== '晴' || x.header.天氣_下午 !== '陰') return false;
  // Excel 存的是分數(0.0104),PDF 存的是「1.04 %」——不換算會差 100 倍
  if (x.header.預定進度 !== 1.04 || x.header.實際進度 !== 2.93) return false;
  if (x.header.出工總人數 !== 5) return false;
  if (x.extras.主要機具.length !== 1 || x.extras.主要機具[0].數量 !== 2) return false;
  if (x.extras.主要材料) return false;
  if (x.dailyRows.length !== 6) return false;                       // 只收第二聯,不收第一聯那張
  if (x.dailyRows[2].項次 !== '一.1') return false;
  if (x.dailyRows[4].項次 !== '三.1' || x.dailyRows[4].契約數量 !== 15093) return false;
  // 手動換行要併掉;全形逗號經 NFKC 折成半形,與 PDF 版的同一項目才對得起來
  if (x.dailyRows[4].工程項目 !== '產品,整地,開挖多餘土方回填基地南側整平') return false;
  if (x.dailyRows[4].本日完成數量 !== 2500 || x.dailyRows[4].累計完成數量 !== 5000) return false;
  if (x.dailyRows[5].項次 !== '貳') return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parsePages, parseGrid, detailRows, parseCover, buildRows, bands },
};
