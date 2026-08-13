/**
 * kunyao.pmisparser.js — 坤曜土木工程有限公司施工日誌讀取器(台西國中西側廁所整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(`模板\決標公告\台西國中西側廁所整修工程_決標公告.pdf`,
 * 工程編號 C1150415);日誌每一天的「承攬廠商名稱」欄也寫同一個名稱,兩邊一致。
 * ⚠️ 是「土木工程有限公司」不是「營造」,寫錯的話讀取器讀得動也永遠不會被叫到。
 *
 * ── 版面事實(實測 2 份 XLSX / 124 天 / 4960 明細列)──
 * 工程會標準表單的窄版(只有 9 欄),一個月一個分頁 `日報表(7)`~`日報表(10)`,
 * 一天一個 63 列的區塊往下堆,錨點是欄 0 去空白後等於「表報編號：」。
 *   a+1  欄0=本日天氣：欄1=整句「上午：晴  下午:晴」  欄4=填報日期(Excel 序號,**無標籤**)
 *   a+2  欄0=工程名稱 → 欄1                欄2=承攬廠商名稱 → 欄4
 *   a+5  欄0=開工日期 → 欄1(Excel 序號)
 *   a+6  欄0=預定進度(%) → 欄1             欄2=實際進度(%) → 欄4(**分數**)
 *   a+8  明細表頭(項次/施工項目/單位/契約數量/本日完成數量/累計完成數量/備註/單價/本日完成金額)
 *   a+9 起是明細,到「二、工地材料管理概況」為止
 *
 * ⚠️ **第一個分頁「進度表」不是日誌**(是施工預定進度表)。它沒有「表報編號：」錨點,
 * 所以自然被略過——不要為了它放寬錨點判定。
 *
 * ── 「本日完成金額」真的是本日金額(與有謙相反,用算式核對過)──
 * 4216 列裡 **4216 列**符合「= 本日完成數量 × 單價」,只有 3536 列同時符合
 * 「= 累計 × 單價」。同族的有謙那家標籤寫「實做金額」、值卻是累計金額——
 * **標籤不是證據,每一家都要自己用算式核對**。
 *
 * ── 填報日期那格沒有標籤,而同一列右邊有頁碼 ──
 * 天氣列長這樣:欄0「本日天氣：」欄1~3 天氣整句、欄4~6 日期序號、欄9 頁碼(1 或 2)。
 * 取「label 右邊第一個數字」會撈到頁碼,轉出來是 1900-01-01(振典的讀取器對這份檔
 * 就是這樣壞的)。故只收 **≥30000 的數字**當日期序號:30000 是西元 1982 年,
 * 任何合理的施工日期都遠大於它,而頁碼是個位數。
 *
 * ── 「本日完成總金額」不是累計金額 ──
 * 明細區結尾那列印著「本日完成總金額」,值是當日本日金額的合計(第 1 天 13145.52)。
 * 收進 header.本日累計金額 會讓 SP3 的 B4 拿本日合計去比各項累計總和,天天不符。
 * 此格式沒有累計金額 → null。
 *
 * ── 此格式沒有的東西 ──
 * 沒有星期。「二、工地材料管理概況」那張表實測 124 天全空(程式照收,有才填)。
 */

const META_VENDOR_KEY = '坤曜土木工程有限公司';

// despace 會做 NFKC,全形冒號會折成半形——字面量要寫半形,否則永遠對不上
const ANCHOR = '表報編號:';
// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
const SECTION = /^[一二三四五六七八九十]+、/;
// Excel 日期序號的下限(30000 = 1982-03-01)。同一列的頁碼是個位數,靠這條擋掉。
const MIN_DATE_SERIAL = 30000;

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

/** 進度欄存的是分數(0.00535 = 0.535%),**保留原值不換算**(Excel 系讀取器的既有慣例)。 */
const pct = (v) => num(v);

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 在某列找第一個去空白後等於 label 的欄(合併填充後同值連續,取最左)。 */
function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

