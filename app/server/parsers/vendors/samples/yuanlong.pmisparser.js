/**
 * yuanlong.pmisparser.js — 沅隆營造有限公司施工日誌讀取器(鹿場國小、麥寮國小兩案)
 *
 * vendorKey 取自**決標公告的得標廠商**;兩案的日誌「承攬廠商名稱」欄也都是同一個
 * 名稱,三邊一致。
 *
 * ── 版面事實(實測 2 案 / xls 1 份、PDF 1 份)──
 * 兩案都是工程會標準表單的單聯版,但**載體不同**:
 *   鹿場(.xls) 一天一個「表報編號：」區塊,分頁 `1` 與 `114.12月` 各放一段日期。
 *   麥寮(.pdf) 一天一頁,同一套欄位但靠座標。
 * 兩條路的欄位規則共用一份(項次/名稱/單位/數量的取法一致),只有「怎麼取到一列」不同。
 *
 * ── 兩個坑 ──
 * ① **PDF 的長名稱會拆成 2~4 行,而數值印在整塊名稱的垂直中央**。實測
 *    「施工動線開闢與損壞復原,…」四行(593.5/580.4/567.3/554.2),數值在 573.9
 *    ——正好是 (593.5+554.2)/2。所以「離最近的數值列」是錯的判準:593.5 離上一列的
 *    602.1 只有 8.6、離自己的 573.9 有 19.6。判準:名稱行歸給**離它最近、且自己那行
 *    沒有名稱的數值列**——把「自己那行就有名稱」的列排除在候選之外是關鍵,
 *    不排除的話它會把隔壁項目的續行搶走(實測會生出「…管線路吊車、吊裝與清運設備…」
 *    這種兩個項目黏在一起的名稱,而且不會有任何欄位變 null)。
 * ② **此格式沒有項次欄,而且逐日只列「當天有印的那幾項」**(實測 64 天只有 62 列,
 *    多數天只印 1 項)。出現序在跨天時會指到不同項目上,而 SP3 的 prevCum/dailySum
 *    以項次為鍵——會把兩個不同項目的累計混在一起(實測 B2:45、E4:16、E5:18)。
 *    故**項次用項目名稱**(同利成那家):那是這份文件唯一穩定的識別。
 *
 * ── 此格式沒有的東西 ──
 * 沒有契約單價、沒有任何金額,一律 null 不回推。沒有星期(PDF 版有,Excel 版沒有)。
 * 材料表兩案都全空(程式照收,有才填)。
 */

const META_VENDOR_KEY = '沅隆營造有限公司';

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
  return s === '' || /^[-－\s]+$/.test(s) ? null : s;
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

/** 「2026年3月2日」/「115年3月2日」→ ISO(民國⇄西元雙制)。 */
function dateTextToISO(v) {
  const m = despace(v).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

/* ───────────────────────── Excel ───────────────────────── */

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

/** 標籤用 regex 找(這家兩案一個寫「填報日期：」、一個寫「填表日期：」)。 */
function colOfRe(row, re) {
  for (let c = 0; c < (row || []).length; c++) if (re.test(despace(row[c]))) return c;
  return -1;
}

function valueAfter(row, re) {
  const c = colOfRe(row, re);
  if (c < 0) return null;
  const lab = despace(row[c]);
  for (let i = c + 1; i < row.length; i++) {
    if (despace(row[i]) === lab) continue;
    if (row[i] == null || String(row[i]).trim() === '') continue;
    return row[i];
  }
  return null;
}

/** Excel:解析一天。 */
function parseDayGrid(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const iso = (v) => {
    const n = num(v);
    if (n != null && serialToISO) return serialToISO(n);
    return dateTextToISO(v);
  };

  const wr = rowWith(/^本日天氣/);
  const wt = wr < 0 ? '' : nfkc(grid[wr].slice(0, 6).join(' '));
  const am = wt.match(/上午[:：]\s*(\S+?)(?=[\s　]|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=[\s　]|填[表報]|$)/);

  const nr = rowWith(/^工程名稱$/);
  const pr = rowWith(/^預定進度/);
  const sr = rowWith(/^開工日期$/);

  const hr = rowWith(/^施工項目$/);
  const dailyRows = [];
  if (hr >= 0) {
    const hdr = grid[hr];
    const c單位 = colOf(hdr, '單位');
    const c契約 = colOf(hdr, '契約數量');
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    if ([c單位, c契約, c本日, c累計].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非沅隆格式?)');
    }
    for (let r = hr + 1; r < end; r++) {
      const name = text(at(grid, r, 0));
      if (name != null && SECTION.test(name)) break;
      if (name == null || SKIP_ROW.test(name)) continue;
      dailyRows.push({
        // 此格式沒有項次欄,而且逐日只列當天有印的項目 —— 用名稱當識別(見檔頭②)
        項次: name,
        工程項目: name,
        單位: unitOf(at(grid, r, c單位)),
        契約單價: null,                                 // 此格式無單價
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                             // 此格式無金額
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
      const n = c人數 < 0 ? null : num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = c機具 < 0 ? null : text(at(grid, r, c機具));
      const gn = c機數 < 0 ? null : num(at(grid, r, c機數));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], /^工程名稱$/)),
      填報日期: wr < 0 ? null : iso(valueAfter(grid[wr], /^填[表報]日期[:：]?$/)),
      星期: null,                                       // Excel 版不提供
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      // 進度保留來源值(Excel 系讀取器的既有慣例;這家存的是百分數 0.07/1.78)
      預定進度: pr < 0 ? null : num(valueAfter(grid[pr], /^預定進度/)),
      實際進度: pr < 0 ? null : num(valueAfter(grid[pr], /^實際進度/)),
      出工總人數,
      本日累計金額: null,                               // 此格式無金額
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], /^承攬廠商名稱$/)),
      開工日期: sr < 0 ? null : iso(valueAfter(grid[sr], /^開工日期$/)),
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

