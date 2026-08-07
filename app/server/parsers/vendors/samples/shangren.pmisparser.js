/**
 * shangren.pmisparser.js — 尚仁營造施工日誌讀取器(台西國中活動中心牆體整修)
 *
 * vendorKey 取自**決標公告的得標廠商**(台西活動中心案:尚仁營造有限公司),
 * `施工日誌` 分頁 r2 欄 7 的「承攬廠商」也載明同一個名稱,兩邊一致。
 *
 * ── 版面事實(實測)──
 * .xlsm。`施工日誌`／`施工-第二聯` 只是**單日列印範本**(用公式抓當天的值),
 * 逐日資料在兩張並排的矩陣分頁,一天一欄:
 *
 *   `key in`  r0 欄9..=日期序號  r2/r3=上午/下午天氣  r4 起每列一個項目
 *             (欄1=項次 欄2=名稱 欄3=單位 欄4=契約數量 欄5=單價),欄9.. = **本日**完成數量
 *   `累計`    欄位定義與 `key in` 完全相同,但欄9.. 是 **累計**完成數量;
 *             另有 r2=累計金額(未稅)、r3=累計進度、r4=預定進度
 *
 * 兩張分頁的日期欄與項目列一一對應。**對應前必須逐欄比對日期、逐列比對名稱**:
 * 兩張表長得一模一樣,錯開一欄或一列不會讓任何值變 null,完整性關卡看不見
 * (晉林/聖隆踩過同型的坑)。
 *
 * ── 兩個範本殘留 ──
 * ① `施工-第二聯` r1 的工程名稱寫著「114年度桃園市政府工務局轄管道路公共…」——
 *    那是拿別的案子的檔改的殘留,不是這個工程。工程名稱一律取 `施工日誌` r2 欄2。
 * ② 明細列後面接著幾百列空白預留列(列序 42~501),要以「名稱為空」停止。
 *
 * ── 出工與機具在同一張矩陣的固定列序段 ──
 * 列序 502~511 是工別、512~521 是機具,欄9.. 同樣是逐日值。
 */

const META_VENDOR_KEY = '尚仁營造有限公司';

const SHEET = { 本日: 'key in', 累計: '累計', 單日: '施工日誌' };

// 矩陣分頁的固定列/欄
const ROW = { 日期: 0, 上午: 2, 下午: 3, 表頭: 4, 首項: 5 };
const COL = { 列序: 0, 項次: 1, 名稱: 2, 單位: 3, 契約數量: 4, 單價: 5, 首日: 9 };
// `累計` 分頁專有的逐日列
const CUM_ROW = { 累計金額: 2, 累計進度: 3, 預定進度: 4 };
// 出工/機具的列序段(見檔頭)
const CREW_SEQ = [502, 511];
const TOOL_SEQ = [512, 521];

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', 'CM', 'MM', 'KG', 'kg',
  '噸', 'T', '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間',
  '天', '日', '趟', '才', '公尺', '公斤', '台', '套', '包', '車', '批', '樘', '扇', '孔', '道']);

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

function unitOf(v) {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;                 // 白名單,不逐字收
}

/**
 * 兩張矩陣分頁的對應關係。回 { dateCols:[{c, serial}], items:[{r, 項次, 名稱, 單位, 契約數量, 單價}] }。
 * 對不齊就 throw——兩張表長得一模一樣,錯開一欄/一列不會讓任何值變 null。
 */
