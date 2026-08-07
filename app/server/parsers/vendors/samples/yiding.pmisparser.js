/**
 * yiding.pmisparser.js — 義鼎營造有限公司施工日誌讀取器(四湖國小活動中心)
 *
 * vendorKey 取自**決標公告的得標廠商**;日誌每一天的「承攬廠商名稱」欄也是同一個
 * 名稱,兩邊一致。
 *
 * ── 版面事實(實測 2 份 xlsx / 40 天)──
 * 工程會標準表單的單聯版,**一天一個分頁**(分頁名是日期:`113.12.01 (21)`、
 * `1131111 (1)`),每個分頁的錨點是欄 0 去空白後等於「表報編號：」。
 *   r2  欄1「上午：」欄2=值  欄3「下午：」欄4=值  欄9「填表日期：」欄10=Excel 序號
 *   r3  欄0「工程名稱：」欄1=值   欄7「承攬廠商名稱」欄10=值
 *   r5  欄0「開工日期」欄1=**Excel 序號**(不是字串)
 *   r6  預定進度 欄3 / 實際進度 欄10(**分數**,0.5672=56.72%,保留原值不換算)
 *   r9  明細表頭「契約項目 | 單位 | 數量 | 本日完成數量 | 累計完成數量」
 *   r10 起是明細(項次在欄 0、名稱在欄 1),到「二、」為止
 * 欄位落點一律**由標籤定位**,不寫死列號:兩份檔的分頁列數就不一樣(54 vs 57)。
 *
 * ── 三個坑 ──
 * ① **取標籤右邊的值時一定要在下一個標籤處停住**。「下午：」那格的值是空的
 *    (這家整整 40 天都沒填下午天氣),往右一路找非空值會撈到同一列的
 *    「填表日期：」這個**標籤字串**當成天氣。判準:遇到「以冒號結尾」的格就停,回 null。
 * ② **項次是「壹1」「壹2」這種大類+序號的複合編號**,不是純數字。照收不動它:
 *    這是文件上的識別,而且同一項目跨天跨檔都一致。(此案沒有可用的發包後經費總表
 *    ——資料夾裡那份是廠商自製的報價單、SP2 挑不出價目表——所以無從對齊契約編號,
 *    更不該自己改寫。)
 * ③ **開工日期是 Excel 序號**,不是「114年9月27日」那種字串。當字串 regex 會整欄 null。
 *
 * ── 已知的來源資料錯誤(不是讀取器讀錯,不要「修」它)──
 * 分頁 `1131112 (2)` 的填表日期填成 45609(=11/13),與下一頁 `1131113 (3)` 撞號
 * (序號序列 45607、45609、45609、45610 中間缺 45608)。**照收**,讓 SP3 的 D1
 * 「這一天出現兩次」把它報出來——分頁名不是文件內容,拿它去覆蓋填表日期就是猜。
 * 同樣地,**下午天氣整份空白**會讓 A2 每天硬錯:那是廠商沒填,不是抽不到。
 *
 * ── 此格式沒有的東西 ──
 * 沒有契約單價、沒有任何金額,一律 null 不回推。沒有星期。
 * 同案的兩份 PDF 與 xlsx 是同一批日子(xlsx 已涵蓋全部 40 天),不另做;
 * PDF 餵給 SheetJS 會回空活頁簿,那時要 throw 而不是回空陣列。
 */

const META_VENDOR_KEY = '義鼎營造有限公司';

const ANCHOR = '表報編號:';          // despace 會做 NFKC,全形冒號折成半形
const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'CM', 'MM', 'KG', 'kg', '噸', 'T',
  '公尺', '公斤', '平方公尺', '立方公尺', '場', '座', '組', '支', '個', '只', '片',
  '面', '處', '間', '棵', '株', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道',
  '才', '天', '日', '人']);
const SECTION = /^[一二三四五六七八九十]+、/;
const LABEL_END = /[:：]$/;          // 標籤格一律以冒號結尾(見檔頭①)

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

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 在某列找第一個去空白後等於 label 的欄。 */
function colOf(row, label) {
  for (let c = 0; c < (row || []).length; c++) if (despace(row[c]) === label) return c;
  return -1;
}

/**
 * 取 label 右邊第一個值。**遇到下一個標籤(以冒號結尾)就停住回 null**——
 * 這家「下午：」的值是空的,不停住會撈到同一列的「填表日期：」當天氣(見檔頭①)。
 */
function valueAfter(row, label) {
  const c = colOf(row, label);
  if (c < 0) return null;
  const lab = despace(row[c]);
  for (let i = c + 1; i < row.length; i++) {
    const s = despace(row[i]);
    if (s === lab) continue;                       // 合併填充後標籤自己佔好幾欄
    if (s === '') continue;
    if (LABEL_END.test(s)) return null;            // 下一個標籤 → 這格本來就沒填
    return row[i];
  }
  return null;
}