/* ───────────────────────── PDF ───────────────────────── */

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

function pick(band, labelRe, stopRe) {
  if (!band) return null;
  const its = band.items;
  const li = its.findIndex((i) => labelRe.test(despace(i.s)));
  if (li < 0) return null;
  let end = its.length;
  if (stopRe) {
    for (let i = li + 1; i < its.length; i++) if (stopRe.test(despace(its[i].s))) { end = i; break; }
  }
  return text(its.slice(li + 1, end).map((i) => i.s).join(''));
}

const bandWith = (all, re) => all.find((b) => b.items.some((i) => re.test(despace(i.s))));

/** 以「各表頭的起點 x」為分界歸欄(值靠右印,用 [x, x+w] 會落在界外)。 */
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

/** PDF:解析一頁(一天)。 */
function parsePage(items) {
  const all = bands(items);
  const find = (re) => items.find((it) => re.test(despace(it.s)));

  const bWx = bandWith(all, /^本日天氣/);
  const bName = bandWith(all, /^工程名稱$/);
  const bStart = bandWith(all, /^開工日期$/);
  const bProg = bandWith(all, /^預定進度/);

  // 天氣不能整帶接起來再 regex:填報日期與星期跟天氣同一帶(y 差 0.5),
  // 接起來之後「下午:陰填報日期:2026年3月2日星期一」會把後面整串當成下午天氣。
  // 改成逐 item 取:標籤那格若已帶值就用它,否則取右邊下一格。
  const grabWx = (label) => {
    const its = bWx ? bWx.items : [];
    for (let i = 0; i < its.length; i++) {
      const s = nfkc(its[i].s);
      const k = s.indexOf(label);
      if (k < 0) continue;
      const rest = s.slice(k + label.length).trim();
      if (rest) return text(rest.split(/[\s　]+/)[0]);
      return its[i + 1] ? text(nfkc(its[i + 1].s).trim().split(/[\s　]+/)[0]) : null;
    }
    return null;
  };
  const bDate = bandWith(all, /^填[表報]日期[:：]?$/);
  const dateText = bDate ? (despace(bandText(bDate)).match(/\d{2,4}年\d{1,2}月\d{1,2}日/) || [])[0] : null;
  const week = bDate ? (despace(bandText(bDate)).match(/星期[一二三四五六日天]/) || [])[0] : null;

  // 工程名稱可能跨兩行(標籤那一行 + 續行);兩行都在標籤欄右邊
  let 工程名稱 = pick(bName, /^工程名稱$/, /^承攬廠商名稱$/);
  if (bName) {
    const i = all.indexOf(bName);
    for (const j of [i - 1, i + 1]) {
      const nb = all[j];
      if (!nb || nb.items.length !== 1) continue;
      const it = nb.items[0];
      if (it.x < 100 || it.x > 300) continue;             // 名稱續行印在標籤右邊
      工程名稱 = j < i ? text(it.s + (工程名稱 || '')) : text((工程名稱 || '') + it.s);
    }
  }

  // ── 明細 ──
  const hName = find(/^施工項目$/);
  const hUnit = find(/^單位$/);
  const hQty = find(/^契約數量$/);
  const hToday = find(/^本日完成數量$/);
  const hCum = find(/^累計完成數量$/);
  const hMemo = find(/^備註$/);
  const dailyRows = [];
  if (hName && hUnit && hQty && hToday && hCum) {
    const xs = [-Infinity, hUnit.x, hQty.x, hToday.x, hCum.x, hMemo ? hMemo.x : Infinity];
    const stop = find(/^營造業專業工程特定施工項目/) || find(/^二、/);
    const bottom = stop ? stop.y : -Infinity;
    const body = all.filter((b) => b.y < hName.y - 0.5 && b.y > bottom + 0.5);
    const parsed = body.map((b) => {
      const [left, 單位, 契約, 本日, 累計] = byColumn(b, xs);
      return {
        band: b,
        name: text(left),
        單位: unitOf(單位),
        契約數量: num(契約),
        本日完成數量: num(本日),
        累計完成數量: num(累計),
        hasValue: unitOf(單位) != null || num(契約) != null || num(本日) != null || num(累計) != null,
      };
    });
    // 名稱行歸給「離它最近的、自己那行沒有名稱的數值列」(見檔頭①)。
    // 只把沒有名稱的數值列列為候選是關鍵:單行名稱的列(施工架(租用))就在旁邊,
    // 不排除它的話會把別人的續行搶走。
    const claimed = new Set();
    const nameLine = (j) => j >= 0 && j < parsed.length && !parsed[j].hasValue
      && parsed[j].name && !claimed.has(j);
    const collected = new Map();
    for (let i = 0; i < parsed.length; i++) {
      if (!parsed[i].hasValue || parsed[i].name) continue;
      // 數值印在整塊名稱的**垂直中央**,所以名稱行一定是上下對稱地各一行:
      // 一次收一上一下,某一邊收不到就停。用「離最近的數值列」會出錯——
      // 實測 3/04 的「路」離下一列(607.8)16.3、離自己那列(643.8)19.7。
      const above = [];
      const below = [];
      let u = i - 1;
      let d = i + 1;
      while (nameLine(u) && nameLine(d)) {
        above.unshift(parsed[u].name); claimed.add(u); u -= 1;
        below.push(parsed[d].name); claimed.add(d); d += 1;
      }
      collected.set(i, above.concat(below));
    }
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      if (!p.hasValue) continue;
      const name = p.name || (collected.get(i) || []).join('');
      if (!name) continue;
      dailyRows.push({
        // 此格式沒有項次欄,而且逐日只列當天有印的項目——出現序在跨天時會指到
        // 不同項目上(SP3 以項次為鍵),故用名稱當識別(同利成那家)。
        項次: name,
        工程項目: name,
        單位: p.單位,
        契約單價: null,
        契約數量: p.契約數量,
        本日完成數量: p.本日完成數量,
        本日完成金額: null,
        累計完成數量: p.累計完成數量,
      });
    }
  }

  // ── 出工/機具 ──
  const extras = {};
  let 出工總人數 = null;
  const hCrew = find(/^工別$/);
  const hCrewToday = find(/^本日人數$/);
  const hCrewCum = find(/^累計人數$/);
  const hMach = find(/^機具名稱$/);
  const hMachToday = find(/^本日使用數量$/);
  if (hCrew && hCrewToday && hCrewCum && hMach && hMachToday) {
    const xs = [-Infinity, hCrewToday.x, hCrewCum.x, hMach.x, hMachToday.x];
    const stop = all.find((b) => b.y < hCrew.y && /^四、/.test(despace(bandText(b))));
    const bottom = stop ? stop.y : -Infinity;
    const 出工明細 = [];
    const 主要機具 = [];
    for (const b of all) {
      if (b.y >= hCrew.y - 0.5 || b.y <= bottom + 0.5) continue;
      const [工別, 本日, , 機具, 機具本日] = byColumn(b, xs);
      const w = text(工別);
      const n = num(本日);
      if (w && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const g = text(機具);
      const gn = num(機具本日);
      if (g && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱,
      填報日期: dateTextToISO(dateText),
      星期: week || null,
      天氣_上午: grabWx('上午:'),
      天氣_下午: grabWx('下午:'),
      預定進度: num(pick(bProg, /^預定進度\(%\)$/, /^實際進度/)),
      實際進度: num(pick(bProg, /^實際進度\(%\)$/)),
      出工總人數,
      本日累計金額: null,
      承包廠商: pick(bName, /^承攬廠商名稱$/),
      開工日期: dateTextToISO(pick(bStart, /^開工日期$/, /^完工日期$/)),
    },
    dailyRows,
    extras,
  };
}

/* ───────────────────────── 對外介面 ───────────────────────── */

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft) throw new Error('缺少注入的 filetypes');
  let days = [];
  if (/\.xls[xmb]?$/i.test(filePath)) {
    if (typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
    const wb = ft.readWorkbook(filePath);
    for (const name of Object.keys((wb && wb.sheets) || {})) {
      const grid = wb.sheets[name];
      const starts = blockStarts(grid);
      for (let i = 0; i < starts.length; i++) {
        days.push(parseDayGrid(grid, starts[i], i + 1 < starts.length ? starts[i + 1] : grid.length,
          ft.excelSerialToISO));
      }
    }
    if (!days.length) throw new Error('找不到「表報編號」區塊(此檔非沅隆日誌,或是掃描件)');
  } else {
    if (typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
    const pages = await ft.extractItems(filePath);
    const total = pages.reduce((a, p) => a + (p.items || []).length, 0);
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。掃描件一定要明講。
    if (!total) throw new Error('PDF 沒有文字層(掃描件),無法解析');
    for (const p of pages) {
      const items = p.items || [];
      if (!items.some((it) => despace(it.s).startsWith('表報編號'))) continue;
      days.push(parsePage(items));
    }
    if (!days.length) throw new Error('找不到「表報編號」頁(此檔非沅隆格式)');
  }
  const filled = days.filter((d) => d.header.填報日期 != null
    || d.dailyRows.some((r) => r.本日完成數量));
  // 鹿場的兩個分頁涵蓋同一段日期(實測 64 天裡 31 天重複);依日期去重,
  // **保留明細比較多的那一份**(空的複本不可蓋掉真資料)。
  const byDate = new Map();
  const noDate = [];
  for (const d of filled) {
    const k = d.header.填報日期;
    if (!k) { noDate.push(d); continue; }
    const prev = byDate.get(k);
    if (!prev || prev.dailyRows.length < d.dailyRows.length) byDate.set(k, d);
  }
  // 工程會標準表單很多家在用,錨點會碰巧命中別家的檔。
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔錨點雖然對上,版面不是沅隆的)');
  }
  return [...byDate.entries()].sort((p, q) => p[0].localeCompare(q[0])).map(([, d]) => d).concat(noDate);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 兩條路都驗:Excel 用真實儲存格(鹿場 分頁 `1` 第 1 天)、
 * PDF 用真實座標(麥寮第 1 頁),只換工程名稱。
 * PDF 那組的重點是「四行名稱夾著一行數值」——收錯就會把名稱接到別的項目上。
 */