function alignSheets(daily, cum) {
  const width = Math.max(
    (daily[ROW.日期] || []).length,
    (cum[ROW.日期] || []).length
  );
  const dateCols = [];
  for (let c = COL.首日; c < width; c++) {
    const a = numOf(at(daily, ROW.日期, c));
    const b = numOf(at(cum, ROW.日期, c));
    // 兩張表的日期欄長度不一定相同(`key in` 實測比 `累計` 多 28 欄的預留),
    // 任一沒有就停;但**有值的部分必須逐欄相等**——錯開一欄不會讓任何值變 null。
    if (a == null || b == null) break;
    if (b !== a) throw new Error(`「key in」與「累計」的日期欄對不齊(欄 ${c}:${a} vs ${b})`);
    dateCols.push({ c, serial: a });
  }
  if (!dateCols.length) throw new Error('矩陣分頁裡找不到任何日期欄');

  const items = [];
  for (let r = ROW.首項; r < daily.length; r++) {
    const 名稱 = text(at(daily, r, COL.名稱));
    if (名稱 == null) break;                             // 明細後面是幾百列空白預留列
    const 對照 = text(at(cum, r, COL.名稱));
    if (對照 !== 名稱) throw new Error(`「key in」與「累計」的項目列對不齊(列 ${r}:${名稱} vs ${對照})`);
    items.push({
      r,
      項次: text(at(daily, r, COL.項次)),
      名稱,
      單位: unitOf(at(daily, r, COL.單位)),
      契約數量: numOf(at(daily, r, COL.契約數量)),
      單價: numOf(at(daily, r, COL.單價)),
    });
  }
  if (!items.length) throw new Error('矩陣分頁裡找不到任何項目列');
  return { dateCols, items };
}

/** 依列序段抓出工/機具的定義列。 */
function seqRows(daily, [lo, hi]) {
  const out = [];
  for (let r = 0; r < daily.length; r++) {
    const seq = numOf(at(daily, r, COL.列序));
    if (seq == null || seq < lo || seq > hi) continue;
    const name = text(at(daily, r, COL.名稱));
    if (name != null) out.push({ r, name });
  }
  return out;
}

/**
 * 組一天(純函式;selfTest 重用之)。
 * @param {object} src { daily, cum, spec, crew, tools, 工程名稱, 承包廠商, 開工日期 }
 * @param {{c:number, serial:number}} day
 */
function buildDay(src, day, serialToISO) {
  const { daily, cum, spec, crew, tools } = src;
  const c = day.c;

  const dailyRows = spec.items.map((it) => ({
    項次: it.項次,
    工程項目: it.名稱,
    單位: it.單位,
    契約單價: it.單價,
    契約數量: it.契約數量,
    本日完成數量: numOf(at(daily, it.r, c)),
    // 逐項的本日金額此格式不存在(只有 `累計` r2 的全案累計金額);
    // 用單價 × 數量回推是推導不是來源值。
    本日完成金額: null,
    累計完成數量: numOf(at(cum, it.r, c)),
  }));

  const extras = {};
  let 出工總人數 = null;
  const 出工明細 = crew.map((x) => ({ 工別: x.name, 人數: numOf(at(daily, x.r, c)) }));
  const 主要機具 = tools.map((x) => ({ 名稱: x.name, 數量: numOf(at(daily, x.r, c)) }));
  if (出工明細.length) {
    extras.出工明細 = 出工明細;
    const n = 出工明細.filter((x) => x.人數 != null);
    if (n.length) 出工總人數 = n.reduce((s, x) => s + x.人數, 0);
  }
  if (主要機具.length) extras.主要機具 = 主要機具;

  return {
    header: {
      工程名稱: src.工程名稱,
      填報日期: serialToISO ? serialToISO(day.serial) : null,
      星期: null,                                        // 此格式不提供
      天氣_上午: text(at(daily, ROW.上午, c)),
      天氣_下午: text(at(daily, ROW.下午, c)),
      預定進度: numOf(at(cum, CUM_ROW.預定進度, c)),
      實際進度: numOf(at(cum, CUM_ROW.累計進度, c)),
      出工總人數,
      // `累計` r2 是「累計金額(未稅)」——這是真的當日累計金額,不是推導值。
      本日累計金額: numOf(at(cum, CUM_ROW.累計金額, c)),
      承包廠商: src.承包廠商,
      開工日期: serialToISO && src.開工序號 != null ? serialToISO(src.開工序號) : null,
    },
    dailyRows,
    extras,
  };
}

/**
 * 「還沒填的天」判定:整個工期的欄一次建好,交檔當下工期還沒結束。
 * **只憑「沒天氣」丟掉是危險的**,故要求整天也沒有任何本日完成量(空白**或 0**)。
 */