/**
 * 解析一天(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid 一個日分頁
 * @param {number} a 錨點列
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseDay(grid, a, serialToISO) {
  const end = grid.length;
  const rowWith = (re) => {
    for (let r = a; r < end; r++) if (re.test(despace(at(grid, r, 0)))) return r;
    return -1;
  };
  const iso = (v) => {
    const n = num(v);
    return n != null && serialToISO ? serialToISO(n) : null;
  };

  const wr = rowWith(/^本日天氣/);
  const nr = rowWith(/^工程名稱/);
  const sr = rowWith(/^開工日期$/);
  const pr = rowWith(/^預定進度/);

  const hr = rowWith(/^契約項目$/);
  const dailyRows = [];
  if (hr >= 0) {
    const hdr = grid[hr];
    const c單位 = colOf(hdr, '單位');
    const c數量 = colOf(hdr, '數量');
    const c本日 = colOf(hdr, '本日完成數量');
    const c累計 = colOf(hdr, '累計完成數量');
    if ([c單位, c數量, c本日, c累計].some((c) => c < 0)) {
      throw new Error('明細表頭欄位找不到(非義鼎格式?)');
    }
    for (let r = hr + 1; r < end; r++) {
      const 項次 = text(at(grid, r, 0));
      const 名稱 = text(at(grid, r, 1));
      if (項次 != null && SECTION.test(項次)) break;
      if (項次 == null && 名稱 == null) continue;
      dailyRows.push({
        項次,
        工程項目: 名稱,
        單位: unitOf(at(grid, r, c單位)),
        契約單價: null,                              // 此格式無單價
        契約數量: num(at(grid, r, c數量)),
        本日完成數量: num(at(grid, r, c本日)),
        本日完成金額: null,                          // 此格式無金額
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
      工程名稱: nr < 0 ? null : text(valueAfter(grid[nr], '工程名稱:')),
      填報日期: wr < 0 ? null : iso(valueAfter(grid[wr], '填表日期:')),
      星期: null,                                    // 此格式不提供
      天氣_上午: wr < 0 ? null : text(valueAfter(grid[wr], '上午:')),
      天氣_下午: wr < 0 ? null : text(valueAfter(grid[wr], '下午:')),
      預定進度: pr < 0 ? null : num(valueAfter(grid[pr], '預定進度(%)')),
      實際進度: pr < 0 ? null : num(valueAfter(grid[pr], '實際進度(%)')),
      出工總人數,
      本日累計金額: null,                            // 此格式無金額
      承包廠商: nr < 0 ? null : text(valueAfter(grid[nr], '承攬廠商名稱')),
      開工日期: sr < 0 ? null : iso(valueAfter(grid[sr], '開工日期')),
    },
    dailyRows,
    extras,
  };
}

/** 一天一分頁:回該分頁的錨點列,找不到就不是日分頁。 */
function anchorOf(grid) {
  for (let r = 0; r < (grid || []).length; r++) if (despace(at(grid, r, 0)) === ANCHOR) return r;
  return -1;
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') throw new Error('缺少注入的 filetypes.readWorkbook');
  const wb = ft.readWorkbook(filePath);
  const days = [];
  for (const name of Object.keys((wb && wb.sheets) || {})) {
    const grid = wb.sheets[name];
    const a = anchorOf(grid);
    if (a < 0) continue;
    days.push(parseDay(grid, a, ft.excelSerialToISO));
  }
  // 回空陣列會被上游當成「這份沒有資料」而靜靜略過(PDF 餵給 SheetJS 就是走到這裡)。
  if (!days.length) throw new Error('找不到「表報編號」日分頁(此檔非義鼎格式,或是 PDF/掃描件)');
  // 讀得出分頁卻一天都沒有日期 = 錨點碰巧命中別家的表單(工程會標準表單很多家在用)。
  if (!days.some((d) => d.header.填報日期 != null)) {
    throw new Error('每一天都讀不到填表日期(此檔錨點雖然對上,版面不是義鼎的)');
  }
  // **不依日期去重**:分頁 1131112 的填表日期是廠商填錯的(與 1131113 撞號),
  // 去重會讓那一天靜靜消失。照收,交給 SP3 的 D1 報出來。
  return days.sort((x, y) => String(x.header.填報日期).localeCompare(String(y.header.填報日期)));
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/** selfTest 用**真實儲存格**造一天(取自 `113.12.01 (21)` 分頁,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const set = (r, from, to, v) => { g[r] = g[r] || []; for (let c = from; c <= to; c++) g[r][c] = v; };
  set(0, 0, 12, '公共工程施工日誌');
  set(1, 0, 0, '表報編號：'); set(1, 1, 1, 21);
  // 「下午：」的值是空的(整份都沒填);往右找非空值會撈到「填表日期：」這個標籤
  set(2, 0, 0, '本日天氣：            '); set(2, 1, 1, '上午：               ');
  set(2, 2, 2, '晴'); set(2, 3, 3, '下午：     '); set(2, 4, 4, ' ');
  set(2, 9, 9, '填表日期：'); set(2, 10, 12, 45627);
  set(3, 0, 0, '工程名稱：  '); set(3, 1, 6, '測試工程');
  set(3, 7, 9, '承攬廠商名稱'); set(3, 10, 13, META_VENDOR_KEY);
  set(4, 0, 0, '核定工期'); set(4, 1, 1, 60); set(4, 2, 2, '天');
  set(5, 0, 0, '開工日期'); set(5, 1, 6, 45607); set(5, 7, 9, '完工日期'); set(5, 10, 13, 45666);
  set(6, 0, 2, '預定進度(%)'); set(6, 3, 6, 0.26189999999999997);
  set(6, 7, 9, '實際進度(%)'); set(6, 10, 13, 0.5672);
  set(7, 0, 13, '一、依施工計畫書執行按圖施工概況(含約定之重要施工項目及完成數量等)：');
  set(8, 0, 13, '面鋪3mmPU面層與PU耐候保護面漆止滑處理(2道)');
  set(9, 0, 2, '契約項目'); set(9, 3, 3, '單位'); set(9, 4, 5, '數量');
  set(9, 6, 7, '本日完成數量'); set(9, 8, 10, '累計完成數量');
  set(10, 0, 0, '壹'); set(10, 1, 2, '直接工程');
  set(11, 0, 0, '壹1'); set(11, 1, 2, '工程告示牌與職安告示牌(租用)'); set(11, 3, 3, '式');
  set(11, 4, 5, 1); set(11, 8, 10, 1);
  set(12, 0, 0, '壹7'); set(12, 1, 2, '面鋪3mmPU面層與PU耐候保護面漆止滑處理(2道)');
  set(12, 3, 3, 'M2'); set(12, 4, 5, 660); set(12, 6, 10, 100);
  set(13, 0, 13, '二、工地材料管理概況(含約定之重要材料使用狀況及數量等)：');
  set(14, 0, 2, '材料名稱'); set(14, 3, 3, '單位'); set(14, 4, 5, '設計數量');
  set(14, 6, 7, '本日完成數量'); set(14, 8, 10, '累計完成數量'); set(14, 11, 13, '備註');
  set(15, 0, 2, '刷油性強化底漆固化劑'); set(15, 3, 3, 'M2'); set(15, 4, 5, 812);
  set(15, 6, 7, 0); set(15, 8, 10, 812);
  set(16, 0, 13, '三、工地人員及機具管理（含約定之出工人數及機具使用情形及數量）：');
  set(17, 0, 1, '工別'); set(17, 2, 3, '本日人數'); set(17, 4, 6, '累計人數');
  set(17, 7, 8, '機具名稱'); set(17, 9, 10, '本日使用數量'); set(17, 11, 13, '累計使用數量');
  set(18, 0, 1, '普通工'); set(18, 2, 3, 2); set(18, 4, 6, 22);
  set(18, 7, 8, '切割機'); set(18, 11, 13, 1);
  set(19, 0, 1, '技術工'); set(19, 4, 6, 8); set(19, 7, 8, '刨除機'); set(19, 11, 13, 6);
  set(20, 0, 13, '四、本日施工項目是否有須依「營造業專業工程特定施工項目應置之技術士…');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseDay(g, 1, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2024-12-01') return false;
  if (serial && d.header.開工日期 !== '2024-11-11') return false;   // 開工日期是序號不是字串
  if (d.header.天氣_上午 !== '晴') return false;
  if (d.header.天氣_下午 !== null) return false;      // 空的就是空的,不可撈到「填表日期：」
  if (d.header.預定進度 !== 0.26189999999999997) return false;      // 分數保留原值
  if (d.header.實際進度 !== 0.5672) return false;
  if (d.header.出工總人數 !== 2) return false;         // 技術工只有累計,不計
  if (d.extras.出工明細.length !== 1) return false;
  if (d.extras.主要機具) return false;                 // 機具那兩台只填了累計欄,本日是空的
  if (!d.extras.主要材料 || d.extras.主要材料.length !== 1) return false;
  if (d.extras.主要材料[0].單位 !== 'M2') return false;
  if (d.dailyRows.length !== 3) return false;
  const [c0, r1, r7] = d.dailyRows;
  if (c0.項次 !== '壹' || c0.單位 !== null || c0.契約數量 !== null) return false;  // 大類
  if (r1.項次 !== '壹1' || r1.單位 !== '式' || r1.契約數量 !== 1) return false;
  if (r1.本日完成數量 !== null || r1.累計完成數量 !== 1) return false;
  if (r7.項次 !== '壹7' || r7.本日完成數量 !== 100 || r7.累計完成數量 !== 100) return false;
  if (r7.契約單價 !== null || r7.本日完成金額 !== null) return false;
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
  _internal: { parseDay, anchorOf, valueAfter },
};