function selfTest(ft) {
  // ── Excel ──
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  set(0, 0, 12, '公共工程施工日誌');
  set(1, 0, 0, '表報編號：'); set(1, 1, 1, 1);
  set(2, 0, 0, '本日天氣：  '); set(2, 1, 1, '上午：'); set(2, 2, 2, '晴');
  set(2, 3, 3, ' 下午： 陰'); set(2, 5, 6, ' 填報日期：'); set(2, 7, 12, 45992);
  set(3, 0, 2, '工程名稱'); set(3, 3, 6, '測試工程');
  set(3, 7, 9, '承攬廠商名稱'); set(3, 10, 12, META_VENDOR_KEY);
  set(5, 0, 0, '契約工期'); set(5, 1, 1, 90); set(5, 2, 2, '日曆天');
  set(6, 0, 2, '開工日期'); set(6, 3, 6, 45992); set(6, 7, 9, '完工日期'); set(6, 10, 12, 46081);
  set(7, 0, 2, '預定進度(%)'); set(7, 3, 6, 0.07); set(7, 7, 9, '實際進度(%)'); set(7, 10, 12, 1.78);
  set(8, 0, 12, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
  set(9, 0, 3, '施工項目'); set(9, 4, 4, '單位'); set(9, 5, 6, '契約數量');
  set(9, 7, 8, '本日完成數量'); set(9, 9, 10, '累計完成數量'); set(9, 11, 12, '備註');
  set(10, 0, 3, '工程告示牌與職安告示牌(租用)'); set(10, 4, 4, '式'); set(10, 5, 10, 1);
  set(11, 0, 3, '職業安全衛生管理費（壹*1%）'); set(11, 4, 4, '式'); set(11, 5, 6, 1); set(11, 7, 10, 0.05);
  set(24, 0, 3, '營造業專業工程特定施工項目'); set(25, 0, 3, 'A.'); set(26, 0, 3, 'B.');
  set(27, 0, 12, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
  set(28, 0, 3, '材料名稱'); set(28, 4, 4, '單位'); set(28, 5, 6, '設計數量');
  set(28, 7, 8, '本日使用數量'); set(28, 9, 10, '累計使用數量'); set(28, 11, 12, '備註');
  set(31, 0, 12, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  set(32, 0, 1, '工別'); set(32, 2, 3, '本日人數'); set(32, 4, 6, '累計人數');
  set(32, 7, 8, '機具名稱'); set(32, 9, 10, '本日使用數量'); set(32, 11, 12, '累計使用數量');
  set(33, 0, 1, '大工');
  set(34, 0, 1, '小工'); set(34, 2, 6, 1);
  set(35, 0, 12, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const x = parseDayGrid(g, 1, g.length, serial);
  if (x.header.工程名稱 !== '測試工程' || x.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && x.header.填報日期 !== '2025-12-01') return false;
  if (serial && x.header.開工日期 !== '2025-12-01') return false;
  if (x.header.天氣_上午 !== '晴' || x.header.天氣_下午 !== '陰') return false;
  if (x.header.預定進度 !== 0.07 || x.header.實際進度 !== 1.78) return false;
  if (x.header.出工總人數 !== 1) return false;
  if (x.dailyRows.length !== 2) return false;            // A./B. 標籤不算明細
  // 項次用名稱(此格式沒有項次欄,出現序跨天會指到不同項目)
  if (x.dailyRows[0].項次 !== '工程告示牌與職安告示牌(租用)' || x.dailyRows[0].單位 !== '式') return false;
  if (x.dailyRows[0].契約數量 !== 1 || x.dailyRows[0].本日完成數量 !== 1) return false;
  if (x.dailyRows[1].項次 !== x.dailyRows[1].工程項目 || x.dailyRows[1].本日完成數量 !== 0.05) return false;
  if (x.dailyRows[1].契約單價 !== null || x.dailyRows[1].本日完成金額 !== null) return false;

  // ── PDF ──
  const it = (xx, y, w, s) => ({ x: xx, y, w, s });
  const items = [
    it(243.1, 801.8, 89.3, '公共工程施工日誌'),
    it(22.1, 787.3, 50.4, '表報編號:'), it(99.0, 787.3, 5.0, '1'),
    it(254.9, 773.4, 60.5, '  填報日期:'), it(327.8, 773.4, 60.5, '2026年3月2日'),
    it(443.9, 773.4, 30.2, '星期一'),
    it(22.1, 772.9, 171.4, '本日天氣:                        '),
    it(67.4, 772.9, 30.2, '上午:'), it(107.7, 772.9, 10.1, '晴'), it(149.8, 772.9, 50.4, ' 下午: 陰'),
    it(149.5, 757.8, 168.0, '測試工程'),
    it(64.1, 751.8, 40.3, '工程名稱'),
    it(353.8, 751.8, 60.5, '承攬廠商名稱'), it(457.9, 751.8, 80.6, META_VENDOR_KEY),
    it(64.1, 715.8, 40.3, '開工日期'), it(206.8, 715.8, 60.5, '2026年3月2日'),
    it(363.9, 715.8, 40.3, '完工日期'), it(465.5, 715.8, 65.5, '2026年3月31日'),
    it(56.5, 701.4, 55.4, '預定進度(%)'), it(227.0, 701.4, 20.2, '1.64'),
    it(356.4, 701.4, 55.4, '實際進度(%)'), it(485.6, 701.4, 25.2, '11.43'),
    it(22.1, 687.0, 352.8, '一、依施工計畫書執行按圖施工概況(含約定之重要施工項目及完成數量等):'),
    it(94.6, 672.6, 40.3, '施工項目'), it(269.4, 672.6, 40.3, '契約數量'),
    it(336.7, 672.6, 60.5, '本日完成數量'), it(416.5, 672.6, 60.5, '累計完成數量'),
    it(509.9, 672.6, 20.2, '備註'), it(221.1, 672.1, 20.2, '單位'),
    // 兩行名稱夾著數值行
    it(22.1, 657.8, 181.4, '工程告示牌、職安告示牌與交通管制設施'),
    it(226.1, 651.3, 10.1, '組'), it(287.1, 651.3, 5.0, '1'),
    it(364.4, 651.3, 5.0, '1'), it(444.2, 651.3, 5.0, '1'),
    it(22.1, 644.7, 30.2, '(租用)'),
    // 單行名稱與數值同一行 —— 不可被上面那列或下面那列搶走
    it(22.1, 630.2, 30.2, '保險費'), it(287.1, 630.2, 5.0, '1'),
    it(364.4, 630.2, 5.0, '1'), it(444.2, 630.2, 5.0, '1'), it(226.1, 629.7, 10.1, '式'),
    it(22.1, 602.1, 60.5, '施工架(租用)'), it(287.1, 602.1, 5.0, '1'),
    it(444.2, 602.1, 5.0, '1'), it(364.4, 602.1, 5.0, '1'), it(226.1, 601.6, 10.1, '式'),
    // 四行名稱夾著數值行(數值在整塊的垂直中央)
    it(22.1, 593.5, 181.4, '施工動線開闢與損壞復原,既有設備、構'),
    it(22.1, 580.4, 181.4, '造物、障礙物拆除、或遷移與復原,與施'),
    it(226.1, 573.9, 10.1, '式'), it(287.1, 573.9, 5.0, '1'),
    it(359.4, 573.9, 15.1, '0.3'), it(439.2, 573.9, 15.1, '0.3'),
    it(22.1, 567.3, 181.4, '工介面相關之管線路查修與清除廢棄管線'),
    it(22.1, 554.2, 10.1, '路'),
    it(22.1, 458.1, 131.0, '營造業專業工程特定施工項目'),
    it(22.1, 414.1, 292.3, '二、工地材料管理概況(含約定之重要材料使用狀況及數量等):'),
    it(53.8, 342.4, 18.7, '工別'), it(138.7, 342.4, 37.4, '本日人數'),
    it(248.8, 342.4, 37.4, '累計人數'), it(348.2, 342.4, 37.4, '機具名稱'),
    it(418.7, 342.4, 56.2, '本日使用數量'), it(491.9, 342.4, 56.2, '累計使用數量'),
    it(22.1, 327.6, 20.2, '大工'),
    it(22.1, 313.2, 20.2, '小工'), it(202.4, 313.2, 5.0, '8'), it(319.4, 313.2, 5.0, '1'),
    it(22.1, 290.9, 10.1, '四'), it(32.3, 290.9, 10.1, '、'),
  ];
  const d = parsePage(items);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d.header.填報日期 !== '2026-03-02' || d.header.星期 !== '星期一') return false;
  if (d.header.開工日期 !== '2026-03-02') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 1.64 || d.header.實際進度 !== 11.43) return false;
  if (d.header.出工總人數 !== 8) return false;
  if (d.dailyRows.length !== 4) return false;
  const [p1, p2, p3, p4] = d.dailyRows;
  if (p1.工程項目 !== '工程告示牌、職安告示牌與交通管制設施(租用)') return false;
  if (p1.單位 !== '組' || p1.契約數量 !== 1 || p1.累計完成數量 !== 1) return false;
  if (p2.工程項目 !== '保險費' || p2.單位 !== '式') return false;
  if (p3.工程項目 !== '施工架(租用)') return false;
  // 四行名稱要照原順序接回來,而且不可被上一列搶走
  if (p4.工程項目 !== '施工動線開闢與損壞復原,既有設備、構造物、障礙物拆除、或遷移與復原,與施工介面相關之管線路查修與清除廢棄管線路') return false;
  if (p4.本日完成數量 !== 0.3 || p4.累計完成數量 !== 0.3) return false;
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
  _internal: { parseDayGrid, parsePage, blockStarts },
};
