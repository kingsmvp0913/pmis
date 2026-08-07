/**
 * dongzhen.pmisparser.js — 東震營造工程有限公司施工日誌讀取器(古坑國中小圍籬/車棚)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄也是同一個
 * 名稱,兩邊一致。
 *
 * ── 版面事實(實測 1 案 / xls 25 天、PDF 30 天)──
 * 工程會標準表單,**天是橫向排列的**:xls 一天佔 10 欄(0~9、10~19…,共 250 欄),
 * 縱向分兩塊:r0~r36 是表頭與明細、r37~r64 是材料與出工機具。
 * PDF 則是一天一頁(同一份表單列印出來的)。
 *
 * ⚠️ **兩種載體的欄位不一樣,兩份都要收**:
 *   xls 25 天(3/20~4/13),**有契約單價與本日完成金額**(欄 8、9)。
 *   PDF 30 天(3/20~4/18),那兩欄是隱藏欄(活頁簿裡標著「這兩欄印出前隱藏」),
 *   所以 PDF 版沒有單價也沒有金額,但**多了 4/14~4/18 五天**。
 *   只做其中一種都會少東西:只做 xls 少 5 天、只做 PDF 少單價與金額。
 *
 * ── 兩個坑 ──
 * ① **天的起點要從表頭列推**(值為「施工項目」的每一欄),不能寫死 10:
 *    這種橫向表單的欄數會隨天數長,而且 xls 的第二塊(材料/出工)也用同一組起點。
 * ② **PDF 的表頭置中、值靠左**:項次(x49)與名稱(x80)都落在「施工項目」表頭
 *    (x165)的左邊,用表頭欄界會把名稱整段當成項次。左半改用形狀判定
 *    (最左 token 像「A.壹.1」「貳」就是項次),右半四欄才用表頭起點 x 當界。
 *
 * ── 項次的形狀 ──
 * 這案是兩個子工程合併發包(A=棒球場圍籬、B=車棚),所以項次是「A.壹.1」「B.壹.11」
 * 這種三層複合編號,費用項則是共用的「貳~陸」(A、B 兩案的費用合併成一筆)。
 * 照收不動:發包後經費總表那份的項次是 A.壹/A.貳…(以子工程為單位的彙總),
 * 與日誌不同層級,改寫任何一邊都只是把誤判換一種。
 *
 * ── 此格式沒有的東西 ──
 * 沒有星期(PDF 有、xls 沒有)。日層級的累計金額沒有(r34 那格「本日完成金額」是
 * 當天的合計,不是累計,而且實測與逐項加總對不上,不收)。材料表兩種載體都全空。
 */

const META_VENDOR_KEY = '東震營造工程有限公司';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
// 項次:A.壹.1 / B.壹.11 / 貳 / 参(異體字)/ 純數字
const NO_RE = /^([A-Za-z]\.)?[壹貳參参肆伍陸柒捌玖拾]+(\.\d{1,3})?$|^\d{1,3}$/;
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

function dateTextToISO(v) {
  const m = despace(v).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/* ───────────────────────── Excel(橫向)───────────────────────── */

/** 表頭列(值為「施工項目」的那一列)→ 天的起點欄。 */
function layoutOf(grid) {
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r] || [];
    const origins = [];
    let hasUnit = false;
    for (let c = 0; c < row.length; c++) {
      const s = despace(row[c]);
      if (s === '施工項目' && despace(row[c - 1]) !== '施工項目') origins.push(c);
      if (s === '單位') hasUnit = true;
    }
    if (origins.length && hasUnit) return { hr: r, origins, width: row.length };
  }
  return null;
}

function colIn(row, from, to, label) {
  for (let c = from; c < to; c++) if (despace((row || [])[c]) === label) return c;
  return -1;
}

function rowIn(grid, o, r0, r1, re) {
  for (let r = r0; r < r1; r++) if (re.test(despace(at(grid, r, o)))) return r;
  return -1;
}

function valueRight(row, from, to, label) {
  const c = colIn(row, from, to, label);
  if (c < 0) return null;
  for (let i = c + 1; i < to; i++) {
    const s = despace(row[i]);
    if (s === label || s === '') continue;
    return row[i];
  }
  return null;
}

