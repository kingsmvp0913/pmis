/**
 * akui.pmisparser.js — 阿奎營造施工日誌讀取器(新社高中弘揚樓廁所)
 *
 * vendorKey 取自**決標公告的得標廠商**(新社案:阿奎營造有限公司),
 * 日誌 a+2 欄 9 的「承攬廠商名稱」也載明同一個名稱,兩邊一致。
 *
 * ⚠️ **這家 14 份日誌裡只有 1 份讀得動。** 其餘 13 份是 7~35MB 的紙本掃描 PDF,
 * 沒有文字層(extractItems 抽得到頁數但一個字都沒有),不是本讀取器能處理的範圍。
 * 交付時要說清楚:此家的覆蓋率是 1/14,不是「已完成」。
 *
 * ── 版面事實(實測)──
 * .xls 七分頁(`工期不計|內容|施工|監造|施工封面|監造封面|晴雨表`),
 * **一個檔就是一天**,逐日內容在 `施工` 分頁,不是垂直堆疊的多天區塊。
 *
 * 相對錨點列 a(欄 0 去空白後等於「表報編號：」):
 *   a+1  欄2=上午天氣  欄4=下午天氣  欄8=填表日期(Excel 序號)
 *   a+2  欄1=工程名稱  欄9=承攬廠商名稱
 *   a+4  欄1=開工日期(序號)
 *   a+5  欄1=預定進度  欄8=實際進度
 *   a+8  明細表頭      a+9 起是明細
 *
 * ── 兩個會讓值變 null 的細節 ──
 * ① 表頭的「預算數量」橫跨欄 3~4,但**合併範圍逐列不同**:多數列欄 4 是單位字串
 *    (「式」)跨進來的、費用項那幾列欄 4 卻是數量。只讀合併起點欄會在某些列讀到
 *    字串而變 null。改成在欄段內往右掃到第一個數字。
 * ② 明細區的結尾**不是空白列而是一整排數字 0**(欄 0 = 0)。用「名稱為空」當停止
 *    條件會把那些 0 收成項目名稱叫「0」的列。
 *
 * ── 此格式沒有的東西 ──
 * 沒有項次欄(以出現序補)、沒有契約單價、沒有任何金額,一律 null 不由別處回推。
 * 也**沒有大類列**:費用項(職安/品管/包商/保險/營業稅)在此格式就是一般明細,
 * 所以出現序不需要排除任何列。
 */

const META_VENDOR_KEY = '阿奎營造有限公司';

const SHEET = '施工';
const ANCHOR = '表報編號：';

const OFF = { 天氣: 1, 名稱: 2, 開工: 4, 進度: 5, 表頭: 8 };
const SPAN = { 單位: [2, 2], 契約數量: [3, 4], 本日完成數量: [5, 5], 累計完成數量: [6, 7] };

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間', '天', '日', '趟',
  '才', '公尺', '公斤', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道']);

const despace = (v) => String(v == null ? '' : v).replace(/[\s　]/g, '');

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

/** 在 [from,to] 這段裡取第一個數字(合併範圍逐列不同,見檔頭①)。 */
function numInSpan(grid, r, [from, to]) {
  for (let c = from; c <= to; c++) {
    const n = numOf(at(grid, r, c));
    if (n != null) return n;
  }
  return null;
}

function unitOf(grid, r) {
  const v = text(at(grid, r, SPAN.單位[0]));
  if (v == null) return null;
  const s = String(v).normalize('NFKC').trim();
  return KNOWN_UNITS.has(s) ? s : null;                 // 白名單,不逐字收
}

