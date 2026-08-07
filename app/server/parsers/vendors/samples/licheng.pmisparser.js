/**
 * licheng.pmisparser.js — 利成營造有限公司施工日誌讀取器(光明國中廁所整修)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄也寫同一個
 * 名稱,兩邊一致。
 *
 * ── 版面事實(實測 5 份 xlsx / 153 天)──
 * 工程會標準表單的單聯版:一個月一個分頁(`9月|10月|11月|12月|1月|12月 (3)`),
 * 一天一個 **44 列的區塊**,錨點是欄 0 去空白後等於「表報編號：」。
 *   a+1  欄0=天氣(整句「本日天氣：上午：晴 下午：晴」) 欄10=填表日期(Excel 序號)
 *   a+2  欄3=工程名稱  欄10=承攬廠商名稱
 *   a+4  欄3=開工日期(民國點號字串 114.9.27)
 *   a+5  欄3=預定進度  欄10=實際進度(**分數**,0.393=39.3%,保留原值不換算)
 *   a+7  明細表頭      a+8 起是明細,到「二、工地材料管理概況」為止
 * 欄位落點一律**由表頭標籤定位**,不寫死:同一份檔裡的表頭是穩定的,但抄別家
 * 範本改的檔常常整欄平移。
 *
 * ── 三個會讀錯的坑 ──
 * ① **明細區的結尾不是空白列**。表頭下方固定留 2~3 列空白,再來是
 *    「營造業專業工程特定施工項目 / A. / B.」三列標籤,然後才是「二、」。
 *    有些天廠商把標籤列**覆蓋成明細**(12 月那些天),所以既不能用空白列當界、
 *    也不能用固定列數。界一律用「二、」段落標題,中間的空白列與 A./B. 標籤跳過。
 * ② **空白的複本分頁會蓋掉真資料**。`12月 (3)` 是 11/01~12/01 的**空範本**
 *    (整月每天都有日期與天氣、但一列明細都沒有),而 `11月` 有資料。照分頁順序
 *    後蓋前的話,21 天的施工紀錄會靜靜消失。故依填報日期去重時**保留有明細的那一份**。
 * ③ **此格式沒有項次欄**,而且逐日只列「當天施作的項目」(153 天裡只有 113 個
 *    明細列、30 個相異名稱)。用出現序當項次會在跨檔合併時漂掉——同一個項目在
 *    不同檔會拿到不同編號,而 SP3 的 prevCum/dailySum 以項次為鍵,會把兩個不同
 *    項目的累計混在一起(比報錯更糟,因為看起來完全正常)。故**項次直接用項目名稱**:
 *    那是這份文件唯一穩定的識別。代價是它永遠對不上契約表的「13」,靠 SP3 的
 *    名稱後備索引對應(E1 降為軟警告);對不上名稱的就是真的對不上,該讓它現形。
 *
 * ── 此格式沒有的東西 ──
 * 沒有契約單價、沒有任何金額(本日/累計),一律 null 不回推。
 * 「二、工地材料管理概況」那張表實測 153 天全空(程式照收,有才填)。
 *
 * ⚠️ 同案的 `施工進度(光明-日誌用).xls` **不是日誌**,是預算書
 * (封面/總表/詳細價目表/單價分析表/數量計算表)。檔名含「日誌」會被檔名規則收進來,
 * 讀到它會 throw(找不到「表報編號」區塊)——那是對的,別為了它放寬判定。
 */

const META_VENDOR_KEY = '利成營造有限公司';

// despace 會做 NFKC,全形冒號會折成半形——字面量要寫半形,否則永遠對不上
const ANCHOR = '表報編號:';
// 單位一律白名單(禁樣式判定:名稱裡的 RC/PVC 會被當成單位)
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
// 明細區裡不是明細的列:段落標題與「營造業專業工程特定施工項目」那三列
const SKIP_ROW = /^(營造業專業工程特定施工項目|[A-Z]\.)$/;
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

