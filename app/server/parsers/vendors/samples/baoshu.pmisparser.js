/**
 * baoshu.pmisparser.js — 寶樹體育設備工程施工日誌讀取器(豐榮國小人工草皮)
 *
 * vendorKey 取自**決標公告的得標廠商**(豐榮案:寶樹體育設備工程有限公司),
 * 日誌 a+2 欄 40 的「承攬廠商名稱」也載明同一個名稱,兩邊一致。
 *
 * ── 只做 xls 路徑,這是刻意的取捨 ──
 * 這案 11 份日誌是 xls 2 + PDF 9,而**兩者是同一份資料的不同輸出**:
 * 最新的 `1140725.xls` 已涵蓋 115 天(04-01~07-24,工期是 04-01~07-29,
 * 少的 5 天是交檔當下還沒到),PDF 只是按月拆開的列印版。
 * PDF **有文字層**(不是掃描件),但版面是逐字散開的座標式
 * (「承 攬 廠 商 名 稱」一個字一個 item),要另寫一套座標邏輯而幾乎讀不到新資料。
 * 需要時再補;現在把它當「讀不動的檔」明確 throw,不靜默回空。
 *
 * ── 版面事實(實測)──
 * .xls 單一分頁(名稱含日期區間,如 `1140401~1140729施工日誌`,**不可寫死**),
 * 一天一區塊垂直堆疊(實測間距 39,以欄 0 的「表報編號：」偵測起點)。
 * 欄位橫向大量合併(一個欄位跨 10~20 欄),合併填充後取起點欄即可。
 *
 * 相對錨點列 a:
 *   a+1  欄7=「上午：X 下午：Y」(標籤與值黏在同一格)  欄43=填報日期(Excel 序號)
 *   a+2  欄8=工程名稱  欄40=承攬廠商名稱
 *   a+4  欄15=開工日期(字串「114 年 04 月 01 日」,不是序號)
 *   a+5  欄15=預定進度  欄45=實際進度
 *   a+7  明細表頭:欄0=施工項目 欄15=單位 欄19=契約數量 欄27=本日完成數量
 *                  欄37=累計完成數量 欄47=備註
 *   a+8 起明細,到欄 0 的「二、工地材料管理概況」為止
 *
 * ── 欄 60~64 的計算區不能讀 ──
 * 表格右外側有一區 `項目名 | 契約數量 | 契約總價 | 完成總價 | 累計總價`,
 * 看起來剛好補上此格式缺的金額。**但它與左邊的明細錯開一列**:
 * 表頭列(a+7)的欄 60 已經是第 2 個項目、a+8 的欄 60 是第 3 個。
 * 照列對應會把每一項的金額都貼到別的項目上——而每一格都還是「有值」,
 * 完整性關卡看不見。而且欄 62 是**契約複價**不是單價,拿它除以數量反推單價
 * 會讓 E6/E7 變成自我循環。故此格式的單價與金額一律 null。
 */

const META_VENDOR_KEY = '寶樹體育設備工程有限公司';

const ANCHOR = '表報編號：';
const END_MARK_RE = /^二、/;

const OFF = { 天氣: 1, 名稱: 2, 開工: 4, 進度: 5, 表頭: 7 };
const COL = {
  工程項目: 0, 單位: 15, 契約數量: 19, 本日完成數量: 27, 累計完成數量: 37,
  天氣: 7, 填報日期: 43, 工程名稱: 8, 承包廠商: 40, 開工: 15,
  預定進度: 15, 實際進度: 45,
};
// 出工/機具(表頭列欄 0 去空白後等於「工別」)
const CREW = { 工別: 0, 本日人數: 10, 機具: 30, 本日使用: 40 };

const KNOWN_UNITS = new Set(['式', 'M', 'M2', 'M3', 'm', 'm2', 'm3', 'CM', 'MM', 'KG', 'kg',
  '噸', 'T', '面', '座', '組', '場', '棵', '株', '處', '個', '支', '片', '只', '間',
  '天', '日', '趟', '才', '公尺', '公斤', '台', '套', '包', '車', '批']);

const despace = (v) => String(v == null ? '' : v).replace(/[\s　]/g, '');

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' || s === '-' || s === '－' ? null : s;
};