function isUnfilled(day) {
  if (day.header.天氣_上午 != null || day.header.天氣_下午 != null) return false;
  const blank = (v) => v == null || v === 0;
  return (day.dailyRows || []).every((r) => blank(r.本日完成數量));
}

async function parseAll(filePath, ctx) {
  const ft = ctx && ctx.filetypes;
  if (!ft || typeof ft.readWorkbook !== 'function') {
    throw new Error('缺少注入的 filetypes.readWorkbook');
  }
  const wb = ft.readWorkbook(filePath);
  const daily = wb.sheets[SHEET.本日];
  const cum = wb.sheets[SHEET.累計];
  const one = wb.sheets[SHEET.單日];
  if (!daily || !cum || !one) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過。
    throw new Error(`缺少「${SHEET.本日}/${SHEET.累計}/${SHEET.單日}」分頁(此檔非尚仁格式,或是無文字層的掃描件)`);
  }

  const spec = alignSheets(daily, cum);
  const src = {
    daily, cum, spec,
    crew: seqRows(daily, CREW_SEQ),
    tools: seqRows(daily, TOOL_SEQ),
    // 工程名稱只能取 `施工日誌`:`施工-第二聯` 的抬頭是別的案子的範本殘留。
    工程名稱: text(at(one, 2, 2)),
    承包廠商: text(at(one, 2, 7)),
    開工序號: numOf(at(daily, ROW.日期, 2)),
  };

  const out = [];
  for (const day of spec.dateCols) {
    const d = buildDay(src, day, ft.excelSerialToISO);
    if (isUnfilled(d)) continue;
    out.push(d);
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/**
 * selfTest 用**真實座標**造兩張最小矩陣(取自台西前兩天,只換工程名稱)。
 * 要驗的是「兩張分頁必須逐欄比對日期、逐列比對名稱」——它們長得一模一樣,
 * 錯開一格不會讓任何值變 null。
 */
function selfTest(ft) {
  const mk = () => [];
  const set = (g, r, c, v) => { (g[r] = g[r] || [])[c] = v; };

  const daily = mk();
  set(daily, 0, 0, '開工日期'); set(daily, 0, 2, 46036);
  set(daily, 0, 8, '日期'); set(daily, 0, 9, 46036); set(daily, 0, 10, 46037);
  set(daily, 2, 8, '上午天氣'); set(daily, 2, 9, '晴'); set(daily, 2, 10, '雨');
  set(daily, 3, 8, '下午天氣'); set(daily, 3, 9, '晴'); set(daily, 3, 10, '雨');
  set(daily, 4, 0, '列序'); set(daily, 4, 1, '項 次'); set(daily, 4, 2, '項  目  及  說  明');
  set(daily, 4, 3, '單 位'); set(daily, 4, 4, '數 量'); set(daily, 4, 5, '單 價');
  set(daily, 5, 0, 6); set(daily, 5, 1, '壹'); set(daily, 5, 2, '直接工程');
  set(daily, 6, 0, 7); set(daily, 6, 1, 1); set(daily, 6, 2, '工程告示牌與職安告示牌(租用）');
  set(daily, 6, 3, '式'); set(daily, 6, 4, 1); set(daily, 6, 5, 1836); set(daily, 6, 9, 1);
  set(daily, 7, 0, 8); set(daily, 7, 1, 2); set(daily, 7, 2, '甲種施工安全圍籬含大門(租用）');
  set(daily, 7, 3, 'M'); set(daily, 7, 4, 210); set(daily, 7, 5, 643);
  set(daily, 7, 9, 100); set(daily, 7, 10, 110);
  set(daily, 8, 0, 9);                                    // 名稱空 → 明細結束
  set(daily, 501, 0, 502); set(daily, 501, 2, '工地負責人'); set(daily, 501, 9, 1); set(daily, 501, 10, 1);
  set(daily, 504, 0, 505); set(daily, 504, 2, '大工'); set(daily, 504, 10, 2);
  set(daily, 511, 0, 512); set(daily, 511, 2, '挖土機'); set(daily, 511, 10, 1);

  const cum = mk();
  set(cum, 0, 8, '日期'); set(cum, 0, 9, 46036); set(cum, 0, 10, 46037);
  set(cum, 2, 8, '累計金額 (未稅)'); set(cum, 2, 9, 92497); set(cum, 2, 10, 603087);
  set(cum, 3, 8, '累計進度'); set(cum, 3, 9, 0.0105); set(cum, 3, 10, 0.0683);
  set(cum, 4, 8, '預訂進度'); set(cum, 4, 9, 0.0059); set(cum, 4, 10, 0.0079);
  set(cum, 5, 2, '直接工程');
  set(cum, 6, 2, '工程告示牌與職安告示牌(租用）'); set(cum, 6, 9, 1); set(cum, 6, 10, 1);
  set(cum, 7, 2, '甲種施工安全圍籬含大門(租用）'); set(cum, 7, 9, 100); set(cum, 7, 10, 210);

  const one = mk();
  set(one, 2, 1, '工程名稱'); set(one, 2, 2, '測試工程');
  set(one, 2, 6, '承攬廠商'); set(one, 2, 7, META_VENDOR_KEY);

  const spec = alignSheets(daily, cum);
  if (spec.dateCols.length !== 2 || spec.items.length !== 3) return false;
  const src = {
    daily, cum, spec,
    crew: seqRows(daily, CREW_SEQ), tools: seqRows(daily, TOOL_SEQ),
    工程名稱: text(at(one, 2, 2)), 承包廠商: text(at(one, 2, 7)),
    開工序號: numOf(at(daily, ROW.日期, 2)),
  };
  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d1 = buildDay(src, spec.dateCols[0], serial);
  const d2 = buildDay(src, spec.dateCols[1], serial);

  if (d1.header.工程名稱 !== '測試工程') return false;
  if (d1.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d1.header.填報日期 !== '2026-01-14') return false;
  if (serial && d1.header.開工日期 !== '2026-01-14') return false;
  if (d1.header.天氣_上午 !== '晴' || d2.header.天氣_上午 !== '雨') return false;
  if (d1.header.本日累計金額 !== 92497 || d2.header.本日累計金額 !== 603087) return false;
  if (d1.header.預定進度 !== 0.0059 || d1.header.實際進度 !== 0.0105) return false;
  const [cat, a1, a2] = d1.dailyRows;
  if (cat.項次 !== '壹' || cat.單位 !== null) return false;
  if (a1.項次 !== '1' || a1.契約單價 !== 1836 || a1.本日完成數量 !== 1) return false;
  if (a2.項次 !== '2' || a2.單位 !== 'M' || a2.契約數量 !== 210) return false;
  // 本日取自 `key in`、累計取自 `累計` —— 兩張表錯開一欄的話這兩個值會相等
  if (a2.本日完成數量 !== 100 || a2.累計完成數量 !== 100) return false;
  const b2 = d2.dailyRows[2];
  if (b2.本日完成數量 !== 110 || b2.累計完成數量 !== 210) return false;
  if (a1.本日完成金額 !== null) return false;              // 逐項金額此格式不存在
  if (d1.header.出工總人數 !== 1) return false;
  if (d2.header.出工總人數 !== 3) return false;            // 工地負責人 1 + 大工 2
  if (d2.extras.主要機具[0].數量 !== 1) return false;

  // 對不齊一定要 throw,不可默默錯位
  const bad = cum.map((row) => (row ? row.slice() : row));
  bad[7][2] = '別的項目';
  let threw = false;
  try { alignSheets(daily, bad); } catch { threw = true; }
  if (!threw) return false;
  return true;
}

module.exports = {
  meta: {
    vendorKey: META_VENDOR_KEY,
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '天氣_上午', '天氣_下午', '預定進度', '實際進度',
      '出工總人數', '本日累計金額', '承包廠商', '開工日期',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  selfTest,
  _internal: { alignSheets, seqRows, buildDay, isUnfilled },
};