/** 取 label 右邊第一個「與 label 不同」的值(標籤自己會因合併填充佔好幾欄)。 */
function valueAfter(row, label) {
  const c = colOf(row, label);
  if (c < 0) return null;
  const lab = despace(row[c]);
  for (let i = c + 1; i < (row || []).length; i++) {
    if (despace(row[i]) === lab) continue;
    if (row[i] == null || String(row[i]).trim() === '') continue;
    return row[i];
  }
  return null;
}

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid 分頁
 * @param {number} a 錨點列(欄 0 = 表報編號：)
 * @param {number} end 下一個錨點列(或分頁末)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const iso = (v) => {
    const n = num(v);
    return n != null && n >= MIN_DATE_SERIAL && serialToISO ? serialToISO(n) : null;
  };

  const wr = rowWith(/^本日天氣/);
  const wt = wr < 0 ? '' : nfkc(at(grid, wr, colOf(grid[wr], '本日天氣:') + 1));
  const am = wt.match(/上午[:：]\s*(\S+?)(?=\s|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=\s|$)/);
  // 填報日期那格沒有標籤,同一列右邊還有頁碼 → 只收 >=30000 的數字(見檔頭)
  let 填報日期 = null;
  if (wr >= 0) {
    for (const v of grid[wr] || []) {
      const d = iso(v);
      if (d) { 填報日期 = d; break; }
    }
  }

  const nr = rowWith(/^工程名稱$/);
  const sr = rowWith(/^開工日期$/);
  const pr = rowWith(/^預定進度/);

  const dailyRows = [];
  const hr = rowWith(/^項次$/);
  if (hr >= 0) {
    const hdr = grid[hr];
    const c項次 = colOf(hdr, '項次');
    const c名稱 = colOf(hdr, '施工項目');
    const c單位 = colOf(hdr, '單位');
    const c契約 = colOf(hdr, '契約數量');
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    const c單價 = colOf(hdr, '單價');
    const c金額 = colOf(hdr, '本日完成金額');
    if ([c名稱, c單位, c契約, c本日, c累計, c單價, c金額].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非坤曜格式?)');
    }
    for (let r = hr + 1; r < end; r++) {
      const name = text(at(grid, r, c名稱));
      if (name != null && SECTION.test(name)) break;
      // 單位為空的是大類列(壹 直接工程費)與「營照專業工程特定施工項目 / A. / B.」標籤列
      const 單位 = unitOf(at(grid, r, c單位));
      if (name == null || 單位 == null) continue;
      dailyRows.push({
        項次: text(at(grid, r, c項次)),
        工程項目: name,
        單位,
        契約單價: num(at(grid, r, c單價)),
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: num(at(grid, r, c金額)),
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
      const n = num(at(grid, r, c人數));
      if (w != null && n != null && n > 0) 出工明細.push({ 工別: w, 人數: n });
      if (n != null) 出工總人數 = (出工總人數 || 0) + n;
      const gname = text(at(grid, r, c機具));
      const gn = num(at(grid, r, c機數));
      if (gname != null && gn != null && gn > 0) 主要機具.push({ 名稱: gname, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }
  const mr = rowWith(/^材料名稱$/);
  if (mr >= 0) {
    const hdr = grid[mr];
    const c單位 = colOf(hdr, '單位');
    const c本日 = colOf(hdr, '本日完成數量');
    const 主要材料 = [];
    for (let r = mr + 1; r < end; r++) {
      const n = text(at(grid, r, 0));
      if (n != null && SECTION.test(n)) break;
      if (n == null) continue;
      主要材料.push({ 名稱: n, 單位: unitOf(at(grid, r, c單位)), 數量: num(at(grid, r, c本日)) });
    }
    if (主要材料.length) extras.主要材料 = 主要材料;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱')),
      填報日期,
      星期: null,                                      // 此格式不提供
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      預定進度: pr < 0 ? null : pct(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : pct(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                               // 「本日完成總金額」是本日合計,見檔頭
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : iso(valueAfter(grid[sr], '開工日期')),
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

/**
 * 一天「填了多少」:有本日或累計完成數量的明細列數,列數是備援。
 *
 * 去重不可以只比明細列數:這家的 `日報表(8)(9)(10)` 是**還沒填的月份範本**,
 * 每一天照樣印著 7 月的日期與完整的 34 列(單位/契約數量/單價都在,是範本的固定內容),
 * 只有本日與累計是空的。比列數的話三個空白分頁與有資料的 `日報表(7)` 平手,
 * 保留誰全看分頁順序——順序一變,31 天的真實施工紀錄就靜靜消失。
 */
const filledness = (d) => [
  d.dailyRows.filter((r) => r.本日完成數量 != null || r.累計完成數量 != null).length,
  d.dailyRows.length,
];

/** 依填報日期去重(保留填得最多的那一份),並照時序輸出。 */
function dedupe(days) {
  const byDate = new Map();
  const noDate = [];
  for (const d of days) {
    const k = d.header.填報日期;
    if (!k) { noDate.push(d); continue; }
    const prev = byDate.get(k);
    if (!prev) { byDate.set(k, d); continue; }
    const [a1, a2] = filledness(prev);
    const [b1, b2] = filledness(d);
    if (b1 > a1 || (b1 === a1 && b2 > a2)) byDate.set(k, d);
  }
  const out = [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([, d]) => d);
  return out.concat(noDate);
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const days = [];
  for (const name of Object.keys((wb && wb.sheets) || {})) {
    const grid = wb.sheets[name];
    const starts = blockStarts(grid);
    for (let i = 0; i < starts.length; i++) {
      days.push(parseDay(grid, starts[i], i + 1 < starts.length ? starts[i + 1] : grid.length,
        ft.excelSerialToISO));
    }
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過
  if (!days.length) throw new Error('找不到「表報編號」區塊(此檔非坤曜日誌,或是無文字層的掃描件)');
  // 「還沒填的天」濾掉:沒有日期**且**沒有明細(只用前者會讓真的漏填的日子靜默消失)
  const filled = days.filter((d) => d.header.填報日期 != null || d.dailyRows.length > 0);
  // 「表報編號：」是至少 8 家共用的錨點,光靠它會假陽性:讀得出一堆天、卻一欄都沒值。
  if (!filled.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填報日期(此檔錨點雖然對上,版面不是坤曜的)');
  }
  return dedupe(filled);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造兩天(取自 `台西廁所施工日誌(1).XLSX` 的 `日報表(7)`
 * 第 1、2 天,只換工程名稱)。斷言各對著一個坑:日期不可撈到頁碼、
 * 本日完成金額是本日不是累計、大類與標籤列不可變成明細。
 */
function selfTest(ft) {
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  const block = (a, serial, 天氣, items, 本日總額) => {
    set(a, 0, 6, '表報編號：'); set(a, 9, 9, 1);
    set(a + 1, 0, 0, '本日天氣：'); set(a + 1, 1, 3, 天氣);
    if (serial != null) set(a + 1, 4, 6, serial);
    set(a + 1, 9, 9, 1);                                // 頁碼 —— 不可被當成日期序號
    set(a + 2, 0, 0, '工程名稱'); set(a + 2, 1, 1, '測試工程 ');
    set(a + 2, 2, 3, '承攬廠商名稱'); set(a + 2, 4, 6, META_VENDOR_KEY);
    set(a + 3, 0, 0, '核定工期'); set(a + 3, 1, 1, 120);
    set(a + 4, 0, 0, '累計工期'); set(a + 4, 1, 1, 1);
    set(a + 5, 0, 0, '開工日期'); set(a + 5, 1, 1, 46204);
    set(a + 5, 2, 3, '完工日期'); set(a + 5, 4, 6, 46323);
    set(a + 6, 0, 0, '預定進度(%)'); set(a + 6, 1, 1, 0.003980084486970685);
    set(a + 6, 2, 3, '實際進度(%)'); set(a + 6, 4, 6, 0.0053524124592833865);
    set(a + 6, 7, 7, '契約金額'); set(a + 6, 8, 8, 2456000);
    set(a + 7, 0, 8, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
    set(a + 8, 0, 0, '項 次'); set(a + 8, 1, 1, '施工項目'); set(a + 8, 2, 2, '單位');
    set(a + 8, 3, 3, '契約數量'); set(a + 8, 4, 4, '本日完成數量'); set(a + 8, 5, 5, '累計完成數量');
    set(a + 8, 6, 6, '備註'); set(a + 8, 7, 7, '單價'); set(a + 8, 8, 8, '本日完成金額');
    // 大類列:只有項次與名稱,沒有單位 —— 不可變成明細
    set(a + 9, 0, 0, '壹'); set(a + 9, 1, 1, '直接工程費');
    items.forEach((it, i) => {
      const r = a + 10 + i;
      set(r, 0, 0, it[0]); set(r, 1, 1, it[1]); set(r, 2, 2, it[2]); set(r, 3, 3, it[3]);
      if (it[4] != null) set(r, 4, 4, it[4]);
      if (it[5] != null) set(r, 5, 5, it[5]);
      set(r, 7, 7, it[6]); if (it[7] != null) set(r, 8, 8, it[7]);
    });
    // 明細區結尾的標籤列 + 本日合計(不是累計金額)
    set(a + 44, 0, 1, '營照專業工程特定施工項目');
    set(a + 44, 7, 7, '本日完成總金額'); set(a + 44, 8, 8, 本日總額);
    set(a + 45, 0, 0, 'A.'); set(a + 46, 0, 0, 'B.');
    set(a + 47, 0, 8, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
    set(a + 48, 0, 0, '材料名稱'); set(a + 48, 2, 2, '單位'); set(a + 48, 3, 3, '設計數量');
    set(a + 48, 4, 4, '本日完成數量'); set(a + 48, 5, 5, '累計完成數量');
    set(a + 51, 0, 8, '三、工地人員及機具管理(含約定之出工人數及機具使用情形及數量)：');
    set(a + 52, 0, 0, '工別'); set(a + 52, 1, 1, '本日人數'); set(a + 52, 2, 3, '累計人數');
    set(a + 52, 4, 4, '機具名稱'); set(a + 52, 5, 5, '本日使用數量'); set(a + 52, 6, 6, '累計使用數量');
    set(a + 53, 0, 0, '大工'); set(a + 53, 2, 3, 0);     // 本日人數留白,只有累計
    set(a + 54, 0, 0, '小工'); set(a + 54, 1, 1, 1); set(a + 54, 2, 3, 1);
    set(a + 55, 0, 8, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');
  };

  // 第 1 天:貳的本日 0.008333 × 21395 = 178.29(本日金額),累計是空的
  block(1, 46204, '上午：晴  下午:晴', [
    ['1', '工程告示牌與職安衛告示牌(租用)、施工圍籬、警示帶、安全警示燈等安全措施(租用)', '式', 1, null, null, 10508, null],
    ['2', '施工動線開闢與損壞復原，既有設備管線遷移與復原', '式', 1, null, 0, 13223, 0],
    ['貳', '職業安全衛生管理費(壹*1%)', '式', 1, 0.008333333333333333, null, 21395, 178.29166666666666],
  ], 13145.524999999998);
  // 第 2 天:日期整格留白 —— 不可退而撈同一列的頁碼 1(轉出來是 1900-01-01)
  block(64, null, '上午：陰  下午:雨', [
    ['1', '工程告示牌與職安衛告示牌(租用)、施工圍籬、警示帶、安全警示燈等安全措施(租用)', '式', 1, 1, 1, 10508, 10508],
  ], 10508);

  // 同一天的空白月份範本(日期相同、明細列數也相同,只是本日與累計都空著),
  // 排在**有資料的那份後面** —— 不可以蓋掉它
  block(127, 46204, '上午：晴  下午:晴', [
    ['1', '工程告示牌與職安衛告示牌(租用)、施工圍籬、警示帶、安全警示燈等安全措施(租用)', '式', 1, null, null, 10508, null],
    ['2', '施工動線開闢與損壞復原，既有設備管線遷移與復原', '式', 1, null, null, 13223, null],
    ['貳', '職業安全衛生管理費(壹*1%)', '式', 1, null, null, 21395, null],
  ], null);

  const starts = blockStarts(g);
  if (starts.length !== 3) return false;
  const parsed = starts.map((s, i) => parseDay(g, s,
    i + 1 < starts.length ? starts[i + 1] : g.length, ft && ft.excelSerialToISO));
  const deduped = dedupe(parsed);
  // 7/01 那天要留下有資料的那份(本日金額 178.29),不是後面那份空白範本
  if (deduped.length !== 2) return false;
  const 七月一 = deduped.find((d) => d.header.填報日期 === '2026-07-01');
  if (!七月一 || 七月一.dailyRows[2].本日完成金額 !== 178.29166666666666) return false;
  const [d1, d2] = parsed;
  if (d1.header.工程名稱 !== '測試工程') return false;
  if (d1.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (ft && ft.excelSerialToISO) {
    if (d1.header.填報日期 !== '2026-07-01') return false;
    if (d1.header.開工日期 !== '2026-07-01') return false;
  }
  if (d2.header.填報日期 !== null) return false;             // 頁碼 1 不可被當成日期
  if (d1.header.天氣_上午 !== '晴' || d1.header.天氣_下午 !== '晴') return false;
  if (d2.header.天氣_上午 !== '陰' || d2.header.天氣_下午 !== '雨') return false;
  if (d1.header.預定進度 !== 0.003980084486970685) return false;
  if (d1.header.實際進度 !== 0.0053524124592833865) return false;
  if (d1.header.本日累計金額 !== null) return false;         // 「本日完成總金額」不是累計金額
  if (d1.header.出工總人數 !== 1) return false;              // 大工只有累計 0,不可算進來
  if (d1.extras.主要材料) return false;                      // 材料表全空
  // 大類「壹 直接工程費」與 A./B. 標籤列不可變成明細
  if (d1.dailyRows.length !== 3) return false;
  const [r1, r2, r3] = d1.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約數量 !== 1 || r1.契約單價 !== 10508) return false;
  if (r1.本日完成數量 !== null || r1.累計完成數量 !== null || r1.本日完成金額 !== null) return false;
  if (r2.累計完成數量 !== 0 || r2.本日完成金額 !== 0) return false;
  // 費用項目的項次是中文大寫,照收(SP3 靠它把 B2/F1/C1 降成軟警告)
  if (r3.項次 !== '貳' || r3.本日完成金額 !== 178.29166666666666) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, blockStarts, dedupe },
};