function numOf(v) {
  const s = v == null ? '' : String(v).replace(/[,\s　%]/g, '');
  if (s === '' || s === '-' || s === '－') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const at = (grid, r, c) => (grid && grid[r] ? grid[r][c] : undefined);

/** 單位走白名單 + NFKC(此格式用全形 ㎡,不折成 m2 對不上 SP3 的單位字典)。 */
function unitOf(v) {
  const s = text(v);
  if (s == null) return null;
  const n = String(s).normalize('NFKC').trim();
  return KNOWN_UNITS.has(n) ? n : null;
}

/** 「上午：晴 下午：陰」→ ['晴','陰']。標籤與值黏在同一格。 */
function weatherOf(v) {
  const s = despace(v);
  const m = /上午[:：](.{1,3}?)下午[:：](.{1,3})$/.exec(s);
  return m ? [text(m[1]), text(m[2])] : [null, null];
}

/** 「114 年 04 月 01 日」→ 'YYYY-MM-DD'(民國/西元雙制)。 */
function rocTextToISO(v) {
  const s = despace(v);
  const m = /(\d{2,4})年(\d{1,2})月(\d{1,2})日/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1911) y += 1911;
  const p = (n) => String(Number(n)).padStart(2, '0');
  return `${y}-${p(m[2])}-${p(m[3])}`;
}

/**
 * 解析一天區塊(純函式;selfTest 重用之)。
 * @param {Array<Array>} grid
 * @param {number} a 錨點列
 * @param {number} end 下一個錨點列(或 grid 尾)
 * @param {(serial:number)=>string|null} [serialToISO]
 */
