/**
 * guoqian.pmisparser.js — 國謙營造有限公司施工日誌讀取器(林內國中射箭場側網修復)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄與分頁第 0 列
 * 也都是同一個名稱,三邊一致。
 *
 * ── 版面事實(實測 2 份 xlsx / 42 天)──
 * 單一分頁 `日誌`,**天是橫向排列的**:一天佔 16 欄(第 1 天欄 0~15、第 2 天欄 16~31…),
 * 縱向則是兩聯疊在一起:
 *   r0~r56  第一聯(天氣/日期/工期/進度/出工機具);它的明細表只列當天施作的項目,不採用
 *   r57~    第二聯「完成工程詳細表」= 完整明細,dailyRows 取這一聯
 *   r62 是第二聯的表頭:項次 / 工程項目 / 單位 / 契約數量 / 本日完成數量 /
 *        累計完成數量 / 備註 / 契約單價 / 完成金額
 * **天的起點一律由「表頭列裡值為『項次』的每一欄」推出**,不用寫死的 16:
 * 兩份檔一份 22 天(352 欄)、一份 42 天(672 欄),欄數會長。
 *
 * ── 三個坑 ──
 * ① **同一列的「預定進度」是百分數、「實際進度」是分數**。實測第 42 天:預定 63、
 *    實際 1(=100%);第 1 天:預定 0.5、實際 0.00123。63 不可能是 6300%,1 也不可能
 *    是 1%(那天工程已完工),所以兩欄單位不同是確定的。**統一成百分數輸出**
 *    (實際 ×100),否則同一天的兩個數字沒有可比性,SP3 的 H1 也會亂判。
 * ② **「完成金額」是本日金額不是累計**。標籤沒說。用算式在整份檔上核對:第 16 天
 *    項次 3 的本日 1、累計 2、單價 7150,而金額 = 7150(= 本日 × 單價,若是累計
 *    應為 14300);項次 4 的本日 0.2 × 71500 = 14300 也對得上。
 * ③ **工程名稱與填報日期是「標籤＋值黏在同一格」**(`工程名稱：114-Danas-…`、
 *    `填報日期：115年3月11日(星期三)`),不是分成兩格。要在格內切,不能往右找。
 *
 * ── 已知的來源資料問題(不是讀取器讀錯)──
 * 項次 1「既有傾斜高網修復」從第 6 天起累計完成數量是 25,但**本日完成數量從頭到尾
 * 空白、完成金額都是 0**。SP3 的 B3(逐日累加金額 vs 累計數量×單價)因此每天硬錯。
 * 那是廠商只填累計、沒填當日,不是抽不到。
 *
 * ── 此格式沒有的東西 ──
 * 沒有日層級的累計金額。材料表實測全空(程式照收,有才填)。
 * 同案的 3 月份 PDF 與 xlsx 是同一批日子,不另做。
 */

const META_VENDOR_KEY = '國謙營造有限公司';

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
const SECTION = /^[一二三四五六七八九十]+、/;

const nfkc = (v) => String(v == null ? '' : v).normalize('NFKC');
const despace = (v) => nfkc(v).replace(/[\s　]/g, '');

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
  const s = despace(v);
  return s && KNOWN_UNITS.has(s) ? s : null;
};