/**
 * 進度欄存的是分數(0.393 = 39.3%),表頭寫的是 (%)。**保留原值不換算**:
 * 這是 Excel 系讀取器的既有慣例(skill 的 Excel 坑②;摯東/晉林/齊全/承昇都這樣),
 * 而且 SP3 的 H1 正是照「值 <= 1 就當分數」在判——換算成百分數反而會讓開工頭幾天
 * (進度不到 1%)每天噴一個假的「實際落後預定超過 10%」。
 */
const pct = (v) => num(v);

/** 民國點號日期「114.9.27」→ 西元 ISO。 */
function rocDot(v) {
  const m = nfkc(v).trim().match(/^(\d{2,3})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
}

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
  for (let i = c + 1; i < row.length; i++) {
    if (despace(row[i]) === lab) continue;
    if (row[i] == null || String(row[i]).trim() === '') continue;
    return row[i];
  }
  return null;
}

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid 月分頁
 * @param {number} a 錨點列(欄 0 = 表報編號：)
 * @param {number} end 下一個錨點列(或分頁末)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, end, serialToISO) {
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };

  const wr = rowWith(/^本日天氣/);
  const wt = wr < 0 ? '' : nfkc(at(grid, wr, 0));
  const am = wt.match(/上午[:：]\s*(\S+?)(?=\s|下午|$)/);
  const pm = wt.match(/下午[:：]\s*(\S+?)(?=\s|$)/);
  const serial = wr < 0 ? null : num(valueAfter(grid[wr], '填表日期:'));
  const 填報日期 = serial != null && serialToISO ? serialToISO(serial) : null;

  const nr = rowWith(/^工程名稱$/);
  const pr = rowWith(/^預定進度/);
  const sr = rowWith(/^開工日期$/);

  // 明細:表頭列的標籤定欄,界用「二、」段落標題(見檔頭①)
  const hr = rowWith(/^施工項目$/);
  const dailyRows = [];
  if (hr >= 0) {
    const hdr = grid[hr];
    const c單位 = colOf(hdr, '單位');
    const c契約 = colOf(hdr, '契約數量');
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    if ([c單位, c契約, c本日, c累計].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非利成格式?)');
    }
    for (let r = hr + 1; r < end; r++) {
      const name = text(at(grid, r, 0));
      if (name != null && SECTION.test(name)) break;
      if (name == null || SKIP_ROW.test(name)) continue;
      dailyRows.push({
        項次: name,                                     // 此格式無項次欄,見檔頭③
        工程項目: name,
        單位: unitOf(at(grid, r, c單位)),
        契約單價: null,                                  // 此格式無單價
        契約數量: num(at(grid, r, c契約)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                              // 此格式無金額
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
      const g = text(at(grid, r, c機具));
      const gn = num(at(grid, r, c機數));
      if (g != null && gn != null && gn > 0) 主要機具.push({ 名稱: g, 數量: gn });
    }
    if (出工明細.length) extras.出工明細 = 出工明細;
    if (主要機具.length) extras.主要機具 = 主要機具;
  }
  const mr = rowWith(/^材料名稱$/);
  if (mr >= 0) {
    const hdr = grid[mr];
    const c單位 = colOf(hdr, '單位');
    const c本日 = colOf(hdr, '本日使用數量');
    const 主要材料 = [];
    for (let r = mr + 1; r < end; r++) {
      const n = text(at(grid, r, 0));
      if (n != null && SECTION.test(n)) break;
      if (n == null || SKIP_ROW.test(n)) continue;
      主要材料.push({ 名稱: n, 單位: unitOf(at(grid, r, c單位)), 數量: num(at(grid, r, c本日)) });
    }
    if (主要材料.length) extras.主要材料 = 主要材料;
  }

  return {
    header: {
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱')),
      填報日期,
      星期: null,                                        // 此格式不提供
      天氣_上午: am ? text(am[1]) : null,
      天氣_下午: pm ? text(pm[1]) : null,
      預定進度: pr < 0 ? null : pct(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : pct(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                                // 此格式無金額
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : rocDot(valueAfter(grid[sr], '開工日期')),
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
 * 依填報日期去重:**保留有明細的那一份**(空白複本分頁不可蓋掉真資料,見檔頭②),
 * 並照時序輸出。
 */
function dedupe(days) {
  const byDate = new Map();
  const noDate = [];
  for (const d of days) {
    const k = d.header.填報日期;
    if (!k) { noDate.push(d); continue; }
    const prev = byDate.get(k);
    if (!prev || (prev.dailyRows.length === 0 && d.dailyRows.length > 0)) byDate.set(k, d);
  }
  const out = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, d]) => d);
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
      days.push(parseDay(grid, starts[i], i + 1 < starts.length ? starts[i + 1] : grid.length, ft.excelSerialToISO));
    }
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過(同案的預算書就會走到這裡)。
  if (!days.length) throw new Error('找不到「表報編號」區塊(此檔非利成日誌,或是無文字層的掃描件)');
  // 「還沒填的天」濾掉:沒有日期**且**沒有明細(只用前者會讓真的漏填的日子靜默消失)。
  const filled = days.filter((d) => d.header.填報日期 != null || d.dailyRows.length > 0);
  // 全部沒有日期 = 這份根本不是利成的版面。齊全那家的活頁簿同樣有「表報編號：」
  // 錨點(都是工程會標準表單改的),光靠錨點會**假陽性**:讀得出一堆天、卻一欄都沒值。
  if (!filled.length) throw new Error('每一天都讀不到填表日期(此檔錨點雖然對上,版面不是利成的)');
  return dedupe(filled);
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實儲存格**造兩天(取自 `施工日誌-光明國中1150122.xlsx` 的
 * 12月/11月/12月 (3),只換工程名稱)。三條斷言各對著一個坑:
 * 明細界不是空白列、空白複本不可蓋掉真資料、項次用名稱。
 */
function selfTest(ft) {
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  const block = (a, serial, items) => {
    set(a - 1, 0, 12, '公共工程施工日誌');
    set(a, 0, 0, '表報編號：'); set(a, 1, 1, 66);
    set(a + 1, 0, 0, '本日天氣：上午：晴      下午：陰  ');
    set(a + 1, 7, 9, '填表日期：'); set(a + 1, 10, 12, serial);
    set(a + 2, 0, 2, '工程名稱'); set(a + 2, 3, 6, '測試工程');
    set(a + 2, 7, 9, '承攬廠商名稱'); set(a + 2, 10, 12, META_VENDOR_KEY);
    set(a + 3, 0, 0, '核定工期'); set(a + 3, 1, 1, 143);
    set(a + 4, 0, 2, '開工日期'); set(a + 4, 3, 6, '114.9.27');
    set(a + 4, 7, 9, '完工日期'); set(a + 4, 10, 12, '115.2.16');
    set(a + 5, 0, 2, '預定進度(%)'); set(a + 5, 3, 6, 0.3);
    set(a + 5, 7, 9, '實際進度(%)'); set(a + 5, 10, 12, 0.3930000000000002);
    set(a + 6, 0, 12, '一、依施工計畫書執行按圖施工概況（含約定之重要施工項目及完成數量等）：');
    set(a + 7, 0, 3, '施工項目'); set(a + 7, 4, 4, '單位'); set(a + 7, 5, 6, '契約數量');
    set(a + 7, 7, 8, '本日完成數量'); set(a + 7, 9, 10, '累計完成數量'); set(a + 7, 11, 12, '備註');
    items.forEach((it, i) => {
      const r = a + 8 + i;
      set(r, 0, 3, it[0]); set(r, 4, 4, it[1]); set(r, 5, 6, it[2]);
      set(r, 7, 8, it[3]); set(r, 9, 10, it[4]);
    });
    // 明細區之後固定有這三列標籤(廠商有時會覆蓋掉),再來才是「二、」
    if (items.length < 3) {
      set(a + 10, 0, 3, '營造業專業工程特定施工項目');
      set(a + 11, 0, 3, 'A.'); set(a + 12, 0, 3, 'B.');
    }
    set(a + 13, 0, 12, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
    set(a + 14, 0, 3, '材料名稱'); set(a + 14, 4, 4, '單位'); set(a + 14, 5, 6, '契約數量');
    set(a + 14, 7, 8, '本日使用數量'); set(a + 14, 9, 10, '累計使用數量'); set(a + 14, 11, 12, '備註');
    set(a + 17, 0, 12, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
    set(a + 18, 0, 1, '工別'); set(a + 18, 2, 3, '本日人數'); set(a + 18, 4, 6, '累計人數');
    set(a + 18, 7, 8, '機具名稱'); set(a + 18, 9, 10, '本日使用數量'); set(a + 18, 11, 12, '累計使用數量');
    set(a + 19, 0, 1, '泥水工'); set(a + 19, 2, 3, 4); set(a + 19, 4, 6, 42);
    set(a + 21, 0, 12, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');
  };

  // 12/01(有明細,且第三列蓋掉了「營造業專業工程特定施工項目」那列)
  block(1, 45992, [
    ['牆面貼石英磚30*60cm，白色水泥抹縫', 'M2', 190, 40, 60],
    ['地坪、牆面1:3水泥砂漿粉刷', 'M2', 313, 133, 313],
    ['地坪及牆面(H=1.2m)防水層粉刷', 'M2', 160, 60, 160],
  ]);
  // 同一天的空白複本(12月 (3) 分頁那種),排在後面 —— 不可蓋掉上面那份
  block(45, 45992, []);

  // parseAll 要有檔案,故 selfTest 直接走內部函式(同一條路徑)
  const starts = blockStarts(g);
  if (starts.length !== 2) return false;
  const parsed = starts.map((s, i) => parseDay(g, s, i + 1 < starts.length ? starts[i + 1] : g.length,
    ft && ft.excelSerialToISO));
  const out = dedupe(parsed);
  if (out.length !== 1) return false;                    // 同一天去重成一筆
  const d = out[0];
  if (d.dailyRows.length !== 3) return false;            // 保留有明細的那一份,不是空白複本
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (ft && ft.excelSerialToISO && d.header.填報日期 !== '2025-12-01') return false;
  if (d.header.開工日期 !== '2025-09-27') return false;
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  // 進度保留來源的分數(0.3 = 30%),不換算 —— 見 pct() 的說明
  if (d.header.預定進度 !== 0.3 || d.header.實際進度 !== 0.3930000000000002) return false;
  if (d.header.出工總人數 !== 4) return false;           // 累計 42 不可混進來
  if (d.extras.出工明細.length !== 1) return false;
  if (d.extras.主要材料) return false;                    // 材料表全空
  const [r1, , r3] = d.dailyRows;
  // 項次=名稱;全形逗號經 NFKC 折成半形(與契約表比對時同一層正規化)
  if (r1.項次 !== '牆面貼石英磚30*60cm,白色水泥抹縫') return false;
  if (r1.單位 !== 'M2' || r1.契約數量 !== 190 || r1.本日完成數量 !== 40 || r1.累計完成數量 !== 60) return false;
  if (r1.契約單價 !== null || r1.本日完成金額 !== null) return false;
  // 第三列坐在「營造業專業工程特定施工項目」原本的位置上,不可被當成標籤丟掉
  if (r3.工程項目 !== '地坪及牆面(H=1.2m)防水層粉刷' || r3.累計完成數量 !== 160) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約數量', '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { parseDay, blockStarts, dedupe },
};