const unitText = (v) => {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;
};

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid `施工` 分頁
 * @param {number} a 錨點列
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, serialToISO) {
  const dailyRows = [];
  let seq = 0;
  for (let r = a + OFF.表頭 + 1; r < grid.length; r++) {
    const raw = text(at(grid, r, 0));
    if (raw == null) break;
    // 明細區的結尾是一整排數字 0,不是空白列(見檔頭②)
    if (/^\d+(\.\d+)?$/.test(raw)) break;
    if (/^[一二三四五六七八]、/.test(raw)) break;
    seq++;
    dailyRows.push({
      // 此格式沒有項次欄,也沒有大類列(費用項就是一般明細),出現序不排除任何列。
      項次: String(seq),
      工程項目: raw,
      單位: unitOf(grid, r),
      契約單價: null,                                    // 此格式無單價
      契約數量: numInSpan(grid, r, SPAN.契約數量),
      本日完成數量: numInSpan(grid, r, SPAN.本日完成數量),
      本日完成金額: null,                                // 此格式無金額
      累計完成數量: numInSpan(grid, r, SPAN.累計完成數量),
    });
  }

  // 出工/機具:表頭列欄 0 為「工別」,其後 欄0=工別 欄1=本日人數 欄3=累計人數、
  // 欄5=機具名稱 欄7=本日使用。沒出工時只填累計欄,取錯欄會讓總人數整份偏高。
  const extras = {};
  let 出工總人數 = null;
  let crewRow = -1;
  for (let r = a + OFF.表頭; r < grid.length; r++) {
    if (despace(at(grid, r, 0)) === '工別') { crewRow = r; break; }
  }
  if (crewRow >= 0) {
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = crewRow + 1; r < grid.length; r++) {
      const 工別 = text(at(grid, r, 0));
      if (工別 == null || /^[一二三四五六七八]、/.test(工別) || /^\d+(\.\d+)?$/.test(工別)) break;
      出工明細.push({ 工別, 人數: numInSpan(grid, r, [1, 2]) });
      const 機具 = text(at(grid, r, 5));
      if (機具 != null && !/^\d+(\.\d+)?$/.test(機具)) {
        主要機具.push({ 名稱: 機具, 數量: numInSpan(grid, r, [7, 8]) });
      }
    }
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  const iso = (v) => {
    const n = numOf(v);
    return n != null && serialToISO ? serialToISO(n) : null;
  };
  return {
    header: {
      工程名稱: text(at(grid, a + OFF.名稱, 1)),
      填報日期: iso(at(grid, a + OFF.天氣, 8)),
      星期: null,                                        // 此格式不提供
      天氣_上午: text(at(grid, a + OFF.天氣, 2)),
      天氣_下午: text(at(grid, a + OFF.天氣, 4)),
      預定進度: numOf(at(grid, a + OFF.進度, 1)),
      實際進度: numOf(at(grid, a + OFF.進度, 8)),
      出工總人數,
      本日累計金額: null,                                 // 此格式無金額
      承包廠商: text(at(grid, a + OFF.名稱, 9)),
      開工日期: iso(at(grid, a + OFF.開工, 1)),
    },
    dailyRows,
    extras,
  };
}

function blockStarts(grid) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    if (despace(at(grid, r, 0)) === ANCHOR) out.push(r);
  }
  return out;
}

const CONTENT_WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const CONTENT_WEATHER = ['雨天', '晴天', '陰天'];

function contentWord(values, v) {
  const n = numOf(v);
  return n != null && n >= 0 && n < values.length ? values[n] : null;
}