function parseBlock(grid, a, end, serialToISO) {
  const dailyRows = [];
  let seq = 0;
  for (let r = a + OFF.表頭 + 1; r < end; r++) {
    const 工程項目 = text(at(grid, r, COL.工程項目));
    if (工程項目 == null || END_MARK_RE.test(工程項目)) break;
    const 單位 = unitOf(at(grid, r, COL.單位));
    const 契約數量 = numOf(at(grid, r, COL.契約數量));
    const isCategory = 單位 == null && 契約數量 == null;
    if (!isCategory) seq++;
    dailyRows.push({
      // 此格式沒有項次欄;以「排除大類後的出現序」補(位置事實,不是推導數值)。
      項次: isCategory ? null : String(seq),
      工程項目,
      單位,
      契約單價: null,        // 見檔頭:欄 62 是契約複價且與明細錯開一列,不可用
      契約數量,
      本日完成數量: numOf(at(grid, r, COL.本日完成數量)),
      本日完成金額: null,
      累計完成數量: numOf(at(grid, r, COL.累計完成數量)),
    });
  }

  const extras = {};
  let 出工總人數 = null;
  let crewRow = -1;
  for (let r = a + OFF.表頭; r < end; r++) {
    if (despace(at(grid, r, 0)) === '工別') { crewRow = r; break; }
  }
  if (crewRow >= 0) {
    const 出工明細 = [];
    const 主要機具 = [];
    for (let r = crewRow + 1; r < end; r++) {
      const 工別 = text(at(grid, r, CREW.工別));
      if (工別 == null || /^[一二三四五六七八]、/.test(工別)) break;
      出工明細.push({ 工別, 人數: numOf(at(grid, r, CREW.本日人數)) });
      const 機具 = text(at(grid, r, CREW.機具));
      if (機具 != null) 主要機具.push({ 名稱: 機具, 數量: numOf(at(grid, r, CREW.本日使用)) });
    }
    if (出工明細.length) {
      extras.出工明細 = 出工明細;
      const n = 出工明細.filter((c) => c.人數 != null);
      if (n.length) 出工總人數 = n.reduce((s, c) => s + c.人數, 0);
    }
    if (主要機具.length) extras.主要機具 = 主要機具;
  }

  const [上午, 下午] = weatherOf(at(grid, a + OFF.天氣, COL.天氣));
  const serial = numOf(at(grid, a + OFF.天氣, COL.填報日期));
  return {
    header: {
      工程名稱: text(at(grid, a + OFF.名稱, COL.工程名稱)),
      填報日期: serial != null && serialToISO ? serialToISO(serial) : null,
      星期: null,                                       // 此格式不提供
      天氣_上午: 上午,
      天氣_下午: 下午,
      預定進度: numOf(at(grid, a + OFF.進度, COL.預定進度)),
      實際進度: numOf(at(grid, a + OFF.進度, COL.實際進度)),
      出工總人數,
      本日累計金額: null,                                // 此格式無可用的金額欄
      承包廠商: text(at(grid, a + OFF.名稱, COL.承包廠商)),
      開工日期: rocTextToISO(at(grid, a + OFF.開工, COL.開工)),
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

/**
 * 「還沒填的天」判定:整個工期的區塊一次建好,檔尾有一批只剩範本的空區塊。
 * **只憑「沒天氣」丟掉是危險的**——真的漏填天氣卻有施工的日子會消失,
 * 故要求整天也沒有任何本日完成量(空白**或 0**)。
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
  const out = [];
  let anchors = 0;
  for (const name of wb.sheetNames) {
    // 分頁名帶日期區間,每份檔都不一樣,故掃所有分頁找錨點而不是挑名字。
    const grid = wb.sheets[name];
    if (!grid || !grid.length) continue;
    const starts = blockStarts(grid);
    anchors += starts.length;
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1] : grid.length;
      const day = parseBlock(grid, starts[i], end, ft.excelSerialToISO);
      if (isUnfilled(day)) continue;
      out.push(day);
    }
  }
  if (!anchors) {
    // 回空陣列會被上游當成「這份沒有資料」而靜靜略過,那是最糟的失敗方式。
    throw new Error('找不到「表報編號」天區塊(此檔非寶樹格式,或是無文字層的掃描件)');
  }
  return out;
}

async function parse(filePath, ctx) {
  const days = await parseAll(filePath, ctx);
  return days[0] || null;
}

/** selfTest 用**真實座標**造一個最小區塊(取自豐榮第一天,只換工程名稱)。 */
function selfTest(ft) {
  const g = [];
  const set = (r, c, v) => { (g[r] = g[r] || [])[c] = v; };
  set(0, 0, '公共工程施工日誌');
  set(1, 0, ANCHOR); set(1, 7, 1);
  set(2, 0, '本日氣候：'); set(2, 7, '上午：晴 下午：陰');
  set(2, 36, '填報日期：'); set(2, 43, 45748);
  set(3, 0, '工程名稱'); set(3, 8, '測試工程'); set(3, 30, '承攬廠商名稱'); set(3, 40, META_VENDOR_KEY);
  set(5, 0, '開 工 日 期'); set(5, 15, '114 年 04 月 01 日');
  set(6, 0, '預定進度 ( % )'); set(6, 15, 0.037); set(6, 45, 0.012);
  set(8, 0, '施  工  項  目'); set(8, 15, '單位'); set(8, 19, '契約數量');
  set(8, 27, '本日完成數量'); set(8, 37, '累計完成數量');
  set(9, 0, '工程告示牌、施工圍籬與交通管制設施(租用)'); set(9, 15, '式'); set(9, 19, 1);
  set(9, 27, 1); set(9, 37, 1);
  // 全形 ㎡ 要經 NFKC 才對得上單位字典
  set(10, 0, '切割打除清運混凝土地坪(含溝壁)'); set(10, 15, '㎡'); set(10, 19, 239); set(10, 37, 0);
  // 表格右外側的計算區與左邊的明細**錯開一列**,不可照列對應
  set(8, 60, '施工動線開闢及損壞復原'); set(8, 61, 1); set(8, 62, 33000);
  set(9, 60, '拆除清運場地內既有車阻'); set(9, 61, 1); set(9, 62, 106498);
  set(11, 0, '二、工地材料管理概況（含約定之重要材料使用狀況及數量等）：');
  set(13, 0, '工 別'); set(13, 10, '本 日 人 數'); set(13, 20, '累 計 人 數');
  set(13, 30, '機 具 名 稱'); set(13, 40, '本日使用數量');
  set(14, 0, '大 工'); set(14, 10, 3); set(14, 20, 3); set(14, 30, '貨車'); set(14, 40, 1);
  set(15, 0, '小 工'); set(15, 20, 5); set(15, 30, '挖土機'); set(15, 40, 0);  // 只有累計 → 本日 null
  set(16, 0, '四、施工取樣試驗紀錄：');

  const serial = ft && typeof ft.excelSerialToISO === 'function' ? ft.excelSerialToISO : null;
  const d = parseBlock(g, 1, g.length, serial);
  if (d.header.工程名稱 !== '測試工程') return false;
  if (d.header.承包廠商 !== META_VENDOR_KEY) return false;
  if (serial && d.header.填報日期 !== '2025-04-01') return false;
  if (d.header.開工日期 !== '2025-04-01') return false;       // 字串日期不是序號
  if (d.header.天氣_上午 !== '晴' || d.header.天氣_下午 !== '陰') return false;
  if (d.header.預定進度 !== 0.037 || d.header.實際進度 !== 0.012) return false;
  if (d.dailyRows.length !== 2) return false;
  const [r1, r2] = d.dailyRows;
  if (r1.項次 !== '1' || r1.單位 !== '式' || r1.契約數量 !== 1) return false;
  if (r1.本日完成數量 !== 1 || r1.累計完成數量 !== 1) return false;
  if (r2.項次 !== '2' || r2.單位 !== 'm2' || r2.契約數量 !== 239) return false;
  if (r2.本日完成數量 !== null) return false;
  // 右外側計算區錯開一列,不可拿來當單價/金額
  if (r1.契約單價 !== null || r1.本日完成金額 !== null) return false;
  if (d.header.出工總人數 !== 3) return false;                 // 小工只有累計欄,不計
  if (d.extras.出工明細.find((c) => c.工別 === '小 工').人數 !== null) return false;
  if (isUnfilled(d)) return false;
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
  _internal: { parseBlock, blockStarts, weatherOf, rocTextToISO, unitOf },
};