/** Excel:解析一天(o = 該天起始欄,to = 下一天起始欄)。 */
function parseDayGrid(grid, o, to, hr, serialToISO) {
  const iso = (v) => {
    const n = num(v);
    if (n != null && serialToISO) return serialToISO(n);
    return dateTextToISO(v);
  };
  const wr = rowIn(grid, o, 0, hr, /^本日天氣/);
  const nr = rowIn(grid, o, 0, hr, /^工程名稱$/);
  const sr = rowIn(grid, o, 0, hr, /^開工日期$/);
  const pr = rowIn(grid, o, 0, hr, /^預定進度/);

  const wt = wr < 0 ? '' : nfkc(at(grid, wr, o));
  const am = wt.match(/上午[:：]\s*(\S+?)(?=[\s　]|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=[\s　]|$)/);

  const hdr = grid[hr] || [];
  const c單位 = colIn(hdr, o, to, '單位');
  const c契約 = colIn(hdr, o, to, '契約數量');
  const c本日 = colIn(hdr, o, to, '本日完成數量');
  const c累計 = colIn(hdr, o, to, '累計完成數量');
  const c單價 = colIn(hdr, o, to, '契約單價');
  const c金額 = colIn(hdr, o, to, '本日完成金額');
  if ([c單位, c契約, c本日, c累計].some((c) => c < 0)) {
    throw new Error('明細表頭欄位找不到(非東震格式?)');
  }
  const dailyRows = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const 項次 = text(at(grid, r, o));
    const 名稱 = text(at(grid, r, o + 1));
    if (項次 == null && 名稱 == null) break;
    if (項次 != null && (SECTION.test(項次) || /^營造業專業/.test(項次))) break;
    if (項次 == null || !NO_RE.test(despace(項次))) continue;
    dailyRows.push({
      項次,
      工程項目: 名稱,
      單位: unitOf(at(grid, r, c單位)),
      契約單價: c單價 < 0 ? null : num(at(grid, r, c單價)),
      契約數量: num(at(grid, r, c契約)),
      本日完成數量: num(at(grid, r, c本日)),
      本日完成金額: c金額 < 0 ? null : num(at(grid, r, c金額)),
      累計完成數量: num(at(grid, r, c累計)),
    });
  }

  // 出工在第二塊(材料/出工),同一組起點欄
  const extras = {};
  let 出工總人數 = null;
  const cr = rowIn(grid, o, hr, grid.length, /^工別$/);
  if (cr >= 0) {
    const ch = grid[cr];
    const c人數 = colIn(ch, o, to, '本日人數');
    const c機具 = colIn(ch, o, to, '機具名稱');
    const c機數 = colIn(ch, o, to, '本日使用數量');
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = cr + 1; r < grid.length; r++) {
      const w = text(at(grid, r, o));
      const g = c機具 < 0 ? null : text(at(grid, r, c機具));
      if (w != null && SECTION.test(w)) break;
      if (w == null && g == null) continue;
      const n = c人數 < 0 ? null : num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const gn = c機數 < 0 ? null : num(at(grid, r, c機數));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueRight(grid[nr], o, to, '工程名稱')),
      填報日期: wr < 0 ? null : iso(valueRight(grid[wr], o, to, '填表日期:')),
      星期: null,                                        // xls 版不提供
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      // 進度保留來源的分數(Excel 系讀取器的既有慣例)
      預定進度: pr < 0 ? null : num(valueRight(grid[pr], o, to, '預定進度(%)')),
      實際進度: pr < 0 ? null : num(valueRight(grid[pr], o, to, '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                                // r34 那格是當日合計,不是累計
      承包廠商: nr < 0 ? null : text(valueRight(grid[nr], o, to, '承攬廠商名稱')),
      開工日期: sr < 0 ? null : iso(valueRight(grid[sr], o, to, '開工日期')),
    },
    dailyRows,
    extras,
  };
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
const bandWith = (all, re) => all.find((b) => b.items.some((i) => re.test(despace(i.s))));

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
  const wt = bWx ? nfkc(bandText(bWx)) : '';
  const am = wt.match(/上午[:：]\s*(\S+?)(?=[\s　]|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=[\s　]|填[表報]|$)/);
  const dateText = bWx ? (despace(bandText(bWx)).match(/\d{2,4}年\d{1,2}月\d{1,2}日/) || [])[0] : null;
  const week = bWx ? (despace(bandText(bWx)).match(/星期[一二三四五六日天]/) || [])[0] : null;

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
    for (const b of all) {
      if (b.y >= hName.y - 0.5 || b.y <= bottom + 0.5) continue;
      const [left, 單位, 契約, 本日, 累計] = byColumn(b, xs);
      const parts = b.items.filter((i) => i.x + (i.w || 0) / 2 < hUnit.x).sort((a, c) => a.x - c.x);
      let 項次 = null;
      let name = left;
      // 表頭置中、值靠左:項次與名稱都在「施工項目」表頭左邊,只能靠形狀分(見檔頭②)
      if (parts.length && NO_RE.test(despace(parts[0].s))) {
        項次 = despace(parts[0].s);
        name = parts.slice(1).map((i) => i.s).join('').trim();
      }
      if (項次 == null) {
        // 沒有項次的純名稱行 = 上一列名稱的續行
        if (name && dailyRows.length) {
          const prev = dailyRows[dailyRows.length - 1];
          prev.工程項目 = (prev.工程項目 || '') + name;
        }
        continue;
      }
      dailyRows.push({
        項次,
        工程項目: text(name),
        單位: unitOf(單位),
        契約單價: null,                                  // PDF 版把單價欄隱藏了
        契約數量: num(契約),
        本日完成數量: num(本日),
        本日完成金額: null,                              // 同上
        累計完成數量: num(累計),
      });
    }
  }

  const extras = {};
  let 出工總人數 = null;
  const hCrew = find(/^工別$/);
  const hCrewToday = find(/^本日人數$/);
  const hCrewCum = find(/^累計人數$/);
  const hMach = find(/^機具名稱$/);
  const hMachToday = find(/^本日使用數量$/);
  const hMachCum = find(/^累計使用數量$/);
  if (hCrew && hCrewToday && hCrewCum && hMach && hMachToday) {
    // 沒有「累計使用數量」這一界的話,機具的本日與累計會併成同一格(1 與 1 變成 11)
    const xs = [-Infinity, hCrewToday.x, hCrewCum.x, hMach.x, hMachToday.x, hMachCum ? hMachCum.x : Infinity];
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
      工程名稱: pick(bName, /^工程名稱$/, /^承攬廠商名稱$/),
      填報日期: dateTextToISO(dateText),
      星期: week || null,
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      // PDF 印的是百分數(2.85%)
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
  const days = [];
  if (/\.xls[xmb]?$/i.test(filePath)) {
    if (typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
    const wb = ft.readWorkbook(filePath);
    for (const name of Object.keys((wb && wb.sheets) || {})) {
      const grid = wb.sheets[name];
      const lay = layoutOf(grid);
      if (!lay) continue;
      for (let i = 0; i < lay.origins.length; i++) {
        const o = lay.origins[i];
        const to = i + 1 < lay.origins.length ? lay.origins[i + 1] : lay.width;
        days.push(parseDayGrid(grid, o, to, lay.hr, ft.excelSerialToISO));
      }
    }
    if (!days.length) throw new Error('找不到「施工項目」表頭(此檔非東震格式,或是掃描件)');
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
    if (!days.length) throw new Error('找不到「表報編號」頁(此檔非東震格式)');
  }
  const filled = days.filter((d) => d.header.填報日期 != null
    || d.dailyRows.some((r) => r.本日完成數量));
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填表日期(此檔版面不是東震的)');
  }
  return filled.sort((x, y) => String(x.header.填報日期).localeCompare(String(y.header.填報日期)));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 兩條路都驗:Excel 用真實儲存格(第 1 天)、PDF 用真實座標(第 1 頁),
 * 只換工程名稱。重點是「天的起點由表頭推出」與「PDF 的項次/名稱都在表頭左邊」。
 */
function selfTest(ft) {
  // ── Excel(兩天,一天 10 欄)──
  const g = [];
  const put = (r, c, v) => { g[r] = g[r] || []; g[r][c] = v; };
  const span = (r, from, to, v) => { for (let c = from; c <= to; c++) put(r, c, v); };
  const day = (o, serial, 預定, 實際, rows) => {
    span(0, o, o + 7, '公共工程施工日誌'); span(0, o + 8, o + 9, '這兩欄印出前隱藏');
    put(1, o, '表報編號：'); put(1, o + 1, 1);
    put(2, o, '本日天氣：上午：多雲 下午：晴'); put(2, o + 5, '填表日期：');
    span(2, o + 6, o + 7, serial);
    put(3, o, '工程名稱'); span(3, o + 1, o + 4, '測試工程');
    put(3, o + 5, '承攬廠商名稱'); span(3, o + 6, o + 7, META_VENDOR_KEY);
    put(4, o, '核定工期'); put(4, o + 1, 30);
    put(5, o, '開工日期'); span(5, o + 1, o + 3, 46101);
    put(5, o + 4, '完工日期'); span(5, o + 5, o + 7, 46130);
    put(6, o, '預定進度(%)'); span(6, o + 1, o + 3, 預定);
    put(6, o + 4, '實際進度(%)'); span(6, o + 5, o + 7, 實際);
    span(7, o, o + 7, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）');
    span(8, o, o + 2, '施工項目'); put(8, o + 3, '單位'); put(8, o + 4, '契約數量');
    put(8, o + 5, '本日完成數量'); put(8, o + 6, '累計完成數量'); put(8, o + 7, '備註');
    put(8, o + 8, '契約單價'); put(8, o + 9, '本日完成金額');
    rows.forEach((rw, i) => {
      const r = 9 + i;
      put(r, o, rw[0]); span(r, o + 1, o + 2, rw[1]); put(r, o + 3, rw[2]);
      put(r, o + 4, rw[3]); put(r, o + 5, rw[4]); put(r, o + 6, rw[5]);
      put(r, o + 8, rw[6]); put(r, o + 9, rw[7]);
    });
    span(12, o, o + 2, '營造業專業工程特定施工項目');
    span(20, o, o + 7, '公共工程施工日誌');
    put(21, o, '表報編號：'); put(21, o + 1, 1);
    span(23, o, o + 7, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）');
    put(24, o, '材料名稱'); put(24, o + 1, '單位'); put(24, o + 2, '契約數量');
    span(24, o + 3, o + 4, '本日使用數量'); span(24, o + 5, o + 6, '累計使用數量'); put(24, o + 7, '備註');
    span(26, o, o + 7, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）');
    put(27, o, '工別'); put(27, o + 1, '本日人數'); put(27, o + 2, '累計人數');
    span(27, o + 3, o + 4, '機具名稱'); put(27, o + 5, '本日使用數量'); span(27, o + 6, o + 7, '累計使用數量');
    put(28, o, '鐵工'); span(28, o + 1, o + 2, 0); span(28, o + 3, o + 4, '卡車'); span(28, o + 5, o + 7, 0);
    put(29, o, '粗工'); span(29, o + 1, o + 2, 10); span(29, o + 3, o + 4, '吊車'); span(29, o + 5, o + 7, 1);
    span(31, o, o + 7, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');
  };
  day(0, 46101, 0.028463500000000003, 0.03705976896032145, [
    ['A.壹.1', '工程告示牌、職業安全衛生告示牌與管制措施(租用)', '式', 1, 0, 0, 2837, 0],
    ['B.壹.3', '車棚周遭鋸除清運黑板樹離地30cm以上樹幹與枝葉;環境清潔', '式', 1, 0.5, 0.5, 105661, 52831],
    ['貳', '職業安全衛生管理費與施工環境保護與清潔（壹*2%）', '式', 1, 0.033, 0.033, 34356, 1134],
  ]);
  day(10, 46102, 0.056927, 0.06943847312908086, [
    ['A.壹.1', '工程告示牌、職業安全衛生告示牌與管制措施(租用)', '式', 1, 1, 1, 2837, 2837],
  ]);

  const lay = layoutOf(g);
  if (!lay || lay.origins.length !== 2 || lay.hr !== 8) return false;
  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d1 = parseDayGrid(g, lay.origins[0], lay.origins[1], lay.hr, serial);
  if (d1.header.工程名稱 !== '測試工程' || d1.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d1.header.填報日期 !== '2026-03-20') return false;
  if (serial && d1.header.開工日期 !== '2026-03-20') return false;
  if (d1.header.天氣_上午 !== '多雲' || d1.header.天氣_下午 !== '晴') return false;
  if (d1.header.出工總人數 !== 10) return false;             // 鐵工 0 + 粗工 10
  if (d1.extras.主要機具.length !== 1) return false;         // 卡車 0 不列
  if (d1.dailyRows.length !== 3) return false;
  const [a1, b3, fee] = d1.dailyRows;
  if (a1.項次 !== 'A.壹.1' || a1.單位 !== '式' || a1.契約單價 !== 2837) return false;
  if (b3.項次 !== 'B.壹.3' || b3.本日完成金額 !== 52831) return false;
  if (Math.abs(b3.本日完成金額 - b3.本日完成數量 * b3.契約單價) > 0.5) return false;
  if (fee.項次 !== '貳' || fee.本日完成金額 !== 1134) return false;

  // ── PDF ──
  const it = (x, y, w, s) => ({ x, y, w, s });
  const items = [
    it(244.8, 789.1, 81.6, '公共工程施工日誌'),
    it(44.4, 778.2, 34.8, '表報編號:'), it(79.6, 778.2, 3.5, '1'),
    it(44.4, 768.7, 104.4, '本日天氣:上午:多雲  下午:晴'),
    it(406.2, 768.7, 34.8, '填表日期:'), it(448.7, 768.7, 41.8, '115年3月20日'),
    it(501.5, 768.7, 20.9, '星期五'),
    it(443.9, 755.9, 69.6, META_VENDOR_KEY),
    it(79.6, 755.8, 254.0, '測試工程'),
    it(47.0, 755.4, 27.8, '工程名稱'), it(397.8, 755.4, 41.8, '承攬廠商名稱'),
    it(194.9, 732.4, 41.8, '115年3月20日'), it(440.2, 732.4, 41.8, '115年4月18日'),
    it(47.0, 731.9, 27.8, '開工日期'), it(359.7, 731.9, 27.8, '完工日期'),
    it(207.1, 722.5, 17.4, '2.85%'), it(452.4, 722.5, 17.4, '3.71%'),
    it(41.9, 722.0, 38.3, '預定進度(%)'), it(354.6, 722.0, 38.3, '實際進度(%)'),
    it(44.4, 712.2, 243.6, '一、依施工計畫書執行按圖施工概況(含約定之重要施工項目及完成數量等):'),
    it(165.4, 702.8, 27.8, '施工項目'),
    it(327.1, 702.4, 13.9, '單位'), it(359.8, 702.4, 27.8, '契約數量'),
    it(397.8, 702.4, 41.8, '本日完成數量'), it(448.7, 702.4, 41.8, '累計完成數量'),
    it(505.0, 702.4, 13.9, '備註'),
    it(79.6, 692.6, 176.7, '工程告示牌、職業安全衛生告示牌與管制措施(租用)'),
    it(427.1, 692.5, 13.9, '0.00'), it(476.9, 692.5, 13.9, '0.00'),
    it(49.4, 692.3, 23.0, 'A.壹.1'), it(330.2, 692.3, 7.6, '式'), it(384.8, 692.3, 3.8, '1'),
    it(79.6, 682.8, 53.8, '施工圍籬(租用)'),
    it(427.1, 682.7, 13.9, '0.00'), it(476.9, 682.7, 13.9, '0.00'),
    it(49.4, 682.4, 23.0, 'A.壹.2'), it(332.2, 682.4, 3.8, 'M'), it(381.0, 682.4, 7.7, '58'),
    it(44.4, 500.0, 131.0, '營造業專業工程特定施工項目'),
  ];
  const p = parsePage(items);
  if (p.header.工程名稱 !== '測試工程') return false;
  if (p.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (p.header.填報日期 !== '2026-03-20' || p.header.星期 !== '星期五') return false;
  if (p.header.開工日期 !== '2026-03-20') return false;
  if (p.header.天氣_上午 !== '多雲' || p.header.天氣_下午 !== '晴') return false;
  if (p.header.預定進度 !== 2.85 || p.header.實際進度 !== 3.71) return false;
  if (p.dailyRows.length !== 2) return false;
  if (p.dailyRows[0].項次 !== 'A.壹.1') return false;
  if (p.dailyRows[0].工程項目 !== '工程告示牌、職業安全衛生告示牌與管制措施(租用)') return false;
  if (p.dailyRows[0].單位 !== '式' || p.dailyRows[0].契約數量 !== 1) return false;
  // PDF 版把單價與金額那兩欄隱藏了(活頁簿裡標著「這兩欄印出前隱藏」)
  if (p.dailyRows[0].契約單價 !== null || p.dailyRows[0].本日完成金額 !== null) return false;
  if (p.dailyRows[1].項次 !== 'A.壹.2' || p.dailyRows[1].契約數量 !== 58) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDayGrid, parsePage, layoutOf },
};