function round2(v) {
  const n = numOf(v);
  return n == null ? null : Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── 新社高中 Excel：單日顯示頁底下的橫向逐日資料 ────────────
function parseLegacyContentWorkbook(wb, serialToISO) {
  const grid = wb.sheets['內容'];
  if (!grid || despace(at(grid, 13, 5)) !== '日期'
    || !despace(at(grid, 21, 2)).includes('重要施工項目完成數量')) return null;

  const itemRows = [];
  for (let r = 24; r <= 59; r++) {
    const no = text(at(grid, r, 0));
    const name = text(at(grid, r, 2));
    if (no && name && /^\d+$/.test(no)) itemRows.push(r);
  }
  if (!itemRows.length) return null;

  const crewRows = [122, 123, 124, 125, 126];
  const machineRows = [128, 129, 130, 131, 132, 133];
  const firstDate = numOf(at(grid, 10, 3));
  const days = [];
  for (let c = 9; c < (grid[117] || []).length; c++) {
    const dateSerial = numOf(at(grid, 117, c));
    const hasWeather = numOf(at(grid, 119, c)) != null || numOf(at(grid, 120, c)) != null;
    const hasEntry = [...itemRows, ...crewRows, ...machineRows, 138]
      .some((r) => text(at(grid, r, c)) != null);
    // 這份範本在遠端未來欄又預填天氣；第一個完全空白日就是本次已填區間的結尾。
    if (dateSerial == null || (!hasWeather && !hasEntry)) break;

    const dailyRows = itemRows.map((r) => {
      let cumulative = 0;
      for (let k = 9; k <= c; k++) cumulative += numOf(at(grid, r, k)) || 0;
      return {
        項次: text(at(grid, r, 0)),
        工程項目: text(at(grid, r, 2)),
        單位: unitText(at(grid, r, 3)),
        契約單價: null,
        契約數量: numOf(at(grid, r, 4)),
        本日完成數量: numOf(at(grid, r, c)),
        本日完成金額: null,
        累計完成數量: cumulative,
      };
    });
    const 出工明細 = crewRows.map((r) => ({ 工別: text(at(grid, r, 7)), 人數: numOf(at(grid, r, c)) }))
      .filter((x) => x.工別);
    const 主要機具 = machineRows.map((r) => ({ 名稱: text(at(grid, r, 7)), 數量: numOf(at(grid, r, c)) }))
      .filter((x) => x.名稱);
    const 有人數 = 出工明細.filter((x) => x.人數 != null);
    days.push({
      header: {
        工程名稱: text(at(grid, 0, 3)),
        填報日期: serialToISO(dateSerial),
        星期: contentWord(CONTENT_WEEKDAYS, numOf(at(grid, 118, c)) - 1),
        天氣_上午: contentWord(CONTENT_WEATHER, at(grid, 119, c)),
        天氣_下午: contentWord(CONTENT_WEATHER, at(grid, 120, c)),
        預定進度: round2(at(grid, 12, c)),
        實際進度: round2(at(grid, 9, c)),
        出工總人數: 有人數.length ? 有人數.reduce((sum, x) => sum + x.人數, 0) : null,
        本日累計金額: null,
        承包廠商: META_VENDOR_KEY,
        開工日期: firstDate == null ? null : serialToISO(firstDate),
      },
      dailyRows,
      extras: { 出工明細, 主要機具 },
    });
  }
  if (!days.length) throw new Error('「內容」工作表沒有已填寫的施工日誌');
  return days;
}

// ── 外埔 Excel：橫向逐日資料 ───────────────────────────────
// 「日誌」只顯示目前選取的一天；完整資料在「數量表」(每欄一天)與「出工表」(每列一天)。
function parseHorizontalWorkbook(wb, serialToISO) {
  const qty = wb.sheets['數量表'];
  const crew = wb.sheets['出工表'];
  if (!qty || !crew || despace(at(qty, 3, 3)) !== '日期') {
    throw new Error('找不到「數量表/出工表」逐日資料(此檔非阿奎外埔格式)');
  }
  const itemRows = [];
  for (let r = 12; r < qty.length; r++) {
    const no = text(at(qty, r, 0));
    const name = text(at(qty, r, 1));
    if (no && name && /^(?:\d+|[貳參肆伍陸柒])$/.test(no)) itemRows.push(r);
  }

  const days = [];
  for (let c = 4; c < (qty[3] || []).length; c++) {
    const dateSerial = numOf(at(qty, 3, c));
    const cr = c - 3;
    const crewValues = crew[cr] || [];
    const hasCrewData = crewValues.slice(1).some((v) => text(v) != null);
    const hasQuantity = itemRows.some((r) => numOf(at(qty, r, c)) != null);
    if (dateSerial == null || (!hasCrewData && !hasQuantity)) continue;

    const dailyRows = itemRows.map((r) => {
      let cumulative = 0;
      let hasCumulative = false;
      for (let k = 4; k <= c; k++) {
        const n = numOf(at(qty, r, k));
        if (n != null) { cumulative += n; hasCumulative = true; }
      }
      return {
        項次: text(at(qty, r, 0)),
        工程項目: text(at(qty, r, 1)),
        單位: unitText(at(qty, r, 3)),
        契約單價: null,
        契約數量: numOf(at(qty, r, 2)),
        本日完成數量: numOf(at(qty, r, c)),
        本日完成金額: null,
        累計完成數量: hasCumulative ? cumulative : null,
      };
    });

    const 出工明細 = [];
    for (let k = 3; k <= 5; k++) {
      const 工別 = text(at(crew, 0, k));
      if (工別) 出工明細.push({ 工別, 人數: numOf(at(crew, cr, k)) });
    }
    const 主要機具 = [];
    for (const k of [7, 8, 9, 11, 12, 13]) {
      const 名稱 = text(at(crew, 0, k));
      if (名稱) 主要機具.push({ 名稱, 數量: numOf(at(crew, cr, k)) });
    }
    const 有人數 = 出工明細.filter((x) => x.人數 != null);
    days.push({
      header: {
        工程名稱: text(at(qty, 0, 1)),
        填報日期: serialToISO(dateSerial),
        星期: text(at(qty, 4, c)),
        天氣_上午: text(at(crew, cr, 1)),
        天氣_下午: text(at(crew, cr, 2)),
        預定進度: numOf(at(qty, 8, c)),
        實際進度: numOf(at(qty, 9, c)),
        出工總人數: 有人數.length ? 有人數.reduce((sum, x) => sum + x.人數, 0) : null,
        本日累計金額: null,
        承包廠商: text(at(qty, 8, 1)),
        開工日期: serialToISO(numOf(at(qty, 4, 1))),
      },
      dailyRows,
      extras: { 出工明細, 主要機具 },
    });
  }
  if (!days.length) throw new Error('「數量表/出工表」沒有已填寫的施工日誌');
  return days;
}

// ── 外埔 PDF：工程會標準日誌，每天兩頁 ─────────────────────
const PDF_ITEM_NO = /^(?:\d{1,2}|[貳參肆伍陸柒])$/;

function rocTextToISO(v) {
  const m = /(\d{2,4})年(\d{1,2})月(\d{1,2})日/.exec(despace(v));
  if (!m) return null;
  const year = Number(m[1]) < 1911 ? Number(m[1]) + 1911 : Number(m[1]);
  return `${year}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

const pdfJoin = (items) => items.slice().sort((a, b) => (Math.abs(a.y - b.y) > 1 ? b.y - a.y : a.x - b.x))
  .map((i) => String(i.s || '').trim()).filter(Boolean).join('');

function parsePdfHeader(items) {
  const dateLine = pdfJoin(items.filter((i) => i.y > 795 && i.x > 420));
  const weather = pdfJoin(items.filter((i) => i.y > 795 && i.y < 805 && i.x > 140 && i.x < 240));
  const progress = pdfJoin(items.filter((i) => i.y > 758 && i.y < 766 && i.x < 470));
  const pm = /預定進度\(%\)([\d.]+)%/.exec(progress);
  const am = /實際進度\(%\)([\d.]+)%/.exec(progress);
  const wm = /上午:(.{1,3})下午:(.{1,3})/.exec(despace(weather));
  const name = pdfJoin(items.filter((i) => i.y > 787 && i.y < 794 && i.x > 160 && i.x < 420));
  const vendor = pdfJoin(items.filter((i) => i.y > 787 && i.y < 794 && i.x > 470));
  const startLine = pdfJoin(items.filter((i) => i.y > 768 && i.y < 775 && i.x < 370));
  return {
    工程名稱: text(name),
    填報日期: rocTextToISO(dateLine),
    星期: ((/[（(](?:週|星期)(.)[）)]/.exec(dateLine) || [])[1]) || null,
    天氣_上午: wm ? text(wm[1]) : null,
    天氣_下午: wm ? text(wm[2]) : null,
    // Excel 原稿存比例(0.0065)，PDF 印百分數(0.65%)；同一家兩載體統一回比例。
    預定進度: pm ? Number(pm[1]) / 100 : null,
    實際進度: am ? Number(am[1]) / 100 : null,
    出工總人數: null,
    本日累計金額: null,
    承包廠商: text(vendor),
    開工日期: rocTextToISO(startLine),
  };
}

function parsePdfMainPage(items) {
  const anchors = items.filter((i) => i.y > 130 && i.y < 735 && i.x > 60 && i.x < 100
    && PDF_ITEM_NO.test(String(i.s || '').trim())).sort((a, b) => b.y - a.y);
  if (!anchors.length) return null;
  const dailyRows = anchors.map((anchor, index) => {
    const hi = index === 0 ? 735 : (anchors[index - 1].y + anchor.y) / 2;
    const lo = index === anchors.length - 1 ? 130 : (anchor.y + anchors[index + 1].y) / 2;
    const zone = items.filter((i) => i.y < hi && i.y >= lo);
    const value = (from, to) => numOf(pdfJoin(zone.filter((i) => i.x >= from && i.x < to)));
    return {
      項次: String(anchor.s).trim(),
      工程項目: text(pdfJoin(zone.filter((i) => i.x >= 95 && i.x < 330))),
      單位: unitText(pdfJoin(zone.filter((i) => i.x >= 330 && i.x < 370))),
      契約單價: null,
      契約數量: value(370, 423),
      本日完成數量: value(423, 476),
      本日完成金額: null,
      累計完成數量: value(476, 530),
    };
  }).filter((r) => r.工程項目);
  return { header: parsePdfHeader(items), dailyRows, extras: {} };
}

function parsePdfSupplement(items) {
  const header = parsePdfHeader(items);
  const rows = [676.5, 667.9, 659.3];
  const near = (y, from, to) => pdfJoin(items.filter((i) => Math.abs(i.y - y) < 1.2 && i.x >= from && i.x < to));
  const 出工明細 = rows.map((y) => ({ 工別: text(near(y, 50, 100)), 人數: numOf(near(y, 100, 150)) }))
    .filter((x) => x.工別);
  const 主要機具 = rows.map((y) => ({ 名稱: text(near(y, 365, 420)), 數量: numOf(near(y, 420, 470)) }))
    .filter((x) => x.名稱);
  const 有人數 = 出工明細.filter((x) => x.人數 != null);
  return {
    date: header.填報日期,
    extras: { 出工明細, 主要機具 },
    出工總人數: 有人數.length ? 有人數.reduce((sum, x) => sum + x.人數, 0) : null,
  };
}

async function parsePdfAll(filePath, ft) {
  const pages = await ft.extractItems(filePath);
  const days = [];
  const byDate = new Map();
  for (const page of pages) {
    const items = page.items || page;
    const day = parsePdfMainPage(items);
    if (day && day.header.填報日期 && day.dailyRows.length) {
      days.push(day);
      byDate.set(day.header.填報日期, day);
      continue;
    }
    const extra = parsePdfSupplement(items);
    const target = byDate.get(extra.date);
    if (target) {
      target.extras = extra.extras;
      target.header.出工總人數 = extra.出工總人數;
    }
  }
  if (!days.length) throw new Error('PDF 裡找不到阿奎施工日誌明細');
  return days;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (/\.pdf$/i.test(String(filePath))) {
    if (!ft || typeof ft.extractItems !== 'function') throw new Error('缺少注入的 filetypes.extractItems');
    return parsePdfAll(filePath, ft);
  }
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  if (wb.sheets['數量表'] && wb.sheets['出工表']) {
    return parseHorizontalWorkbook(wb, ft.excelSerialToISO);
  }
  const contentDays = parseLegacyContentWorkbook(wb, ft.excelSerialToISO);
  if (contentDays) return contentDays;
  const grid = wb.sheets[SHEET];
  const starts = grid ? blockStarts(grid) : [];
  if (!starts.length) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。此家 13/14 份是無文字層的
    // 掃描 PDF,SheetJS 對它會回一份空活頁簿——一定要明講。
    throw new Error('找不到「表報編號」區塊(此檔非阿奎格式,或是無文字層的掃描件)');
  }
  return starts.map((a) => parseDay(grid, a, ft.excelSerialToISO));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/** selfTest 用**真實座標**造一天(取自 `施工日誌7.28.xls`,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  set(0, 0, 28); set(0, 5, '公共工程施工日誌');
  set(1, 0, '表 報 編 號：'); set(1, 1, 28);
  set(2, 0, '本 日 天 氣：'); set(2, 1, '上午：'); set(2, 2, '晴天');
  set(2, 3, '下午：'); set(2, 4, '雨天'); set(2, 7, '填 表 日 期：'); set(2, 8, 45501);
  set(3, 0, '工 程 名 稱'); set(3, 1, '測試工程'); set(3, 8, '承 攬 廠 商 名 稱'); set(3, 9, META_VENDOR_KEY);
  set(5, 0, '開 工 日 期'); set(5, 1, 45474);
  set(6, 0, '預 定 進 度 (%)'); set(6, 1, 9.42); set(6, 8, 14.52);
  set(9, 0, '施工項目'); set(9, 2, '單 位'); set(9, 3, '預 算 數 量');
  set(9, 5, '本 日 完 成 數 量'); set(9, 6, '累 計 完 成 數 量');
  // 第 1 列:那天整列沒填(來源就空著),但它仍是一個項目,要佔項次
  set(10, 0, '工程告示牌、施工圍籬、警示帶、安全警示燈等安全措施(租用)'); set(10, 10, 26);
  // 第 2 列:欄 4 是單位「式」跨進了預算數量的合併範圍 —— 只讀欄 4 會讀到字串
  set(11, 0, '施工動線開闢與損壞復原'); set(11, 2, '式'); set(11, 3, 1); set(11, 4, '式');
  set(11, 5, 0); set(11, 6, 0); set(11, 7, 0);
  // 第 3 列:費用項,同一個欄 4 這次是數量
  set(12, 0, '職業安全衛生管理費(壹*0.6%)'); set(12, 2, '式'); set(12, 3, 1); set(12, 4, 1);
  set(12, 5, 0.01); set(12, 6, 0.28); set(12, 7, 0.28);
  // 明細的結尾是一整排 0,不是空白列
  set(13, 0, 0); set(13, 1, 0); set(13, 2, 0);
  set(15, 0, '工 別'); set(15, 1, '本 日 人 數'); set(15, 3, '累 計 人 數'); set(15, 5, '機 具 名 稱');
  set(16, 0, '小工'); set(16, 1, 2); set(16, 3, 68); set(16, 5, 0);
  set(17, 0, '技術工'); set(17, 3, 16);                    // 只有累計 → 本日 null
  set(18, 0, 0);

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseDay(g, 1, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2024-07-28') return false;
  if (serial && d.header.開工日期 !== '2024-07-01') return false;
  if (d.header.天氣_上午 !== '晴天' || d.header.天氣_下午 !== '雨天') return false;
  if (d.header.預定進度 !== 9.42 || d.header.實際進度 !== 14.52) return false;
  if (d.dailyRows.length !== 3) return false;              // 一整排 0 不算明細
  const [r1, r2, r3] = d.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== null || r1.契約數量 !== null) return false;
  if (r2.項次 !== '2' || r2.單位 !== '式' || r2.契約數量 !== 1) return false;  // 欄 4 的「式」不可害它變 null
  if (r3.項次 !== '3' || r3.契約數量 !== 1 || r3.本日完成數量 !== 0.01) return false;
  if (r3.累計完成數量 !== 0.28) return false;
  if (r3.契約單價 !== null || r3.本日完成金額 !== null) return false;
  if (d.header.出工總人數 !== 2) return false;             // 技術工只有累計欄,不計
  if (d.extras.出工明細.find((c) => c.工別 === '技術工').人數 !== null) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.2.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: {
    parseDay, blockStarts, numInSpan, unitOf, parseLegacyContentWorkbook, parseHorizontalWorkbook,
    parsePdfMainPage, parsePdfSupplement,
  },
};