/** 民國/西元「115年3月11日」→ ISO。 */
function rocTextToISO(v) {
  const m = despace(v).match(/(\d{2,4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(Number(m[2]))}-${p(Number(m[3]))}`;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 在某列的 [from, to) 欄裡找第一個去空白後等於 label 的欄。 */
function colIn(row, from, to, label) {
  for (let c = from; c < to; c++) if (despace((row || [])[c]) === label) return c;
  return -1;
}

/** 在某天的欄段裡,找欄 from 的值符合 re 的列。 */
function rowIn(grid, from, r0, r1, re) {
  for (let r = r0; r < r1; r++) if (re.test(despace(at(grid, r, from)))) return r;
  return -1;
}

/** 取 label 右邊第一個非空、且與 label 不同的值(合併填充後標籤佔好幾欄)。 */
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

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid `日誌` 分頁
 * @param {number} o 這一天的起始欄
 * @param {number} to 下一天的起始欄(或列寬)
 * @param {number} hr 第二聯表頭所在列
 */
function parseDay(grid, o, to, hr) {
  // ── 第一聯(表頭列以上)──
  const wr = rowIn(grid, o, 0, hr, /^本日天氣/);
  const nr = rowIn(grid, o, 0, hr, /^工程名稱/);
  const sr = rowIn(grid, o, 0, hr, /^開工日期$/);
  const pr = rowIn(grid, o, 0, hr, /^預定進度/);
  const cr = rowIn(grid, o, 0, hr, /^工別$/);

  // 標籤與值黏在同一格(見檔頭③):在格內切
  const inCell = (r, re) => {
    if (r < 0) return null;
    for (let c = o; c < to; c++) {
      const m = nfkc(at(grid, r, c)).match(re);
      if (m) return m[1];
    }
    return null;
  };
  const 天氣句 = wr < 0 ? '' : nfkc(valueRight(grid[wr], o, to, '本日天氣') || '');
  const am = 天氣句.match(/上午[:：]\s*(\S+?)(?=[\s　]|下午|$)/);
  const pm = 天氣句.match(/下午[:：]\s*(\S+?)(?=[\s　]|$)/);
  const 日期句 = inCell(wr, /填報日期[:：]\s*(.+)$/);
  const week = 日期句 ? (nfkc(日期句).match(/星期[一二三四五六日天]/) || [])[0] : null;

  const extras = {};
  let 出工總人數 = null;
  if (cr >= 0) {
    const hdr = grid[cr];
    const c人數 = colIn(hdr, o, to, '本日人數');
    const c機具 = colIn(hdr, o, to, '機具名稱');
    const c機數 = colIn(hdr, o, to, '本日使用數量');
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = cr + 1; r < hr; r++) {
      const w = text(at(grid, r, o));
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

  // ── 第二聯:完整明細 ──
  const hdr = grid[hr] || [];
  const c名稱 = colIn(hdr, o, to, '工程項目');
  const c單位 = colIn(hdr, o, to, '單位');
  const c契約 = colIn(hdr, o, to, '契約數量');
  const c本日 = colIn(hdr, o, to, '本日完成數量');
  const c累計 = colIn(hdr, o, to, '累計完成數量');
  const c單價 = colIn(hdr, o, to, '契約單價');
  const c金額 = colIn(hdr, o, to, '完成金額');
  if ([c名稱, c單位, c契約, c本日, c累計].some((c) => c < 0)) {
    throw new Error('第二聯表頭欄位找不到(非國謙格式?)');
  }
  const dailyRows = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const 項次 = text(at(grid, r, o));
    const 名稱 = text(at(grid, r, c名稱));
    if (項次 == null && 名稱 == null) break;             // 明細區到此為止
    if (項次 != null && /^完成百分率|^填表人/.test(項次)) break;
    dailyRows.push({
      項次,
      工程項目: 名稱,
      單位: unitOf(at(grid, r, c單位)),
      契約單價: c單價 < 0 ? null : num(at(grid, r, c單價)),
      契約數量: num(at(grid, r, c契約)),
      本日完成數量: num(at(grid, r, c本日)),
      // 「完成金額」是本日金額(見檔頭②)。大類列沒有數量也沒有單價,金額不收。
      本日完成金額: c金額 < 0 || 名稱 == null ? null : num(at(grid, r, c金額)),
      累計完成數量: num(at(grid, r, c累計)),
    });
  }
  // 大類列(單位/數量/單價皆空)不該帶著金額 0 —— 那會讓它不再被判成大類
  for (const row of dailyRows) {
    if (row.單位 == null && row.契約數量 == null && row.契約單價 == null) row.本日完成金額 = null;
  }

  const 實際 = pr < 0 ? null : num(valueRight(grid[pr], o, to, '實際進度(%)'));
  return {
    header: {
      工程名稱: inCell(nr, /工程名稱[:：]\s*(.+)$/),
      填報日期: rocTextToISO(日期句),
      星期: week || null,
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      // 預定是百分數、實際是分數(見檔頭①),統一成百分數
      預定進度: pr < 0 ? null : num(valueRight(grid[pr], o, to, '預定進度(%)')),
      實際進度: 實際 == null ? null : Math.round(實際 * 1e6) / 1e4,
      出工總人數,
      本日累計金額: null,                                // 此格式無日層級合計
      承包廠商: nr < 0 ? null : text(valueRight(grid[nr], o, to, '承攬廠商名稱')),
      開工日期: sr < 0 ? null : rocTextToISO(valueRight(grid[sr], o, to, '開工日期')),
    },
    dailyRows,
    extras,
  };
}

/** 第二聯表頭列:同時有「項次」與「契約單價」的那一列。天的起點 = 該列值為「項次」的每一欄。 */
function layoutOf(grid) {
  for (let r = 0; r < (grid || []).length; r++) {
    const row = grid[r] || [];
    const origins = [];
    let hasPrice = false;
    for (let c = 0; c < row.length; c++) {
      const s = despace(row[c]);
      if (s === '項次') origins.push(c);
      if (s === '契約單價') hasPrice = true;
    }
    if (origins.length && hasPrice) return { hr: r, origins, width: row.length };
  }
  return null;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const days = [];
  for (const name of Object.keys((wb && wb.sheets) || {})) {
    const grid = wb.sheets[name];
    const lay = layoutOf(grid);
    if (!lay) continue;
    for (let i = 0; i < lay.origins.length; i++) {
      const o = lay.origins[i];
      const to = i + 1 < lay.origins.length ? lay.origins[i + 1] : lay.width;
      days.push(parseDay(grid, o, to, lay.hr));
    }
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
  if (!days.length) throw new Error('找不到第二聯表頭(此檔非國謙格式,或是 PDF/掃描件)');
  // 「還沒填的天」濾掉:沒有日期**且**整天沒有任何本日完成量。
  const filled = days.filter((d) => d.header.填報日期 != null
    || (d.dailyRows || []).some((r) => r.本日完成數量));
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔版面不是國謙的)');
  }
  return filled.sort((x, y) => String(x.header.填報日期).localeCompare(String(y.header.填報日期)));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造兩天(取自 `施工日報表….xlsx` 第 1 天與第 16 天,
 * 只換工程名稱)。第 16 天是唯一驗得到「完成金額是本日不是累計」的形狀:
 * 本日 1、累計 2、單價 7150,金額 7150。
 */
function selfTest(ft) {
  const g = [];
  const put = (r, c, v) => { g[r] = g[r] || []; g[r][c] = v; };
  const span = (r, from, to, v) => { for (let c = from; c <= to; c++) put(r, c, v); };
  const W = 16;
  const day = (o, dateText, 預定, 實際, rows) => {
    span(0, o, o + 11, META_VENDOR_KEY);
    span(1, o, o + 11, '公共工程施工日誌');
    span(2, o, o + 9, '第一聯'); put(2, o + 10, '編號：'); put(2, o + 11, 1);
    put(3, o, '本日天氣 '); span(3, o + 1, o + 5, '上午：晴    　　下午：陰   ');
    span(3, o + 7, o + 11, `填報日期：${dateText}`);
    span(4, o, o + 5, '工程名稱：測試工程');
    span(4, o + 6, o + 8, '承攬廠商名稱'); span(4, o + 9, o + 11, META_VENDOR_KEY);
    put(5, o, '核定工期'); put(5, o + 1, 50); put(5, o + 2, '工作天');
    span(6, o, o + 2, '開工日期'); span(6, o + 3, o + 5, '115年3月11日');
    span(6, o + 6, o + 8, '預計完工日期'); span(6, o + 9, o + 11, '115年4月29日');
    span(7, o, o + 2, '預定進度(%)'); span(7, o + 3, o + 5, 預定);
    span(7, o + 6, o + 8, '實際進度(%)'); span(7, o + 9, o + 11, 實際);
    span(8, o, o + 11, '一、依施工計畫書執行按圖施工概況(含約定之重要施工項目及完成數量等)');
    put(25, o, '工別'); span(25, o + 1, o + 2, '本日人數'); span(25, o + 3, o + 5, '累計人數');
    span(25, o + 6, o + 8, '機具名稱'); put(25, o + 9, '本日使用數量'); span(25, o + 10, o + 11, '累計使用數量');
    span(26, o, o, '技工'); span(26, o + 1, o + 2, 2); span(26, o + 3, o + 5, 9);
    span(31, o, o + 11, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');
    // 第二聯
    span(59, o, o + 11, '第二聯 完成工程詳細表 ');
    put(62, o, '項次'); span(62, o + 1, o + 4, '工程項目  '); put(62, o + 5, '單位');
    span(62, o + 6, o + 7, '契約數量'); span(62, o + 8, o + 9, '本日完成數量');
    put(62, o + 10, '累計完成數量'); put(62, o + 11, '備註');
    put(62, o + 13, '契約單價'); put(62, o + 14, '完成金額');
    rows.forEach((rw, i) => {
      const r = 63 + i;
      put(r, o, rw[0]); span(r, o + 1, o + 4, rw[1]);
      if (rw[2] != null) put(r, o + 5, rw[2]);
      if (rw[3] != null) span(r, o + 6, o + 7, rw[3]);
      if (rw[4] != null) span(r, o + 8, o + 9, rw[4]);
      if (rw[5] != null) put(r, o + 10, rw[5]);
      if (rw[6] != null) put(r, o + 13, rw[6]);
      if (rw[7] != null) put(r, o + 14, rw[7]);
    });
  };

  // 第 1 天:預定 0.5(百分數)、實際 0.00123(分數)
  day(0, '115年3月11日(星期三)', 0.5, 0.00122671601484331, [
    ['壹', '直接工程'],
    ['1', '既有傾斜高網修復', 'M', 30, null, 0, 2050, 0],
  ]);
  // 第 16 天:本日 1、累計 2、單價 7150 → 完成金額 7150 = 本日 × 單價(不是累計)
  day(W, '115年3月26日(星期四)', 12.5, 0.2, [
    ['壹', '直接工程'],
    ['3', '既有3吋鋼管增加斜撐補強', '組', 22, 1, 2, 7150, 7150],
    ['4', '既有10吋鋼管增加斜撐補強', '組', 6, 0.2, 0.4, 71500, 14300],
  ]);

  const lay = layoutOf(g);
  if (!lay || lay.origins.length !== 2 || lay.hr !== 62) return false;
  const d1 = parseDay(g, lay.origins[0], lay.origins[1], lay.hr);
  const d2 = parseDay(g, lay.origins[1], lay.width, lay.hr);

  if (d1.header.工程名稱 !== '測試工程') return false;        // 標籤與值黏在同一格
  if (d1.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (d1.header.填報日期 !== '2026-03-11' || d1.header.星期 !== '星期三') return false;
  if (d1.header.開工日期 !== '2026-03-11') return false;
  if (d1.header.天氣_上午 !== '晴' || d1.header.天氣_下午 !== '陰') return false;
  // 預定是百分數照收,實際是分數要 ×100 才能與預定比
  if (d1.header.預定進度 !== 0.5 || d1.header.實際進度 !== 0.1227) return false;
  if (d1.header.出工總人數 !== 2) return false;               // 累計 9 不可混進來
  if (d1.dailyRows.length !== 2) return false;
  if (d1.dailyRows[0].項次 !== '壹' || d1.dailyRows[0].單位 !== null) return false;
  if (d1.dailyRows[0].本日完成金額 !== null) return false;     // 大類列不帶金額
  if (d1.dailyRows[1].契約單價 !== 2050 || d1.dailyRows[1].累計完成數量 !== 0) return false;

  if (d2.header.填報日期 !== '2026-03-26') return false;
  if (d2.header.實際進度 !== 20) return false;
  const r3 = d2.dailyRows[1];
  const r4 = d2.dailyRows[2];
  // 完成金額 = 本日 × 單價(若收成累計金額,r3 會是 14300)
  if (r3.本日完成數量 !== 1 || r3.累計完成數量 !== 2 || r3.本日完成金額 !== 7150) return false;
  if (r4.本日完成金額 !== 14300 || r4.本日完成數量 !== 0.2) return false;
  if (Math.abs(r4.本日完成金額 - r4.本日完成數量 * r4.契約單價) > 0.5) return false;
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
  _internal: { parseDay, layoutOf },
};
